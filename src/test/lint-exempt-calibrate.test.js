// Exempt keys (lint.exemptKeys: the entries under them aren't linted) and the pieces of wc lint --calibrate: the
// unknown tags with their LoRAs, the printed list, and the picker.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {formatUnknownTags, loraTagIndex, placesOf, unknownTags} from '../lib/lint/calibrate.js'
import {formatJson, formatText, makeLintConfig} from '../lib/lint/index.js'
import {runPicker} from '../lib/terminalMenu.js'
import {fakeTerminal, KEYS} from './fake-terminal.js'
import {lintYaml} from './lint-helpers.js'

// shaped like the user's library: a list of favourite LoRAs inside a branch, next to ordinary entries
const LIBRARY = [
  'contender2:',
  '  ill:',
  '    outfits:',
  '      - long_hair, lnog_hair',
  '    combo:',
  '      - __contender2/ill/contender2_favs__, long_hair',
  '    contender2_favs:',
  '      - <lora:9_Liibrra:0.75>, liibrra,',
  '      - <lora:NM_MeowTastic_ill:1>',
  '      - <lora:cute_anime ILL_V2:0.7> ff-ca,',
  '    my_favs:',
  '      new:',
  '        - mystery_tag',
  'contender2_favs:',
  '  - other_tag, other_tag',
  '',
].join('\n')

const keyPaths = (result) => [...new Set(result.findings.map((f) => f.keyPath))].sort()

test('exempt keys: the entries under a key with that name, at any level and below it, are not linted', () => {
  assert.deepEqual(keyPaths(lintYaml(LIBRARY)), [
    'contender2/ill/contender2_favs',
    'contender2/ill/my_favs/new',
    'contender2/ill/outfits',
    'contender2_favs',
  ])

  const one = lintYaml(LIBRARY, {exemptKeys: ['contender2_favs']})
  assert.deepEqual(keyPaths(one), ['contender2/ill/my_favs/new', 'contender2/ill/outfits'])
  assert.deepEqual(one.exempt, {entries: 4, keys: ['contender2_favs']})

  // * matches within a name; a reference into an exempt key still resolves (no S-ref)
  const all = lintYaml(LIBRARY, {exemptKeys: ['contender2_favs', '*_favs']})
  assert.deepEqual(keyPaths(all), ['contender2/ill/outfits'])
  assert.equal(all.exempt.entries, 5)
  assert.match(formatText(all), /\nexempt keys: contender2_favs, \*_favs \(5 entries not checked\)$/)
  assert.doesNotMatch(formatText(lintYaml(LIBRARY)), /exempt keys/)
})

test('makeLintConfig accepts exemptKeys only as a list of key names', () => {
  assert.deepEqual(makeLintConfig({exemptKeys: ['*_favs']}).exemptKeys, ['*_favs'])
  assert.deepEqual(makeLintConfig({}).exemptKeys, [])
  assert.throws(() => makeLintConfig({exemptKeys: 'favs'}, 'my.json'), /my\.json: lint\.exemptKeys must be a list/)
  assert.throws(() => makeLintConfig({exemptKeys: ['ok', '']}, 'my.json'), /must be a list of key names/)
  assert.throws(
    () => makeLintConfig({exemptKeys: ['lib/favs']}, 'my.json'),
    /"lib\/favs" is a path; use the key's name/,
  )
})

test("an unknown tag's finding carries the tag as written, which the JSON output leaves out", () => {
  const result = lintYaml('lib:\n  ill:\n    - (lnog_hair), Liibrra\n')
  assert.deepEqual(
    result.findings.map((f) => [f.rule, f.tag]),
    [
      ['R1', 'lnog_hair'],
      ['R1', 'Liibrra'],
    ],
  )
  assert.doesNotMatch(formatJson(result), /"tag"/)
})

test('unknownTags: one row per tag with its count, places and LoRAs; LoRA tags first, then the most used', () => {
  const result = lintYaml([
    'lib:\n  ill:\n    - liibrra, lnog_hair\n    - Liibrra, zzz_tag\n',
    'more:\n  ill:\n    - lnog_hair\n    - lnog_hair, ff-ca\n',
  ])
  const loras = new Map([
    ['liibrra', ['9_Liibrra']],
    ['ff-ca', ['cute_anime ILL_V2']],
  ])
  const rows = unknownTags(result.findings, loras)
  assert.deepEqual(
    rows.map((row) => [row.tag, row.count, row.loras]),
    [
      ['liibrra', 2, ['9_Liibrra']],
      ['ff-ca', 1, ['cute_anime ILL_V2']],
      ['lnog_hair', 3, []],
      ['zzz_tag', 1, []],
    ],
  )
  assert.deepEqual(rows[2].places, ['test-0.yaml:3', 'test-1.yaml:3', 'test-1.yaml:4'])
  assert.equal(placesOf({places: ['a:1', 'b:2', 'c:3', 'd:4', 'e:5']}), 'a:1, b:2, c:3, +2 more')

  const printed = formatUnknownTags(rows)
  assert.match(printed, /^4 unknown tags \(R1\); \[x\] = a LoRA's activation tag:\n/)
  assert.match(printed, /\n\[x\] liibrra +2×  test-0\.yaml:3  LoRA: 9_Liibrra\n/)
  assert.match(printed, /\n\[ \] lnog_hair +3×  test-0\.yaml:3\n/)
  assert.match(printed, /\nAccept the LoRA tags with: civit-tool wc config --accept "liibrra,ff-ca"\n/)
})

test("loraTagIndex: each tag of the sidecars' activation text, with the LoRAs that have it", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civit-calibrate-')))
  try {
    fs.mkdirSync(path.join(dir, 'sub'))
    const write = (name, activation) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify({'activation text': activation}))
    write('9_Liibrra.json', 'Liibrra, {2::pualdrons|gauntlets}, __own/clothes__')
    write(path.join('sub', 'cute_anime ILL_V2.json'), 'ff-ca, liibrra')

    assert.deepEqual([...loraTagIndex([dir])], [['liibrra', ['9_Liibrra']]])
    assert.deepEqual(
      [...loraTagIndex([dir], {recursive: true})],
      [
        ['liibrra', ['9_Liibrra', 'cute_anime ILL_V2']],
        ['ff-ca', ['cute_anime ILL_V2']],
      ],
    )
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('runPicker: Space picks a row, a picks all or none, Enter accepts, q cancels', async () => {
  const items = [{help: 'Used in a.yaml:1', selected: true, text: 'liibrra'}, {text: 'lnog_hair'}, {text: 'zzz_tag'}]
  const term = fakeTerminal({columns: 120})
  const last = () => term.frames().at(-1)
  const picked = runPicker(items, {heading: 'Pick tags', input: term.input, output: term.output})

  assert.match(last(), /Pick tags\n {2}\n› \[x\] liibrra\n {2}\[ \] lnog_hair\n {2}\[ \] zzz_tag\n/)
  assert.match(last(), /\nUsed in a\.yaml:1\n↑\/↓ move {3}Space select {3}a all\/none {3}Enter accept 1 {3}q cancel\n$/)
  await term.press(KEYS.down, ' ')
  assert.match(last(), /\n› \[x\] lnog_hair\n.*Enter accept 2 /s)
  await term.press('a')
  assert.match(last(), /\[x\] zzz_tag\n.*Enter accept 3 /s)
  await term.press('a', KEYS.end, ' ', KEYS.enter)
  assert.deepEqual(await picked, [2])

  const other = fakeTerminal()
  const cancelled = runPicker(items, {input: other.input, output: other.output})
  await other.press(' ', 'q')
  assert.equal(await cancelled, null)
})
