import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  countWords,
  ExpandError,
  expandWildcard,
  fileNameFor,
  normalizeWildcardPath,
  parseLibrary,
} from '../lib/wildcards.js'

const expand = (yaml, pattern, options) => expandWildcard(parseLibrary(yaml), pattern, options).prompts

test('parseLibrary keeps only list-valued keys, by slash path, with empty items as ""', () => {
  const leaves = parseLibrary(`
lib:
  title: not a wildcard
  hair:
    color:
      - red
      -
      - "{a|b}"
`)
  assert.deepEqual([...leaves], [['lib/hair/color', ['red', '', '{a|b}']]])
})

test('parseLibrary rejects broken YAML', () => {
  assert.throws(() => parseLibrary('a: [b', undefined, 'x.yaml'), ExpandError)
})

test('variants expand in order, empty options included (real entry from tshirt-gamenight.yaml)', () => {
  assert.deepEqual(expand(`w:\n  - 'dice{|, dice|, dice, playing card}'\n`, 'w'), [
    'dice',
    'dice, dice',
    'dice, dice, playing card',
  ])
})

test('weights are ignored and glued groups multiply (real entry from danboru_class_prompter.yaml)', () => {
  const prompts = expand(`w:\n  - '{pale skin,|} {red|3::white|2::black|gold|} hair'\n`, 'w')
  assert.equal(prompts.length, 10)
  assert.equal(prompts[0], 'pale skin, red hair')
  assert.ok(prompts.includes('white hair'), 'the empty first option leaves the leading space trimmed')
  assert.ok(prompts.includes('pale skin, hair'))
})

test('escapes are kept verbatim and never act as syntax', () => {
  assert.deepEqual(expand(`w:\n  - 'jian \\(weapon\\), \\{a|b\\}'\n`, 'w'), ['jian \\(weapon\\), \\{a|b\\}'])
})

test('references and * / ** globs resolve to every matching wildcard', () => {
  const yaml = `
lib:
  races: [elf, orc]
  class:
    melee: [knight]
    magic:
      arcane: [wizard]
  hero: ['__lib/races__ __lib/class/*__']
  any: ['__lib/class/**__']
`
  assert.deepEqual(expand(yaml, 'lib/hero'), ['elf knight', 'orc knight'])
  assert.deepEqual(expand(yaml, 'lib/any'), ['knight', 'wizard'])
})

test('a reference that matches nothing is retried as **/name, with a warning', () => {
  const warnings = []
  const prompts = expandWildcard(parseLibrary('lib:\n  races: [elf]\n  hero: [__races__]\n'), 'lib/hero', {
    warn: (msg) => warnings.push(msg),
  }).prompts
  assert.deepEqual(prompts, ['elf'])
  assert.match(warnings[0], /__\*\*\/races__ was used/)
})

test('N$$ picks are ordered, without repeats, joined with "," or the given separator', () => {
  assert.deepEqual(expand(`w: ['{2$$a|b|c}']\n`, 'w'), ['a,b', 'a,c', 'b,a', 'b,c', 'c,a', 'c,b'])
  assert.deepEqual(expand(`w: ['{1-2$$ and $$a|b}']\n`, 'w'), ['a', 'b', 'a and b', 'b and a'])
})

test('prompt-postprocessor __N$$name__ picks from the wildcard, and r allows repeats', () => {
  assert.deepEqual(expand(`c: [red, blue]\nw: ['__2$$c__']\n`, 'w'), ['red,blue', 'blue,red'])
  assert.deepEqual(expand(`c: [red, blue]\nw: ['__r2$$c__']\n`, 'w'), ['red,red', 'red,blue', 'blue,red', 'blue,blue'])
})

test('duplicates are removed, newlines become spaces', () => {
  const {prompts, total} = expandWildcard(parseLibrary(`w: ['{a|a}', "b\\n  c"]\n`), 'w')
  assert.deepEqual(prompts, ['a', 'b c'])
  assert.equal(total, 3)
})

