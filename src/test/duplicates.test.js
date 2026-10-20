import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {PassThrough} from 'node:stream'
import {setImmediate as tick} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'

import {
  copiesWithFiles,
  filesToDelete,
  findDuplicates,
  formatBytes,
  lineReader,
  parseKeepAnswer,
  scanSafetensors,
} from '../commands/lora/duplicates.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')

/** A temp models folder: two real copies, a same-size impostor, a different file, links. */
function makeModels() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-dup-'))
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
    fs.writeFileSync(path.join(dir, rel), content)
  }

  write('Lora/style.safetensors', 'same content')
  write('Lora/old/style_copy.SAFETENSORS', 'same content')
  write('Lora/other.safetensors', 'diff content') // same size, different bytes
  write('Lora/big.safetensors', 'a longer file')
  write('Lora/notes.txt', 'same content') // not a .safetensors
  return dir
}

test('scanSafetensors finds .safetensors in subfolders, case-insensitively', () => {
  const dir = makeModels()
  try {
    const {files} = scanSafetensors(dir)
    assert.deepEqual(
      files.map((f) => path.relative(dir, f.path)),
      [
        path.join('Lora', 'big.safetensors'),
        path.join('Lora', 'old', 'style_copy.SAFETENSORS'),
        path.join('Lora', 'other.safetensors'),
        path.join('Lora', 'style.safetensors'),
      ],
    )
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('links are followed once: no loop, and a link to a file is not a copy of it', (t) => {
  const dir = makeModels()
  try {
    try {
      fs.symlinkSync(dir, path.join(dir, 'Lora', 'loop'), 'dir') // points back up the tree
      fs.symlinkSync(path.join(dir, 'Lora', 'big.safetensors'), path.join(dir, 'Lora', 'zz-link.safetensors'))
    } catch {
      t.skip('this system does not allow creating symlinks')
      return
    }

    const warnings = []
    const {files} = scanSafetensors(dir, (msg) => warnings.push(msg))
    assert.equal(files.length, 4, 'the loop adds nothing and the file link is the same file as big.safetensors')
    assert.deepEqual(warnings, [])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('a broken link is warned about and skipped', (t) => {
  const dir = makeModels()
  try {
    try {
      fs.symlinkSync(path.join(dir, 'missing.safetensors'), path.join(dir, 'broken.safetensors'))
    } catch {
      t.skip('this system does not allow creating symlinks')
      return
    }

    const warnings = []
    assert.equal(scanSafetensors(dir, (msg) => warnings.push(msg)).files.length, 4)
    assert.match(warnings[0], /broken\.safetensors/)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('findDuplicates hashes only same-size files and groups identical content', async () => {
  const dir = makeModels()
  try {
    const hashedNames = []
    const {groups, hashed} = await findDuplicates(scanSafetensors(dir).files, {
      onHash: (file) => hashedNames.push(path.basename(file.path)),
    })

    assert.equal(hashed, 3, 'big.safetensors has a unique size, so it is never read')
    assert.ok(!hashedNames.includes('big.safetensors'))
    assert.equal(groups.length, 1)
    assert.deepEqual(
      groups[0].files.map((f) => path.basename(f.path)),
      ['style_copy.SAFETENSORS', 'style.safetensors'],
    )
    assert.equal(groups[0].size, 12)
    assert.match(groups[0].hash, /^[0-9a-f]{64}$/)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(228 * 1024 * 1024), '228.00 MB')
  assert.equal(formatBytes(6.5 * 1024 ** 3), '6.50 GB')
})

/** Writes files (relative path → content) into a new temp folder; returns its real path. */
function makeFolder(files) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civit-dup-')))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
    fs.writeFileSync(path.join(dir, rel), content)
  }

  return dir
}

test("copiesWithFiles: +c / +p and the files named after each copy, not a longer name's", () => {
  const dir = makeFolder({
    'Edo.safetensors': 'X',
    'Edo.json': '{}',
    'Edo.preview.png': '',
    'Edo.civitai.info': '',
    'Edo.v2.safetensors': 'other', // a different LoRA: Edo.v2.json is its file, not Edo's
    'Edo.v2.json': '{}',
    'old/edo_copy.safetensors': 'X',
    'old/edo_copy.webp': '',
    'new/Edo.safetensors': 'X',
  })
  try {
    const at = (rel) => path.join(dir, rel)
    const copies = copiesWithFiles([at('Edo.safetensors'), at('old/edo_copy.safetensors'), at('new/Edo.safetensors')])
    assert.deepEqual(
      copies.map(({config, preview}) => [config, preview]),
      [
        [true, true],
        [false, true],
        [false, false],
      ],
    )
    assert.deepEqual(
      copies[0].files.map((file) => path.relative(dir, file)),
      ['Edo.safetensors', 'Edo.civitai.info', 'Edo.json', 'Edo.preview.png'],
    )

    assert.deepEqual(
      filesToDelete(copies, 1).map((file) => path.relative(dir, file)),
      ['Edo.safetensors', 'Edo.civitai.info', 'Edo.json', 'Edo.preview.png', path.join('new', 'Edo.safetensors')],
    )
    assert.deepEqual(
      filesToDelete(copies, 0).map((file) => path.relative(dir, file)),
      [
        path.join('old', 'edo_copy.safetensors'),
        path.join('old', 'edo_copy.webp'),
        path.join('new', 'Edo.safetensors'),
      ],
    )
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('copiesWithFiles stays fast in a folder with thousands of LoRAs', () => {
  const files = {}
  for (let i = 0; i < 2500; i++) {
    files[`style${i}.safetensors`] = ''
    files[`style${i}.json`] = ''
    files[`style${i}.preview.png`] = ''
  }

  const dir = makeFolder(files)
  try {
    const started = Date.now()
    const listings = new Map()
    for (const i of [1, 2, 3]) copiesWithFiles([path.join(dir, `style${i}.safetensors`)], listings)
    // the folder is read once; checking every name against every LoRA took minutes per copy
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`)
    assert.deepEqual(
      copiesWithFiles([path.join(dir, 'style1.safetensors')], listings)[0].files.map((file) => path.basename(file)),
      ['style1.safetensors', 'style1.json', 'style1.preview.png'], // not style10.json and the like
    )
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('filesToDelete: two copies with the same name in one folder delete only the other copy', (t) => {
  const dir = makeFolder({'x.safetensors': 'X', 'x.SAFETENSORS': 'X', 'x.json': '{}'})
  try {
    if (fs.readdirSync(dir).length < 3) {
      t.skip('this file system ignores case in names')
      return
    }

    const copies = copiesWithFiles([path.join(dir, 'x.safetensors'), path.join(dir, 'x.SAFETENSORS')])
    assert.deepEqual(filesToDelete(copies, 0), [path.join(dir, 'x.SAFETENSORS')])
    assert.deepEqual(filesToDelete(copies, 1), [path.join(dir, 'x.safetensors')])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('parseKeepAnswer: a copy number, Enter skips, q stops, anything else asks again', () => {
  assert.equal(parseKeepAnswer('2', 3), 1)
  assert.equal(parseKeepAnswer(' 3 ', 3), 2)
  assert.equal(parseKeepAnswer('', 3), 'skip')
  assert.equal(parseKeepAnswer('  ', 3), 'skip')
  assert.equal(parseKeepAnswer('Q', 3), 'stop')
  for (const answer of ['0', '4', 'x', '2x', '-1', '1.5']) assert.equal(parseKeepAnswer(answer, 3), null, answer)
})

test('lineReader: piped lines are queued and echoed; once input ends, nothing more is asked', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk) => (shown += chunk))
  const reader = lineReader(input, output)

  input.end('2\n\n') // both answers arrive before the first question, then the input ends
  await tick()
  assert.equal(await reader.ask('first? '), '2')
  assert.equal(await reader.ask('second? '), '')
  assert.equal(await reader.ask('third? '), null)
  reader.close() // already closed: must not throw
  await tick()
  assert.equal(shown, 'first? 2\nsecond? \n')
})

test('lineReader in a terminal: a line typed before its question is dropped; Ctrl+C / close answers null', async () => {
  const input = new PassThrough()
  input.isTTY = true
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk) => (shown += chunk))
  const reader = lineReader(input, output)

  input.write('2\n') // typed while the next group was being prepared
  await tick()
  const answer = reader.ask('Keep which one? ')
  input.write('1\n')
  assert.equal(await answer, '1')

  input.end() // closed while no question is open, like Ctrl+C during the wait
  await tick()
  assert.equal(await reader.ask('again? '), null)
  assert.doesNotMatch(shown, /again\?/) // the closed interface was not used
})

// each CLI start is slow on some disks, so this keeps to two runs
test('lora duplicates asks per group: keep one deletes the others with their files; Enter skips; end of input stops', () => {
  const alphaJson = JSON.stringify({'civitai model name': 'Alpha Style'})
  const dir = makeFolder({
    'models/alpha.safetensors': 'AAAA1',
    'models/alpha.json': alphaJson,
    'models/alpha.png': '',
    'models/loras.yaml': '',
    'models/sub/alpha-copy.safetensors': 'AAAA1',
    'models/sub/alpha-copy.preview.png': '',
    'models/beta.safetensors': 'BBBBBB2',
    'models/sub/beta-copy.safetensors': 'BBBBBB2',
    'models/gamma.safetensors': 'GGGGGGGGG3',
    'models/sub/gamma-copy.safetensors': 'GGGGGGGGG3',
  })
  const models = path.join(dir, 'models')
  const left = () => fs.readdirSync(models, {recursive: true}).sort()
  const run = (input, ...args) =>
    spawnSync(process.execPath, [BIN, 'lora', 'duplicates', models, ...args], {
      encoding: 'utf8',
      env: {...process.env, CIVIT_TOOL_HASH_CACHE: path.join(dir, 'hashes.json'), FORCE_COLOR: '0'},
      input,
    })
  try {
    const before = left()
    const listed = run('1\n', '--list')
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /Duplicate groups: +3/)
    assert.doesNotMatch(listed.stdout, /Keep which one/)
    assert.deepEqual(left(), before)

    // group 1: an invalid answer, then keep the second copy; group 2: Enter; group 3: input ends
    const asked = run('x\n2\n\n')
    assert.equal(asked.status, 0, asked.stderr)
    const out = asked.stdout
    assert.match(out, /\+c: a \.json config with the same name is next to it {3}\+p: a preview image/)
    assert.match(out, /Duplicate 1 of 3: alpha\.safetensors {2}\(Civitai: Alpha Style\), 5 B each\n/)
    assert.ok(out.includes(`  1) ${path.join(models, 'alpha.safetensors')}  (+c +p)\n`))
    assert.ok(out.includes(`  2) ${path.join(models, 'sub', 'alpha-copy.safetensors')}  (+p)\n`))
    assert.match(
      out,
      /Keep which one\? \[1-2, Enter = skip, q = stop] x\n {2}Type a number from 1 to 2, Enter to skip or q to stop\./,
    )
    assert.ok(out.includes(`  deleted ${path.join(models, 'alpha.json')}\n`))
    assert.match(out, /Duplicate 2 of 3: beta\.safetensors, 7 B each\n[^]*\n {2}skipped\n/)
    assert.match(out, /Duplicate 3 of 3: gamma[^]*Stopped; 1 group\(s\) left as they are\./)
    // the LoRA and its .json and preview
    assert.ok(out.includes(`Deleted 3 file(s), ${5 + Buffer.byteLength(alphaJson)} B freed.`))
    assert.ok(out.includes(`run lora activation there again:\n  ${models}\n`))

    assert.deepEqual(
      left(),
      before.filter((name) => !['alpha.safetensors', 'alpha.json', 'alpha.png'].includes(name)),
    )
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
