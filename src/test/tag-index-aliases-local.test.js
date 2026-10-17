import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseAliasOverrides} from '../lib/tag-index/index.js'
import {REAL_ALIASES_LOCAL} from './tag-index-fixture-rows.js'

test('parseAliasOverrides: the committed file', () => {
  assert.deepEqual(parseAliasOverrides(REAL_ALIASES_LOCAL), [
    {alias: 'armored_bikini', tag: 'bikini_armor', line: 2},
    {alias: 'tall_woman', tag: 'tall_female', line: 3},
  ])
})

test('parseAliasOverrides: any C5 form, comments, blank lines, CRLF', () => {
  const text = 'alias,tag\r\n# from the 2026-09 audit\r\n\r\nTall Woman, tall female\r\n'
  assert.deepEqual(parseAliasOverrides(text), [{alias: 'tall_woman', tag: 'tall_female', line: 4}])
})

test('parseAliasOverrides: rejects bad input with a line number', () => {
  assert.throws(() => parseAliasOverrides('tall_woman,tall_female\n'), /line 1: expected the header/)
  assert.throws(() => parseAliasOverrides('alias,tag\ntall_woman\n'), /line 2: expected "alias,tag"/)
  assert.throws(() => parseAliasOverrides('alias,tag\ntall_woman,\n'), /line 2: empty alias or tag/)
  assert.throws(() => parseAliasOverrides('alias,tag\nchain,chain\n'), /line 2: alias equals its tag/)
})
