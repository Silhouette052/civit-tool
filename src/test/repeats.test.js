// wc repeats: repeated word runs (prose) and tag runs, in order and as tag sets.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {findRepeats, formatRepeats, tokenizeEntry} from '../lib/repeats.js'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')

const parse = (yaml) => parseWildcardFile(yaml, {path: 'test.yaml'})
const brief = (repeats) => repeats.map((r) => [r.length, r.unit, r.occurrences.length, r.text])

const PROSE = [
  'lib:',
  '  krea:',
  '    knight:',
  "      - 'A chibi sticker illustration of a knight in dented silver armor, a red cape over his shoulders.'",
  '    ranger:',
  "      - 'a CHIBI sticker illustration of a ranger with a red cape over his shoulders, and a bow.'",
  '    rogue:',
  "      - 'A chibi sticker illustration of a rogue.'",
  '',
].join('\n')

test('prose: the longest form of each repeat, ignoring case and edge punctuation', () => {
  // "of a" goes on in every copy, so the repeat is 6 words long, not 5
  assert.deepEqual(brief(findRepeats([parse(PROSE)])), [
    [6, 'words', 3, 'A chibi sticker illustration of a'],
    [6, 'words', 2, 'a red cape over his shoulders.'],
  ])
  // a shorter run with more copies is its own repeat
  const more = PROSE + "    bard:\n      - 'A chibi sticker illustration of the bard.'\n"
  assert.deepEqual(brief(findRepeats([parse(more)])).slice(0, 2), [
    [5, 'words', 4, 'A chibi sticker illustration of'],
    [6, 'words', 3, 'A chibi sticker illustration of a'],
  ])
})

test('positions point at the start of each copy', () => {
  const [, cape] = findRepeats([parse(PROSE)])
  assert.deepEqual(cape.occurrences, [
    {file: 'test.yaml', line: 4, col: 75, keyPath: 'lib/krea/knight'},
    {file: 'test.yaml', line: 6, col: 56, keyPath: 'lib/krea/ranger'},
  ])
})

test('--min-words / --min-tags set the shortest repeat', () => {
  assert.deepEqual(brief(findRepeats([parse(PROSE)], {minWords: 6})).length, 2)
  assert.deepEqual(brief(findRepeats([parse(PROSE)], {minWords: 7})), [])
  const tags = 'lib:\n  - a, b, c\n  - a, b, c, d\n'
  assert.deepEqual(brief(findRepeats([parse(tags)])), [])
  assert.deepEqual(brief(findRepeats([parse(tags)], {minTags: 3})), [[3, 'tags', 2, 'a, b, c']])
})

test('tags: in order by default; case and _ vs space don’t matter; groups and refs are one tag each', () => {
  const yaml = [
    'lib:',
    '  ill:',
    '    - 1girl, long_hair, {red|blue} eyes, __lib/pose__, smile, sword',
    '    - armor, 1girl, Long Hair, {red|blue} eyes, __lib/pose__, smile, shield',
    '    - 1girl, long hair, smile, {red|blue} eyes, __lib/pose__',
    '  pose:',
    '    - standing',
    '',
  ].join('\n')
  assert.deepEqual(brief(findRepeats([parse(yaml)])), [
    [5, 'tags', 2, '1girl, long_hair, {red|blue} eyes, __lib/pose__, smile'],
  ])
})

test('--any-order: tag sets in their largest form; prose stays in order', () => {
  const yaml = [
    'lib:',
    '  ill:',
    '    - 1girl, bare_shoulders, cleavage, thighs, large_breasts, long hair',
    '    - short hair, large breasts, Cleavage, bare shoulders, 1girl, thighs',
    '    - long hair, thighs, 1girl, cleavage, large breasts, bare shoulders',
    '  krea:',
    "    - 'a knight in dented silver armor, a red cape'",
    "    - 'a red cape, a knight in dented silver armor'",
    '',
  ].join('\n')
  // in order, only the prose phrase repeats
  assert.deepEqual(brief(findRepeats([parse(yaml)])), [[6, 'words', 2, 'a knight in dented silver armor']])
  assert.deepEqual(
    findRepeats([parse(yaml)], {anyOrder: true}).map((r) => [
      r.length,
      r.unit,
      r.anyOrder,
      r.occurrences.length,
      r.text,
    ]),
    [
      [5, 'tags', true, 3, '1girl, bare_shoulders, cleavage, thighs, large_breasts'],
      [6, 'tags', true, 2, '1girl, bare_shoulders, cleavage, thighs, large_breasts, long hair'],
      [6, 'words', false, 2, 'a knight in dented silver armor'],
    ],
  )
})

