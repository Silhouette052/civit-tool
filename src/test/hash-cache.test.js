// The hash cache of lora duplicates / activation / url: a file whose size and modify time are unchanged isn't read
// again.

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {findDuplicates, scanSafetensors} from '../commands/lora/duplicates.js'
import {openHashCache} from '../lib/hashCache.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
// a fixed modify time, so a rewritten file can get exactly the same one back
const MTIME = new Date('2026-01-01T00:00:00Z')

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-hash-'))
  // the real path, as the cache keys are (macOS's /tmp is a link)
  return fs.realpathSync.native(dir)
}

function write(dir, rel, content) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, content)
  fs.utimesSync(file, MTIME, MTIME)
  return file
}

test('a cached hash is used while size and modify time are unchanged, and kept on disk', async () => {
  const dir = tempDir()
  try {
    const cacheFile = path.join(dir, 'cache', 'hashes.json')
    const lora = write(dir, 'a.safetensors', 'first')

    const cache = openHashCache(cacheFile)
    assert.equal(cache.lookup(lora), null)
    assert.equal(await cache.sha256(lora), sha('first'))
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), {
      [lora]: {size: 5, mtimeMs: MTIME.getTime(), sha256: sha('first')},
    })

    // new bytes, same size and modify time: a new run still trusts the cache, so the file was not read
    write(dir, 'a.safetensors', 'other')
    assert.equal(await openHashCache(cacheFile).sha256(lora), sha('first'))

    // a new modify time: hashed again
    fs.utimesSync(lora, MTIME, new Date('2026-02-01T00:00:00Z'))
    assert.equal(openHashCache(cacheFile).lookup(lora), null)
    assert.equal(await openHashCache(cacheFile).sha256(lora), sha('other'))

    // a new size: hashed again
    write(dir, 'a.safetensors', 'longer')
    assert.equal(openHashCache(cacheFile).lookup(lora), null)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('a link reaches the same entry; an unreadable cache or a failed save is warned about, not fatal', async (t) => {
  const dir = tempDir()
  try {
    const cacheFile = path.join(dir, 'hashes.json')
    const lora = write(dir, 'a.safetensors', 'first')

    fs.writeFileSync(cacheFile, '{"broken": ')
    const warnings = []
    const cache = openHashCache(cacheFile, (msg) => warnings.push(msg))
    assert.match(warnings[0], /Cannot read the hash cache .*starting a new one/)
    await cache.sha256(lora)
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))), [lora])

    // the cache's folder is a file: it can't be read, the save fails (warned once) and hashing still works
    const blocked = []
    const unsaved = openHashCache(path.join(lora, 'hashes.json'), (msg) => blocked.push(msg))
    assert.equal(await unsaved.sha256(lora), sha('first'))
    assert.equal(await unsaved.hash(lora), sha('first'))
    assert.equal(blocked.length, 2)
    assert.match(blocked[0], /Cannot read the hash cache/)
    assert.match(blocked[1], /Cannot save the hash cache/)

    try {
      fs.symlinkSync(lora, path.join(dir, 'link.safetensors'))
    } catch {
      t.skip('this system does not allow creating symlinks')
      return
    }

    assert.equal(openHashCache(cacheFile).lookup(path.join(dir, 'link.safetensors')), sha('first'))
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('prune removes entries of missing files inside the scanned folders only', async () => {
  const dir = tempDir()
  try {
    const cacheFile = path.join(dir, 'hashes.json')
    const models = path.join(dir, 'models')
    const keep = write(dir, 'models/keep.safetensors', 'k')
    const gone = write(dir, 'models/gone.safetensors', 'g')
    const goneFolder = write(dir, 'models/old/x.safetensors', 'x')
    const outside = write(dir, 'elsewhere/y.safetensors', 'y')

    const cache = openHashCache(cacheFile)
    for (const file of [keep, gone, goneFolder, outside]) await cache.hash(file)
    fs.rmSync(gone)
    fs.rmSync(path.join(models, 'old'), {recursive: true})

    const {files, folders} = scanSafetensors(models)
    assert.deepEqual(folders, [models])
    assert.equal(
      cache.prune(
        folders,
        files.map((f) => f.path),
      ),
      2,
    )
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).sort(), [outside, keep].sort())
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('findDuplicates takes unchanged files from the cache; rehash reads them all again', async () => {
  const dir = tempDir()
  try {
    const cacheFile = path.join(dir, 'hashes.json')
    write(dir, 'Lora/style.safetensors', 'same content')
    write(dir, 'Lora/old/style_copy.safetensors', 'same content')
    write(dir, 'Lora/other.safetensors', 'diff content')
    write(dir, 'Lora/big.safetensors', 'a longer file')
    const {files} = scanSafetensors(path.join(dir, 'Lora'))

    const first = await findDuplicates(files, {cache: openHashCache(cacheFile)})
    assert.deepEqual([first.hashed, first.fromCache, first.bytesHashed, first.groups.length], [3, 0, 36, 1])

    const seen = []
    const second = await findDuplicates(files, {
      cache: openHashCache(cacheFile),
      onHash: (file, n, total, cached) => seen.push(cached),
    })
    assert.deepEqual([second.hashed, second.fromCache, second.bytesHashed, second.groups.length], [0, 3, 0, 1])
    assert.deepEqual(seen, [true, true, true])

    const again = await findDuplicates(files, {cache: openHashCache(cacheFile), rehash: true})
    assert.deepEqual([again.hashed, again.fromCache], [3, 0])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

// each CLI start is slow on some disks, so this keeps to three runs
test('lora duplicates: the second run uses the cache; --rehash does not, and a missing file leaves the cache', () => {
  const dir = tempDir()
  try {
    const cacheFile = path.join(dir, 'hashes.json')
    const models = path.join(dir, 'models')
    for (const name of ['a', 'b', 'c']) write(dir, `models/${name}.safetensors`, 'same content')
    write(dir, 'models/u.safetensors', 'unique size!!')
    const run = (...args) =>
      spawnSync(process.execPath, [BIN, 'lora', 'duplicates', models, '--list', ...args], {
        encoding: 'utf8',
        env: {...process.env, CIVIT_TOOL_HASH_CACHE: cacheFile, FORCE_COLOR: '0'},
      })
    // the summary's `  Label: value` lines
    const summary = (result) => {
      assert.equal(result.status, 0, result.stderr)
      const rows = Object.fromEntries([...result.stdout.matchAll(/^ {2}([^:]+): +(.*)$/gm)].map((m) => [m[1], m[2]]))
      return [rows.Hashed, rows['From the hash cache'], rows['Not hashed'], rows['Hash cache']]
    }

    const first = run()
    assert.match(first.stdout, /\[1\/3] hashing a\.safetensors \(12 B\)\n/)
    assert.deepEqual(summary(first), ['3, 36 B', '0', '1 (a size no other file has)', cacheFile])

    const second = run()
    assert.match(second.stdout, /\[1\/3] cached {2}a\.safetensors\n/)
    assert.match(second.stdout, /3 copies, 12 B each/)
    assert.deepEqual(summary(second), ['0, 0 B', '3', '1 (a size no other file has)', cacheFile])

    fs.rmSync(path.join(models, 'c.safetensors'))
    assert.deepEqual(summary(run('--rehash')), [
      '2, 24 B',
      '0',
      '1 (a size no other file has)',
      `${cacheFile} (1 missing file(s) removed from it)`,
    ])
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).sort(), [
      path.join(models, 'a.safetensors'),
      path.join(models, 'b.safetensors'),
    ])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
