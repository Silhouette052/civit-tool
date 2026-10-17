// Reference resolution against the real key tree.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveRef, globToRegExp, extractEntryTags} from '../lib/wildcard-parser/index.js'
import {fixture} from './wildcard-parser-helpers.js'

const ROOT = 'danboru-character-prompter'
const names = (pattern) => resolveRef(fixture, pattern).map((k) => k.path.slice(ROOT.length + 1))

test('globs used in the real file resolve to leaf keys', () => {
  assert.deepEqual(names(`${ROOT}/generic/races/*`), [
    'generic/races/angel',
    'generic/races/demon',
    'generic/races/minotaur',
    'generic/races/werewolf',
    'generic/races/human',
    'generic/races/vampire',
    'generic/races/orc',
    'generic/races/elf',
    'generic/races/dwarf',
    'generic/races/goblin',
    'generic/races/halfling',
  ])
  assert.equal(names(`${ROOT}/custom/female/*/prompt-*-with-location`).length, 75)
  assert.equal(names(`${ROOT}/custom/male/*/prompt-*-with-location`).length, 11)
})

test('every reference in the real file resolves', () => {
  let refs = 0
  for (const entry of fixture.entries) {
    for (const tag of extractEntryTags(entry).tags) {
      if (tag.kind !== 'ref') continue
      refs++
      assert.ok(resolveRef(fixture, tag.ref.name).length > 0, tag.ref.name)
    }
  }
  assert.equal(refs, 312)
})

test('a glob that matches nothing, or a non-leaf key, resolves to nothing', () => {
  assert.deepEqual(names(`${ROOT}/generic/races/*/nope`), [])
  assert.deepEqual(names(`${ROOT}/generic/races`), []) // a mapping, not a list
  assert.deepEqual(names(`${ROOT}/generic/races/Vampire`), []) // case-sensitive
})

test('* stays within a path segment, ** crosses segments', () => {
  assert.ok(!globToRegExp('a/*').test('a/b/c'))
  assert.ok(globToRegExp('a/*').test('a/b'))
  assert.ok(globToRegExp('a/**').test('a/b/c'))
  assert.deepEqual(names(`${ROOT}/*/vampire`), [])
  assert.deepEqual(names(`${ROOT}/**/vampire`), ['generic/races/vampire'])
})

test('regex characters in key names are literal', () => {
  assert.ok(globToRegExp('a.b/(c)').test('a.b/(c)'))
  assert.ok(!globToRegExp('a.b').test('axb'))
})
