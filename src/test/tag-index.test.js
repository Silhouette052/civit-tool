// TagIndex behaviour on a small set of real CSV rows (see fixture-rows.ts).

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {TagIndex, parseDanbooruCsv, parseAliasOverrides} from '../lib/tag-index/index.js'
import {REAL_CSV_ROWS, REAL_ALIASES_LOCAL} from './tag-index-fixture-rows.js'

const rows = parseDanbooruCsv(REAL_CSV_ROWS)
const index = new TagIndex(rows, parseAliasOverrides(REAL_ALIASES_LOCAL))

test('valid tag: canonical, escaped, with category and count', () => {
  assert.deepEqual(index.lookupOne('long hair'), {
    input: 'long hair',
    normalized: 'long_hair',
    status: 'valid',
    tag: 'long_hair',
    category: 'general',
    count: 4350743,
  })
})

test('plan fixtures: chains, armored bikini and tall woman are aliases', () => {
  const [chains, armored, tall] = index.lookup(['chains', 'armored bikini', 'tall woman'])
  assert.equal(chains.status, 'alias')
  assert.equal(chains.aliasOf, 'chain')
  assert.equal(armored.status, 'alias') // from aliases.local.csv
  assert.equal(armored.aliasOf, 'bikini_armor')
  assert.equal(armored.count, 9673)
  assert.equal(tall.status, 'alias') // from aliases.local.csv
  assert.equal(tall.aliasOf, 'tall_female')
})

test('/lh is an autocomplete shortcut, not an alias', () => {
  assert.equal(index.lookupOne('/lh').status, 'unknown')
  assert.equal(index.lookupOne('longhair').aliasOf, 'long_hair') // the real alias still works
})

test('escaped and spaced forms of a parenthesised tag both resolve', () => {
  for (const input of ['arrow_\\(projectile\\)', 'arrow (projectile)']) {
    const r = index.lookupOne(input)
    assert.equal(r.status, 'valid', input)
    assert.equal(r.tag, 'arrow_\\(projectile\\)', input)
  }
})

test('@ is escaped in the output form', () => {
  assert.equal(index.lookupOne('@_@').tag, '\\@_\\@')
  assert.equal(index.lookupOne('j\\@ck').tag, 'j\\@ck')
})

test('a name that is both a tag and an alias of another tag is valid', () => {
  // hair_bun has 244,545 posts of its own, though single_hair_bun lists it as an alias.
  const r = index.lookupOne('hair_bun')
  assert.equal(r.status, 'valid')
  assert.equal(r.count, 244545)
})

test('an alias with several targets: most-used first, the others as suggestions', () => {
  const r = index.lookupOne('thighhigh')
  assert.equal(r.status, 'alias')
  assert.equal(r.aliasOf, 'thighhighs')
  assert.deepEqual(r.suggestions, ['single_thighhigh'])
})

test('gold hair is an alias of blonde_hair (relevant to glued groups)', () => {
  assert.equal(index.lookupOne('gold hair').aliasOf, 'blonde_hair')
})

test('low-count: below minCount the tag is reported, not hidden', () => {
  const strict = new TagIndex(rows, [], {minCount: 100})
  const r = strict.lookupOne('zwei_(rwby)') // 95 posts
  assert.equal(r.status, 'low-count')
  assert.equal(r.count, 95)
  assert.equal(index.lookupOne('zwei (rwby)').status, 'valid') // default minCount is 80
})

test('unknown: typo suggestions', () => {
  const r = index.lookupOne('lnog_hair')
  assert.equal(r.status, 'unknown')
  assert.equal(r.suggestions?.[0], 'long_hair')
  assert.equal(index.lookupOne('thighighs_x').status, 'unknown')
  assert.deepEqual(index.lookupOne('blonde_hiar').suggestions?.[0], 'blonde_hair')
})

test('unknown: when every word is a real tag word, word matches come first', () => {
  // `black` is not a tag (bare colour words are invalid) but is a word of real tags.
  assert.deepEqual(index.lookupOne('black').suggestions, ['black_hair'])
  assert.equal(index.lookupOne('hair red').suggestions?.[0], 'red_hair')
})

test('lookup keeps input order and repeats', () => {
  const results = index.lookup(['chain', 'nope_nope', 'chain'])
  assert.deepEqual(
    results.map((r) => r.status),
    ['valid', 'unknown', 'valid'],
  )
})

test('aliases.local.csv entries win over a real tag with the same name', () => {
  const overrides = parseAliasOverrides('alias,tag\nhair_bun,single_hair_bun\n')
  const r = new TagIndex(rows, overrides).lookupOne('hair_bun')
  assert.equal(r.status, 'alias')
  assert.equal(r.aliasOf, 'single_hair_bun')
})

test('aliases.local.csv pointing at a missing tag is an error', () => {
  const overrides = parseAliasOverrides('alias,tag\ntall_woman,tall_lady\n')
  assert.throws(() => new TagIndex(rows, overrides), /line 2: tag "tall_lady" is not in danbooru.csv/)
})
