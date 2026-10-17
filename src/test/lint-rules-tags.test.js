// R1–R4 (quality rules), one fixture each, plus branch equivalence and empty options.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {TagIndex, parseDanbooruCsv} from '../lib/tag-index/index.js'
import {inUserForm} from '../lib/lint/index.js'
import {lintYaml, brief, only, rules, index} from './lint-helpers.js'

test('valid tags in any C5 form produce no finding', () => {
  const r = lintYaml('simple:\n  - 1girl, long hair, red_hair, arrow_\\(projectile\\), (red_ribbon:1.2)\n')
  assert.deepEqual(r.findings, [])
})

test('R1: unknown tag, with suggestions', () => {
  const r = lintYaml('simple:\n  - lnog_hair, wearing torn animal hide armor\n')
  assert.deepEqual(brief(r), [
    ['R1', 'unknown tag "lnog_hair"; did you mean long_hair?'],
    ['R1', 'unknown tag "wearing torn animal hide armor"'],
  ])
  assert.equal(r.findings[0].col, 5)
})

test('R2: below the minimum post count', () => {
  const strict = lintYaml(
    'simple:\n  - zwei \\(rwby\\)\n',
    {minCount: 100},
    new TagIndex(parseDanbooruCsv('zwei_(rwby),4,95,'), [], {minCount: 100}),
  )
  assert.deepEqual(brief(strict), [['R2', '"zwei \\(rwby\\)" has only 95 posts (minimum 100)']])
})

test('R3: alias → canonical, fixable, keeping the user’s space/underscore form', () => {
  const r = lintYaml('simple:\n  - chains, armored bikini, club, tall_woman\n')
  assert.deepEqual(
    only(r, 'R3').map((f) => [f.fix?.replace, f.fix?.with]),
    [
      ['chains', 'chain'],
      ['armored bikini', 'bikini armor'], // from aliases.local.csv; spaces kept
      ['club', 'club_\\(weapon\\)'], // escaped output form
      ['tall_woman', 'tall_female'], // underscores kept
    ],
  )
})

test('R3: an alias with several targets is reported but not auto-fixed', () => {
  const [f] = only(lintYaml('simple:\n  - thighhigh\n'), 'R3')
  assert.equal(f.message, '"thighhigh" is an alias of thighhighs (or single_thighhigh); aliases break generation')
  assert.equal(f.fix, undefined)
})

test('R3/R1 on a glued group (real l.528 pattern): reported, never auto-fixed', () => {
  const r = lintYaml('simple:\n  - "{red|3::white|2::black|gold|} hair"\n')
  assert.deepEqual(brief(r), [
    ['R3', '"gold hair" is an alias of blonde_hair; aliases break generation (glued from a {…} group: fix by hand)'],
    ['R1', 'unknown tag "hair"; did you mean long_hair, blonde_hair, black_hair, white_hair, red_hair?'],
  ])
  assert.ok(r.findings.every((f) => f.fix === undefined))
})

test('R4: a bare colour word gets its own clearer message', () => {
  assert.deepEqual(brief(lintYaml('simple:\n  - black, sword\n')), [
    ['R4', 'bare colour word "black" is not a tag: it needs a noun, e.g. black_hair'],
  ])
})

test('a tag under simple: is validated exactly like one under ill:', () => {
  const body = '  - chains, lnog_hair, arrow_(projectile)\n'
  const ill = lintYaml('ill:\n' + body)
  const simple = lintYaml('simple:\n' + body)
  assert.deepEqual(rules(ill), ['R3', 'R1', 'R5'])
  assert.deepEqual(brief(simple), brief(ill))
})

test('empty options never produce a finding (C6)', () => {
  const r = lintYaml('simple:\n  - "{|red_ribbon}, {red_hair||white_hair}, {sword,|}, {|}"\n')
  assert.deepEqual(r.findings, [])
})

test('inUserForm keeps spaces only when the original used spaces and no underscores', () => {
  assert.equal(inUserForm('bikini_armor', 'armored bikini'), 'bikini armor')
  assert.equal(inUserForm('bikini_armor', 'armored_bikini'), 'bikini_armor')
  assert.equal(inUserForm('chain', 'chains'), 'chain')
  assert.ok(index.size > 0)
})
