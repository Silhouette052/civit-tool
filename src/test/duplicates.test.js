import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {findDuplicates, formatBytes, scanSafetensors} from '../commands/lora/duplicates.js'

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
    const {groups, hashed} = await findDuplicates(scanSafetensors(dir).files, (file) =>
      hashedNames.push(path.basename(file.path)),
    )

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
