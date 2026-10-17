import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {findRenameConflicts} from '../commands/file/rename.js'

const item = (dir, oldName, newName) => ({
  dir,
  newName,
  newPath: path.join(dir, newName),
  oldName,
  oldPath: path.join(dir, oldName),
})

test('findRenameConflicts flags existing targets and duplicate new names, not case-only renames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-rename-'))

  try {
    for (const name of ['my__lora.safetensors', 'my_lora.safetensors', 'a__b.png', 'a_b_.png', 'a_b.png', 'shot.PNG']) {
      fs.writeFileSync(path.join(dir, name), '')
    }

    const free = item(dir, 'a__b.png', 'a_b2.png')
    const taken = item(dir, 'my__lora.safetensors', 'my_lora.safetensors')
    const first = item(dir, 'a_b_.png', 'x.png')
    const second = item(dir, 'a_b.png', 'X.png')
    const caseOnly = item(dir, 'shot.PNG', 'shot.png')

    const conflicts = findRenameConflicts([free, taken, first, second, caseOnly])

    assert.deepEqual([...conflicts.keys()], [taken, second])
    assert.match(conflicts.get(taken), /already exists/)
    assert.match(conflicts.get(second), /same name/)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
