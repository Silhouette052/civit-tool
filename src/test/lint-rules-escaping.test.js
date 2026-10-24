// R5 (parentheses) and R6 (@).

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {lintYaml, brief, only} from './lint-helpers.js'

test('(red_ribbon:1.2) passes; arrow_(projectile) fails R5 with an escaping fix', () => {
  assert.deepEqual(lintYaml('simple:\n  - (red_ribbon:1.2)\n').findings, [])
  const [f] = lintYaml('simple:\n  - long_hair, arrow_(projectile)\n').findings
  assert.equal(f.rule, 'R5')
  assert.equal(f.message, 'unescaped parenthesis in "arrow_(projectile)": A1111 reads it as emphasis')
  assert.deepEqual(f.fix, {replace: 'arrow_(projectile)', with: 'arrow_\\(projectile\\)'})
  assert.equal(f.col, 22) // the first bare parenthesis
})

test('R5 on the real l.694 pattern: unescaped inside a group option', () => {
  const r = lintYaml('simple:\n  - "{crossbow|axe|bow_(weapon)}"\n')
  assert.deepEqual(
    only(r, 'R5').map((f) => f.fix),
    [{replace: 'bow_(weapon)', with: 'bow_\\(weapon\\)'}],
  )
})

test('R5: parentheses around whole tags are emphasis; parentheses inside a tag need escaping', () => {
  assert.deepEqual(lintYaml('simple:\n  - (bow_\\(weapon\\):1.1)\n').findings, [])
  // A1111 reads these as emphasis of whole tags, and the tags inside are checked as usual
  for (const entry of ['(((long_hair)))', '(long_hair, red_ribbon)', '"{(long_hair)|chain}"', '((long_hair):1.2)']) {
    assert.deepEqual(lintYaml(`simple:\n  - ${entry}\n`).findings, [], entry)
  }
  assert.deepEqual(
    brief(lintYaml('simple:\n  - ((chains))\n')).map((b) => b[0]),
    ['R3'],
  )

  // inside a tag, or around only part of one, they are text: R5 (and --fix escapes them)
  const r5 = (entry) => lintYaml(`simple:\n  - ${entry}\n`).findings.filter((f) => f.rule === 'R5')
  const [inner] = r5('(bow_(weapon))') // the outer pair is emphasis, the inner one is part of the tag
  assert.deepEqual(inner.fix, {replace: 'bow_(weapon)', with: 'bow_\\(weapon\\)'})
  for (const entry of ['some (thing)', '(long_hair) chain', '(long_hair', 'long_hair)']) {
    assert.equal(r5(entry).length, 1, entry)
  }

  // A1111 removes a <lora:…> from the prompt, so one next to the pair doesn't make it part of a tag
  for (const entry of ['<lora:possill:1> (((long_hair)))', '"(((long_hair)))<lora:possill:1>, chain"']) {
    assert.deepEqual(r5(entry), [], entry)
  }
  assert.equal(r5('<lora:possill:1> bow_(weapon)').length, 1)
})

test('R5 applies to an anima sentence too (A1111 parses it the same way)', () => {
  const r = lintYaml('anima:\n  - A girl (smiling) waves. long_hair\n')
  assert.deepEqual(brief(r), [
    ['R5', 'unescaped parenthesis in "A girl (smiling) waves. long_hair": A1111 reads it as emphasis'],
  ])
})

test('R6: bare @ is flagged and fixed; escaped @ and the {@…} sampler are fine', () => {
  const [f] = lintYaml('simple:\n  - j@ck\n').findings
  assert.equal(f.rule, 'R6')
  assert.deepEqual(f.fix, {replace: 'j@ck', with: 'j\\@ck'})
  assert.deepEqual(lintYaml('simple:\n  - j\\@ck, \\@_\\@\n').findings, [])
  assert.deepEqual(lintYaml('simple:\n  - "{@red_hair|white_hair}"\n').findings, [])
})
