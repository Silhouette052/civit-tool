// fixtures/danboru_class_prompter.yaml round-trips with no diff: printing is canonical (indentation may change), but no value may change.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWildcardFile,
  printWildcardFile,
  renderTemplate,
  setEntryValue,
} from '../lib/wildcard-parser/index.js'
import {fixture, FIXTURE_SOURCE} from './wildcard-parser-helpers.js'

test('the real file parses with no problems', () => {
  assert.deepEqual(fixture.problems, [])
  assert.equal(fixture.entries.length, 1446)
  assert.equal(fixture.keys.size, 379)
  assert.equal([...fixture.keys.values()].filter((k) => k.isLeaf).length, 362)
})

test('every entry renders back from its template exactly', () => {
  for (const entry of fixture.entries) {
    assert.equal(renderTemplate(entry.template), entry.value, `${entry.keyPath}[${entry.index}]`)
  }
})

const printed = printWildcardFile(fixture)
const reparsed = parseWildcardFile(printed)

test('(a) printing and re-parsing keeps every key path and entry value', () => {
  assert.deepEqual([...reparsed.keys.keys()], [...fixture.keys.keys()])
  assert.deepEqual(
    reparsed.entries.map((e) => [e.keyPath, e.value]),
    fixture.entries.map((e) => [e.keyPath, e.value]),
  )
})

test('(b) printing is idempotent', () => {
  assert.equal(printWildcardFile(reparsed), printed)
})

test('(c) the canonical output differs from the original only in whitespace around values', () => {
  // indentation, `-  x` → `- x`, trailing spaces, and a final newline
  const normalise = (text) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^-\s+/, '- '))
      .filter((line) => line !== '')
  assert.deepEqual(normalise(printed), normalise(FIXTURE_SOURCE))
})

test('(d) CRLF line endings are kept', () => {
  assert.equal(fixture.eol, '\r\n')
  assert.equal(printed.split('\r\n').length, printed.split('\n').length)
})

test('setEntryValue changes only that entry', () => {
  const file = parseWildcardFile(FIXTURE_SOURCE)
  const target = file.entries[0]
  setEntryValue(target, 'purple_robe, ornate, gold_trim')
  const after = parseWildcardFile(printWildcardFile(file))
  const changed = after.entries.filter((e, i) => e.value !== fixture.entries[i].value)
  assert.deepEqual(
    changed.map((e) => [e.keyPath, e.value]),
    [['danboru-character-prompter/generic/spells/colors', 'purple_robe, ornate, gold_trim']],
  )
})

test('positions: every entry maps value offsets onto the file exactly', () => {
  for (const entry of fixture.entries) {
    assert.notEqual(entry.valueStart, null, `${entry.keyPath}[${entry.index}]`)
    const start = entry.valueStart
    assert.equal(FIXTURE_SOURCE.slice(start, start + entry.value.length), entry.value)
  }
})

test('positions: quoted entries without escapes map exactly; with escapes they fall back', () => {
  const source = 'k:\n  - "{red|white} hair"\n  - \'{a|b}\'\n  - "tab\\there"\n'
  const file = parseWildcardFile(source)
  assert.equal(file.entries[0].valueStart, source.indexOf('{red'))
  assert.equal(file.entries[1].valueStart, source.indexOf('{a|b}'))
  assert.equal(file.entries[2].valueStart, null)
})

test('a top-level list is one wildcard named after the file (civit-tool loras.yaml)', () => {
  const file = parseWildcardFile('- <lora:EdoEraAnimeAnima:0.9>, EdoEraAnime,\n', {path: 'some/dir/loras.yaml'})
  assert.deepEqual([...file.keys.keys()], ['loras'])
  assert.equal(file.entries[0].keyPath, 'loras')
  assert.deepEqual(file.problems, [])
})
