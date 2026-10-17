import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseCsvLine, parseDanbooruCsv} from '../lib/tag-index/index.js'

// Real rows copied verbatim from data/danbooru.csv (2026-10-02), with CRLF endings
// like the original and no trailing newline after the last row.
const REAL_ROWS = [
  'long_hair,0,4350743,"/lh,longhair"',
  'chain,0,103750,chains',
  'arrow_(projectile),0,19398,arrows',
  'bikini_armor,0,9673,',
  '"don\'t_say_""lazy""",0,1076,don\'t_say_lazy',
  'highres,5,5256195,"high_res,high_resolution,hires"',
  'zwei_(rwby),4,95,',
].join('\r\n')

test('parseCsvLine: quoted field with commas stays one field', () => {
  assert.deepEqual(parseCsvLine('long_hair,0,4350743,"/lh,longhair"'), ['long_hair', '0', '4350743', '/lh,longhair'])
})

test('parseCsvLine: doubled quotes inside a quoted tag', () => {
  assert.deepEqual(parseCsvLine('"don\'t_say_""lazy""",0,1076,don\'t_say_lazy'), [
    'don\'t_say_"lazy"',
    '0',
    '1076',
    "don't_say_lazy",
  ])
})

test('parseCsvLine: empty last field', () => {
  assert.deepEqual(parseCsvLine('bikini_armor,0,9673,'), ['bikini_armor', '0', '9673', ''])
})

test('parseDanbooruCsv: real rows, CRLF, no trailing newline', () => {
  const rows = parseDanbooruCsv(REAL_ROWS)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0], {
    tag: 'long_hair',
    category: 'general',
    count: 4350743,
    aliases: ['longhair'], // `/lh` is a shortcut, not an alias
    shortcuts: ['/lh'],
  })
  assert.deepEqual(rows[1].aliases, ['chains'])
  assert.equal(rows[2].tag, 'arrow_(projectile)')
  assert.deepEqual(rows[3].aliases, [])
  assert.equal(rows[4].tag, 'don\'t_say_"lazy"')
  assert.equal(rows[5].category, 'meta')
  assert.deepEqual(rows[5].aliases, ['high_res', 'high_resolution', 'hires'])
  assert.deepEqual(rows[6], {tag: 'zwei_(rwby)', category: 'character', count: 95, aliases: [], shortcuts: []})
})

test('parseDanbooruCsv: tolerates LF endings, a BOM and a trailing newline', () => {
  const rows = parseDanbooruCsv('﻿' + REAL_ROWS.replaceAll('\r\n', '\n') + '\n')
  assert.equal(rows.length, 7)
  assert.equal(rows[0].tag, 'long_hair')
})

test('parseDanbooruCsv: reports the line number of a malformed row', () => {
  assert.throws(
    () => parseDanbooruCsv('chain,0,103750,chains\r\nchain,2,103750,chains'),
    /line 2: unknown category code "2"/,
  )
  assert.throws(() => parseDanbooruCsv('chain,0,many,chains'), /line 1: count is not an integer/)
  assert.throws(() => parseDanbooruCsv('chain,0,103750'), /line 1: expected 4 fields, got 3/)
})
