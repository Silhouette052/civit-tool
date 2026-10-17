// S-* rules, one fixture each (synthetic YAML around real tags; S-yaml/S-brace from real lines).

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {lintYaml, brief, only, rules} from './lint-helpers.js'

test('S-yaml: duplicate keys and non-list values', () => {
  const r = lintYaml('simple:\n  a:\n    - sword\n  a:\n    - armor\n  b: sword\n')
  assert.deepEqual(rules(r), ['S-yaml', 'S-yaml'])
  assert.equal(r.findings[0].severity, 'error')
  assert.equal(r.findings[1].severity, 'warn')
})

test('S-brace: real l.528 with a } deleted', () => {
  const r = lintYaml('simple:\n  - "vampire, {red|3::white|2::black|gold| hair,"\n')
  assert.equal(only(r, 'S-brace')[0].message, 'unclosed "{"')
})

test('S-ref: unresolved name, glob matching nothing, unmatched __ marker; resolved ones are fine', () => {
  const r = lintYaml(
    'lib:\n  simple:\n    - sword\n  prompt:\n    - __lib/simple__, __lib/*__, __lib/nope__, __lib/x*__, __broken\n',
    {
      ignore: [{path: 'lib/prompt', rules: ['S-branch']}], // `, __broken` is text, so the leaf has "content"
    },
  )
  assert.deepEqual(brief(r), [
    ['S-ref', 'reference matches no wildcard: __lib/nope__'],
    ['S-ref', 'glob matches no wildcard: __lib/x*__'],
    ['S-ref', 'unmatched "__" marker in ", __broken"'],
  ])
})

test('S-ref resolves across files of one library', () => {
  const r = lintYaml(['a:\n  simple:\n    - sword\n', 'b:\n  - __a/simple__\n'])
  assert.deepEqual(r.findings, [])
})

test('S-range: impossible selections are errors; {2$$__ref__} is fine', () => {
  const r = lintYaml(
    'lib:\n  simple:\n    - "{3$$sword|armor}"\n    - "{3-2$$sword|armor|helmet}"\n    - "{0$$sword|armor}"\n    - "{2$$sword|armor}, {1-$$sword|armor}"\n    - "{2$$__lib/simple__}"\n',
  )
  assert.deepEqual(brief(r), [
    ['S-range', 'impossible selection "{3$$…}": it asks for 3 picks but has only 2 option(s)'],
    ['S-range', 'impossible selection "{3-2$$…}": min 3 is above max 2'],
    ['S-range', 'impossible selection "{0$$…}": it picks nothing'],
  ])
})

test('S-dup: repeated entry in a leaf, and a tag twice in one entry (real l.48, l.398 patterns)', () => {
  const r = lintYaml('simple:\n  - armor\n  - sword\n  - armor\n  - helmet, sword, {helmet,|} helmet\n')
  assert.deepEqual(brief(r), [
    ['S-dup', 'entry "armor" is repeated in this list (deliberate weighting? add an ignore)'],
    ['S-dup', '"helmet" appears twice in this entry'],
  ])
  assert.ok(r.findings.every((f) => f.severity === 'warn'))
})

test('S-budget: counts the largest expansion, following refs recursively', () => {
  const yaml = [
    'lib:',
    '  simple:',
    '    parts:',
    '      - sword, armor, helmet',
    '      - sword',
    '    outfit:',
    '      - __lib/simple/parts__, {horns,|} red_hair', // 3 + 1 + 1 = 5
    '    loop:',
    '      - __lib/simple/loop__, sword', // a cycle must terminate
  ].join('\n')
  assert.deepEqual(brief(lintYaml(yaml, {maxTagsPerEntry: 4})), [
    ['S-budget', 'this entry can expand to 5 tags (budget 4)'],
  ])
  assert.deepEqual(lintYaml(yaml, {maxTagsPerEntry: 5}).findings, [])
})

test('S-expand: more than the variation cap', () => {
  const g = '{red|3::white|2::black|gold|}'
  const r = lintYaml(`simple:\n  - "${g} ${g} ${g} ${g} hair"\n`)
  assert.equal(
    only(r, 'S-expand')[0].message,
    'a tag here has 625 variations (cap 256); its options were checked one by one',
  )
})

test('S-anima: an anima entry without a sentence terminator', () => {
  const r = lintYaml('anima:\n  - long_hair, sword\n  - A knight rests. armor\n')
  assert.deepEqual(brief(r), [['S-anima', 'anima entry has no sentence terminator (. ! ?); treated as tags only']])
})

test('S-branch: content without a branch is flagged once per leaf; ref-only leaves are not', () => {
  const r = lintYaml(
    'lib:\n  simple:\n    - sword\n  custom:\n    - armor\n    - helmet\n  prompt:\n    - __lib/simple__\n',
  )
  assert.deepEqual(
    only(r, 'S-branch').map((f) => [f.keyPath, f.line]),
    [['lib/custom', 4]],
  )
})
