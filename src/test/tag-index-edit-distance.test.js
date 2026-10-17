import {test} from 'node:test'
import assert from 'node:assert/strict'
import {boundedEditDistance, TypoIndex, parseDanbooruCsv} from '../lib/tag-index/index.js'
import {REAL_CSV_ROWS} from './tag-index-fixture-rows.js'

test('boundedEditDistance: insert, delete, substitute, transpose', () => {
  assert.equal(boundedEditDistance('long_hair', 'long_hair', 2), 0)
  assert.equal(boundedEditDistance('lnog_hair', 'long_hair', 2), 1) // transposition counts as 1
  assert.equal(boundedEditDistance('blonde_hiar', 'blonde_hair', 2), 1)
  assert.equal(boundedEditDistance('red_hai', 'red_hair', 2), 1)
  assert.equal(boundedEditDistance('rad_hiar', 'red_hair', 2), 2)
})

test('boundedEditDistance: returns max + 1 once the bound is exceeded', () => {
  assert.equal(boundedEditDistance('black', 'long_hair', 2), 3)
  assert.equal(boundedEditDistance('chain', 'thighhighs', 1), 2)
})

test('TypoIndex.near finds exactly what a brute-force scan finds', () => {
  const names = parseDanbooruCsv(REAL_CSV_ROWS).flatMap((r) => [r.tag, ...r.aliases])
  const index = new TypoIndex(names)
  for (const query of ['lnog_hair', 'thighighs', 'blonde_hiar', 'chainz', 'bikini_amror', 'hair', 'red_hari']) {
    for (const max of [1, 2]) {
      const fast = index
        .near(query, max)
        .map((h) => h.name)
        .sort()
      const brute = names.filter((n) => boundedEditDistance(query, n, max) <= max).sort()
      assert.deepEqual(fast, brute, `${query} (max ${max})`)
    }
  }
})