test('{a|b} in the typed path picks only those siblings, with globs inside and the **/ retry', () => {
  const yaml = `
lib:
  a: {x: [ax], y: [ay]}
  b: {x: [bx]}
  c: {x: [cx]}
`
  assert.deepEqual(expand(yaml, normalizeWildcardPath('__lib/{a|b}/*__')), ['ax', 'ay', 'bx'])
  assert.deepEqual(expand(yaml, 'lib/{a/y|c/*}'), ['ay', 'cx'])
  assert.deepEqual(expand(yaml, '{b|c}/x'), ['bx', 'cx'])
  assert.throws(() => expand(yaml, 'lib/{a|b/*'), /unclosed "\{"/)
})

test('the typed path falls back to **/path, then to ignoring case', () => {
  const leaves = parseLibrary('lib:\n  Hair: [red]\n')
  assert.equal(expandWildcard(leaves, 'Hair').note, 'no exact match; used __**/Hair__')
  assert.equal(expandWildcard(leaves, 'lib/hair').note, 'no exact match; matched ignoring upper/lower case')
})

test('unknown paths, over-max expansions, cycles and unclosed braces throw ExpandError', () => {
  const leaves = parseLibrary(`
lib:
  colors: [red, blue, green]
  outfit: ['{a|b} {c|d}']
  loop: [__lib/loop__]
  broken: ['{a|b']
`)
  assert.throws(() => expandWildcard(leaves, 'nope', {source: 'x.yaml'}), /matches no wildcard in x\.yaml/)
  assert.throws(() => expandWildcard(leaves, 'lib'), /folder of 4 wildcards: use __lib\/\*__/)
  assert.throws(() => expandWildcard(leaves, 'lib/outfit', {max: 3}), /expands to 4 prompts/)
  assert.throws(() => expandWildcard(leaves, 'lib/loop'), /reference cycle/)
  assert.throws(() => expandWildcard(leaves, 'lib/broken'), /unclosed "\{"/)
})

test('variables and <ppp:…> commands are kept as text with a warning', () => {
  const warnings = []
  const prompts = expandWildcard(parseLibrary(`w: ['\${x} a <ppp:stn>b</ppp:stn>']\n`), 'w', {
    warn: (msg) => warnings.push(msg),
  }).prompts
  assert.deepEqual(prompts, ['${x} a <ppp:stn>b</ppp:stn>'])
  assert.equal(warnings.length, 2)
})

test('normalizeWildcardPath and fileNameFor', () => {
  assert.equal(normalizeWildcardPath(' __a/b__ '), 'a/b')
  assert.equal(fileNameFor('tshirt-gamenight/wh40k/front-krea/*/matyi'), 'tshirt-gamenight_wh40k_front-krea_all_matyi')
  assert.equal(fileNameFor('lib/**'), 'lib_all')
  assert.equal(fileNameFor('some/path/{sibling-a|sibling-b}/*'), 'some_path_sibling-a+sibling-b_all')
})

test('countWords counts pieces with a letter between spaces, commas and { } | ( )', () => {
  assert.equal(countWords('star (sky), {2$$knight|samurai}'), 4)
  assert.equal(countWords('{afar, panoramic view,|} 2boys, ((duel))'), 5)
  assert.equal(countWords('{|} , 1.2'), 0)
})

test('keepWords: long entries are written exactly as they are, short ones still expand', () => {
  const long = 'battlefield,  {mist, fog,|} {knight|samurai}, __w__, banners'
  const yaml = `w: [rain, snow]\nscene:\n  - '${long}'\n  - '{red|blue} sky'\n`
  const {kept, prompts, total} = expandWildcard(parseLibrary(yaml), 'scene', {keepWords: 6})
  assert.deepEqual(prompts, [long, 'red sky', 'blue sky'], 'double spaces, variants and refs untouched')
  assert.equal(kept, 1)
  assert.equal(total, 3, 'a kept entry counts as one prompt toward --max')
})

test('keepWords applies to referenced entries too, which stay unexpanded inside a combination', () => {
  const yaml = `long: ['a {b|c} d e f']\nshort: ['x', y]\nboth: ['{1|2}, __long__, __short__']\n`
  assert.deepEqual(expandWildcard(parseLibrary(yaml), 'both', {keepWords: 5}).prompts, [
    '1, a {b|c} d e f, x',
    '1, a {b|c} d e f, y',
    '2, a {b|c} d e f, x',
    '2, a {b|c} d e f, y',
  ])
})
