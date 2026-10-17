// Model branches on the real file, plus a synthetic file for ill:/anima: (the real
// file has neither yet).

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseWildcardFile, extractEntryTags} from '../lib/wildcard-parser/index.js'
import {fixture} from './wildcard-parser-helpers.js'

const ROOT = 'danboru-character-prompter'

test('real file: generic/… is simple; scenes, custom/… and prompt-* have no branch', () => {
  assert.equal(fixture.keys.get(`${ROOT}/generic`).branch, 'simple')
  assert.equal(fixture.keys.get(`${ROOT}/generic/races/vampire`).branch, 'simple')
  assert.equal(fixture.keys.get(ROOT).branch, null)
  assert.equal(fixture.keys.get(`${ROOT}/scenes`).branch, null)
  assert.equal(fixture.keys.get(`${ROOT}/prompt-female`).branch, null)
  assert.equal(fixture.keys.get(`${ROOT}/custom/female/fantasy/darkelf`).branch, null)
  const counts = {simple: 0, none: 0}
  for (const e of fixture.entries) e.branch === 'simple' ? counts.simple++ : counts.none++
  assert.deepEqual(counts, {simple: 435, none: 1011})
})

// Synthetic, LF line endings.
const SYNTHETIC = [
  'knight:',
  '  anima:',
  '    - A knight stands guard at the castle gate. armor, {sword|spear}, castle',
  '    - The knight raises a (shield:1.2) and waits, 1.5 meters tall!  shield, 1boy',
  '    - "{Sir. Knight|A knight} rests! armor"', // quoted: a bare `{` would start a YAML mapping
  '    - armor, sword',
  '  ill:',
  '    hair:',
  '      - long_hair, {red|white} hair',
  '  simple:',
  '    - armor',
  '  custom:',
  '    - armor',
  '',
].join('\n')

test('synthetic: nearest ancestor-or-self branch key decides', () => {
  const file = parseWildcardFile(SYNTHETIC)
  assert.equal(file.eol, '\n')
  const branchOf = (path) => file.keys.get(path).branch
  assert.equal(branchOf('knight'), null)
  assert.equal(branchOf('knight/anima'), 'anima')
  assert.equal(branchOf('knight/ill/hair'), 'ill')
  assert.equal(branchOf('knight/simple'), 'simple')
  assert.equal(branchOf('knight/custom'), null)
})

test('synthetic: branch key names are configurable', () => {
  const branches = {
    ill: {keys: ['ill'], style: 'tags'},
    anima: {keys: ['anima'], style: 'sentence'},
    simple: {keys: ['custom'], style: 'tags', shared: true},
  }
  const file = parseWildcardFile(SYNTHETIC, {branches})
  assert.equal(file.keys.get('knight/custom').branch, 'simple')
  assert.equal(file.keys.get('knight/simple').branch, null)
})

test('anima: the sentence ends at the first terminator; only the tag line is extracted', () => {
  const file = parseWildcardFile(SYNTHETIC)
  const [first, second, third, fourth] = file.entries
  const texts = (e) => extractEntryTags(e).tags.map((t) => t.text)

  assert.equal(first.value.slice(0, first.tagLineStart), 'A knight stands guard at the castle gate.')
  assert.deepEqual(texts(first), ['armor', 'sword', 'spear', 'castle']) // source order

  // `1.2` and `1.5` don't end the sentence; `!` followed by a space does
  assert.equal(
    second.value.slice(0, second.tagLineStart),
    'The knight raises a (shield:1.2) and waits, 1.5 meters tall!',
  )
  assert.deepEqual(texts(second), ['shield', '1boy'])

  // a terminator inside a group is not a sentence end
  assert.equal(third.value.slice(0, third.tagLineStart), '{Sir. Knight|A knight} rests!')
  assert.deepEqual(texts(third), ['armor'])

  // no terminator → warning, and the whole entry is checked as tags
  assert.equal(fourth.tagLineStart, undefined)
  assert.deepEqual(texts(fourth), ['armor', 'sword'])
  assert.deepEqual(
    file.problems.map((p) => [p.kind, p.severity, p.keyPath, p.line]),
    [['anima', 'warn', 'knight/anima', 6]],
  )
})

test('non-list values and odd list items are reported, not crashed on', () => {
  const file = parseWildcardFile('a:\n  b: just a string\n  c:\n  d:\n    - ok\n    - {x: 1}\n')
  assert.deepEqual(
    file.problems.map((p) => [p.kind, p.keyPath, p.message]),
    [
      ['yaml', 'a/b', 'key holds a single value, not a list; dynamic-prompts ignores it'],
      ['yaml', 'a/c', 'key has no value'],
      ['yaml', 'a/d', 'list item is not a plain value (an item starting with "{" must be quoted); it is skipped'],
    ],
  )
  assert.deepEqual(
    file.entries.map((e) => e.value),
    ['ok'],
  )
})

test('an unquoted list item starting with { is a YAML mapping: reported, not read as a tag line', () => {
  const file = parseWildcardFile('k:\n  - {red|white} hair\n')
  assert.deepEqual(file.entries, [])
  assert.ok(file.problems.some((p) => p.kind === 'yaml' && p.message.includes('must be quoted')))
})

test('YAML errors (duplicate keys) become problems', () => {
  const file = parseWildcardFile('a:\n  - x\na:\n  - y\n')
  assert.equal(file.problems[0].kind, 'yaml')
  assert.equal(file.problems[0].severity, 'error')
  assert.equal(file.problems[0].line, 3)
})
