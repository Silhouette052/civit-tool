// Prose branches (krea:): branch keys as globs, no Danbooru checks, the word budget, P-tags, P-neg,
// S-base, and the branch config. The synthetic library is shaped like a real Krea 2 file: style and
// character pieces under `krea:`, whole prompts composed from them under `front-krea:`.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'
import {makeLintConfig, DEFAULT_CONFIG} from '../lib/lint/index.js'
import {lintYaml, brief, only, rules} from './lint-helpers.js'

const LORA_DIR = fileURLToPath(new URL('fixtures/lint/loras/', import.meta.url))

const LIBRARY = [
  'shirts:',
  '  krea:',
  '    open:',
  "      - 'A chibi sticker illustration of'",
  '    tail:',
  "      - 'Thick clean dark outlines, vivid flat cel shading, crisp print-ready edges.'",
  '    characters:',
  '      knight:',
  "      - 'a knight in dented silver armor, a red cape, a long sword, a red cape, smiling at the viewer.'",
  '  front-krea:',
  '    knight:',
  "      - '__shirts/krea/open__ __shirts/krea/characters/knight__ __shirts/krea/tail__'",
  '',
].join('\n')

test('branch keys are globs, matched case-insensitively: krea, front-krea, MyKreaPrompts', () => {
  const file = parseWildcardFile(
    'a:\n  krea:\n    - x\n  front-krea:\n    - x\n  MyKreaPrompts:\n    - x\n  ill:\n    - x\n',
  )
  assert.deepEqual(
    [...file.keys.values()].map((k) => [k.path, k.branch]),
    [
      ['a', null],
      ['a/krea', 'krea'],
      ['a/front-krea', 'krea'],
      ['a/MyKreaPrompts', 'krea'],
      ['a/ill', 'ill'],
    ],
  )
  assert.deepEqual(
    file.entries.map((e) => e.style),
    ['prose', 'prose', 'prose', 'tags'],
  )
})

test('prose entries get no Danbooru checks and no in-entry S-dup; the library is clean', () => {
  // "a red cape" twice and "dented silver armor" would be R1 / S-dup under ill:
  assert.deepEqual(brief(lintYaml(LIBRARY)), [])
  assert.deepEqual(rules(lintYaml(LIBRARY.replace('  krea:', '  ill:'))).includes('R1'), true)
})

test('prose entries still get the structure and escaping rules', () => {
  const yaml = "lib:\n  krea:\n    - 'a knight (tall) holding {a sword|a spear, __lib/nope__'\n"
  assert.deepEqual(rules(lintYaml(yaml)).sort(), ['R5', 'S-brace', 'S-ref'])
  const refs = "lib:\n  krea:\n    - 'a knight holding __lib/nope__'\n"
  assert.deepEqual(rules(lintYaml(refs)), ['S-ref'])
})

test('S-budget counts the words of the longest expansion through refs', () => {
  // open 5 + knight 19 + tail 11 = 35 words
  const r = lintYaml(LIBRARY, {maxWordsPerEntry: 30})
  assert.deepEqual(
    only(r, 'S-budget').map((f) => [f.keyPath, f.message]),
    [['shirts/front-krea/knight', 'this entry can expand to 35 words (budget 30)']],
  )
  assert.deepEqual(only(lintYaml(LIBRARY, {maxWordsPerEntry: 35}), 'S-budget'), [])
  // the longest option counts; a LoRA counts no words
  const groups = "lib:\n  krea:\n    - 'a {red|deep oxblood red} cape <lora:x:0.8> waving'\n"
  assert.deepEqual(brief(lintYaml(groups, {maxWordsPerEntry: 5})), [
    ['S-budget', 'this entry can expand to 6 words (budget 5)'],
  ])
})

test('the default word budget is 150', () => {
  assert.equal(DEFAULT_CONFIG.maxWordsPerEntry, 150)
  const long = `lib:\n  krea:\n    - '${Array(151).fill('word').join(' ')}'\n`
  assert.deepEqual(rules(lintYaml(long)), ['S-budget'])
})

test('P-tags: one finding per entry that still looks like Danbooru tags', () => {
  const yaml = [
    'lib:',
    '  krea:',
    "    - 'masterpiece, best quality, 1girl, long_hair, blue_eyes, score_7, a girl on a hill'",
    "    - 'A knight stands on a hill at dawn, best quality armor glinting.'",
    '',
  ].join('\n')
  assert.deepEqual(
    only(lintYaml(yaml), 'P-tags').map((f) => [f.line, f.col, f.message]),
    [[3, 8, 'krea entry looks like Danbooru tags (masterpiece, best quality, 1girl, …); write it as prose']],
  )
})

test('P-neg: negations in prose, one finding each', () => {
  const yaml = [
    'lib:',
    '  krea:',
    "    - 'A bareheaded knight with no helmet or mask, without text on the banner.'",
    "    - 'A knight, his face uncovered, under a plain banner. Nothing else.'",
    '',
  ].join('\n')
  assert.deepEqual(
    only(lintYaml(yaml), 'P-neg').map((f) => f.message.split(':')[0]),
    ['"no helmet or mask"', '"without text"'],
  )
  // tags branches are not checked
  assert.deepEqual(only(lintYaml("lib:\n  ill:\n    - 'no humans, armor'\n"), 'P-neg'), [])
})

test('S-base: a krea: LoRA must be a Krea 2 LoRA', () => {
  const yaml = "lib:\n  krea:\n    - 'A girl in Edo <lora:EdoEraAnimeAnima:0.9>'\n"
  assert.deepEqual(brief(lintYaml(yaml, {loraDirs: [LORA_DIR]})), [
    ['S-base', '<lora:EdoEraAnimeAnima:0.9> is a "Anima" LoRA, but it is under krea: (accepts Krea 2, Krea 2 Turbo)'],
  ])
})

test('branches config: merge per branch, add one, remove one', () => {
  const config = makeLintConfig({
    branches: {
      ill: {baseModels: ['Illustrious', 'NoobAI', 'Pony']},
      flux: {keys: ['flux'], style: 'prose', baseModels: ['Flux.1 D']},
      krea: null,
    },
  })
  assert.deepEqual(Object.keys(config.branches), ['ill', 'anima', 'simple', 'flux'])
  assert.deepEqual(config.branches.ill, {keys: ['ill'], style: 'tags', baseModels: ['Illustrious', 'NoobAI', 'Pony']})
  const r = lintYaml("lib:\n  flux:\n    - 'a knight, no helmet'\n  krea:\n    - armor\n", config)
  assert.deepEqual(
    r.findings.map((f) => [f.keyPath, f.rule]),
    [
      ['lib/flux', 'P-neg'],
      ['lib/krea', 'S-branch'],
    ],
  )
})

test('branches config: bad definitions and the old baseModels setting are errors', () => {
  assert.throws(() => makeLintConfig({branches: {flux: {style: 'prose'}}}), /lint.branches.flux needs "keys"/)
  assert.throws(() => makeLintConfig({branches: {ill: {style: 'poetry'}}}), /lint.branches.ill.style must be one of/)
  assert.throws(() => makeLintConfig({baseModels: {ill: ['Pony']}}), /lint.branches.<name>.baseModels/)
})
