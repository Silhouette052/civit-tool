import {test} from 'node:test'
import assert from 'node:assert/strict'
import {normalizeTag, escapeTag} from '../lib/tag-index/index.js'

test('normalizeTag: escaped, spaced and cased forms all meet in the CSV form', () => {
  for (const input of [
    'arrow_\\(projectile\\)',
    'arrow (projectile)',
    'Arrow_(Projectile)',
    '  arrow  (projectile) ',
  ]) {
    assert.equal(normalizeTag(input), 'arrow_(projectile)', input)
  }
  assert.equal(normalizeTag('\\@_\\@'), '@_@')
  assert.equal(normalizeTag('j\\@ck'), 'j@ck')
  assert.equal(normalizeTag('blood on clothes'), 'blood_on_clothes')
})

test('normalizeTag: other backslashes are left alone', () => {
  assert.equal(normalizeTag('a\\b'), 'a\\b')
})

test('escapeTag: escapes ( ) and @ for A1111/Forge and prompt-postprocessor', () => {
  assert.equal(escapeTag('arrow_(projectile)'), 'arrow_\\(projectile\\)')
  assert.equal(escapeTag('@_@'), '\\@_\\@')
  assert.equal(escapeTag('long_hair'), 'long_hair')
})

test('escapeTag and normalizeTag round-trip', () => {
  for (const tag of ['arrow_(projectile)', 'zwei_(rwby)', '@_@', 'j@ck', 'long_hair']) {
    assert.equal(normalizeTag(escapeTag(tag)), tag)
  }
})
