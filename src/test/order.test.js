import assert from 'node:assert/strict'
import {test} from 'node:test'

import {ExpandError, normalizeWildcardPath, sortWildcardKeys} from '../lib/wildcards.js'

const sort = (text, pattern) => sortWildcardKeys(text, normalizeWildcardPath(pattern)).text

// a typical nested wildcard file
const OWN = `own:
  style:
    nonlora:
      - dummy
    ill:
      - dummy
    anima:
      - dummy
  action:
    dance:
      - dummy
      - a_dummy
    combat:
      - dummy
`

test('__own/__ sorts only the keys directly under own', () => {
  assert.equal(
    sort(OWN, '__own/__'),
    `own:
  action:
    dance:
      - dummy
      - a_dummy
    combat:
      - dummy
  style:
    nonlora:
      - dummy
    ill:
      - dummy
    anima:
      - dummy
`,
  )
  assert.equal(sort(OWN, 'own'), sort(OWN, 'own/'), 'no ending means the same as "/"')
})

test('__own/*__ sorts own and every level below; list entries keep their order', () => {
  const sorted = `own:
  action:
    combat:
      - dummy
    dance:
      - dummy
      - a_dummy
  style:
    anima:
      - dummy
    ill:
      - dummy
    nonlora:
      - dummy
`
  assert.equal(sort(OWN, '__own/*__'), sorted)
  assert.equal(sort(OWN, 'own/**'), sorted)
  assert.equal(sort(OWN, '*'), sorted, '"*" alone is the whole file')
})

test('the part before the last segment picks the maps, with globs and braces', () => {
  const {changed} = sortWildcardKeys(OWN, 'own/*/*')
  assert.deepEqual(changed.map((c) => c.path).sort(), ['own/action', 'own/style'], "own's own keys stay")
  assert.deepEqual(
    sortWildcardKeys(OWN, 'own/{style}/').changed.map((c) => c.path),
    ['own/style'],
  )
})

test('a path that matches nothing is retried as **/path, then ignoring case', () => {
  assert.equal(sortWildcardKeys(OWN, 'style/').note, 'no exact match; used __**/style__')
  assert.equal(sortWildcardKeys(OWN, 'OWN/').note, 'no exact match; matched ignoring upper/lower case')
})

test('errors: a list path, and a path that matches nothing', () => {
  assert.throws(() => sortWildcardKeys(OWN, 'own/style/ill/'), /own\/style\/ill is a list/)
  assert.throws(() => sortWildcardKeys(OWN, 'nope/', {source: 'x.yaml'}), /__nope\/__ matches no key in x\.yaml/)
  assert.throws(() => sortWildcardKeys('a: [b', '*'), ExpandError)
})

test('comments and blank lines move with their keys; quoting, >- and CRLF are kept', () => {
  const text = [
    'lib:',
    '  # about zeta',
    '  zeta:',
    '    - "{a|b}"',
    '',
    '  # about mid',
    '  mid: >-',
    '    folded text',
    '  alpha:',
    '    - x',
    '',
  ].join('\r\n')
  const {reformatted, text: sorted} = sortWildcardKeys(text, 'lib/')
  assert.equal(reformatted, false)
  assert.equal(
    sorted,
    [
      'lib:',
      '  alpha:',
      '    - x',
      '',
      '  # about mid',
      '  mid: >-',
      '    folded text',
      '  # about zeta',
      '  zeta:',
      '    - "{a|b}"',
      '',
    ].join('\r\n'),
  )
})

test('the first key after sorting gets no blank line above it', () => {
  assert.equal(sort('b: 1\n\na: 2\n', '*'), 'a: 2\nb: 1\n')
})

test('keys sort case-insensitively and numbers by value', () => {
  assert.deepEqual(sortWildcardKeys('v10: 1\nB: 1\nv2: 1\na: 1\n', '*').changed[0].after, ['a', 'B', 'v2', 'v10'])
})

test('sorting twice changes nothing the second time; reformatting is reported', () => {
  const once = sort(OWN, '*')
  const again = sortWildcardKeys(once, '*')
  assert.equal(again.changed.length, 0)
  assert.equal(again.text, once)
  assert.equal(sortWildcardKeys('a:\n    - x\n', '*').reformatted, true, '4-space indent is printed as 2')
  assert.equal(sortWildcardKeys('a: >-\n  two\n  lines\n', '*').reformatted, true, 'folded text goes on one line')
})