test('a repeat inside one entry counts; nothing matches across two entries', () => {
  const yaml = [
    'lib:',
    '  krea:',
    "    - 'a plumed captain hat pushed back, rings, and later a plumed captain hat pushed back'",
    "    - 'one two three'",
    "    - 'four five six'",
    "    - 'three four five'",
    '',
  ].join('\n')
  assert.deepEqual(brief(findRepeats([parse(yaml)], {minWords: 3})), [
    [6, 'words', 2, 'a plumed captain hat pushed back'],
  ])
})

test('runs made only of __refs__ are skipped', () => {
  const yaml = [
    'lib:',
    '  krea:',
    "    - '__lib/a__ __lib/b__ __lib/c__ __lib/d__ __lib/e__ end one'",
    "    - '__lib/a__ __lib/b__ __lib/c__ __lib/d__ __lib/e__ end two'",
    '',
  ].join('\n')
  assert.deepEqual(brief(findRepeats([parse(yaml)])), [
    [6, 'words', 2, '__lib/a__ __lib/b__ __lib/c__ __lib/d__ __lib/e__ end'],
  ])
  assert.deepEqual(brief(findRepeats([parse(yaml.replace(/ end (one|two)/g, ''))])), [])
})

test('anima: the sentence is words, the tag line tags', () => {
  const [entry] = parse("lib:\n  anima:\n    - 'A knight stands guard. armor, long_hair, sword'\n").entries
  assert.deepEqual(
    tokenizeEntry(entry).map((run) => [run.unit, run.tokens.map((t) => t.key)]),
    [
      ['words', ['w:a', 'w:knight', 'w:stands', 'w:guard']],
      ['tags', ['t:armor', 't:long hair', 't:sword']],
    ],
  )
})

test('--path keeps only matching entries; several files are one library', () => {
  const a = parseWildcardFile("lib:\n  krea:\n    - 'one two three four five'\n", {path: 'a.yaml'})
  const b = parseWildcardFile("other:\n  krea:\n    - 'one two three four five'\n", {path: 'b.yaml'})
  assert.deepEqual(
    findRepeats([a, b])[0].occurrences.map((o) => o.file),
    ['a.yaml', 'b.yaml'],
  )
  assert.deepEqual(findRepeats([a, b], {path: 'lib/**'}), [])
})

test('the text report and --top summary', () => {
  const repeats = findRepeats([parse(PROSE)])
  assert.equal(
    formatRepeats(repeats.slice(0, 1), repeats.length),
    [
      '6 words × 3  "A chibi sticker illustration of a"',
      '  test.yaml:4:10  lib/krea/knight',
      '  test.yaml:6:10  lib/krea/ranger',
      '  test.yaml:8:10  lib/krea/rogue',
      '',
      'The 1 biggest of 2 repeats: 1 in words, 0 in tags',
    ].join('\n'),
  )
  assert.equal(formatRepeats([]), 'No repeats found.')
})

test('CLI: exit code 1 with repeats, --json, exit 0 without', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-repeats-'))
  try {
    fs.writeFileSync(path.join(dir, 'prose.yaml'), PROSE)
    fs.writeFileSync(path.join(dir, 'clean.yaml'), 'lib:\n  - a, b\n')
    const run = (...args) => spawnSync(process.execPath, [BIN, 'wc', 'repeats', ...args], {cwd: dir, encoding: 'utf8'})

    const json = run('prose.yaml', '--json', '--top', '1')
    assert.equal(json.status, 1)
    const [first] = JSON.parse(json.stdout)
    assert.deepEqual([first.unit, first.length, first.occurrences.length], ['words', 6, 3])

    const clean = run('clean.yaml')
    assert.equal(clean.status, 0)
    assert.match(clean.stdout, /No repeats found\./)

    assert.equal(run('missing.yaml').status, 2)
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})
