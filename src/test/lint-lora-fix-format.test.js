// S-base with a real civit-tool sidecar, --fix behaviour, JSON output, ignores.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'
import {
  lintFiles,
  applyFixes,
  applyEdits,
  formatJson,
  formatText,
  parseIgnoreArg,
  DEFAULT_CONFIG,
} from '../lib/lint/index.js'
import {lintYaml, brief, only, index} from './lint-helpers.js'

// fixtures/loras: civit-tool's real test output (loras.yaml + EdoEraAnimeAnima.json, "sd version": "Anima")
const LORA_DIR = fileURLToPath(new URL('fixtures/lint/loras/', import.meta.url))
const LORA = '<lora:EdoEraAnimeAnima:0.9>, EdoEraAnime,' // the real loras.yaml entry

test('S-base: the sidecar base model must match the branch; never under simple:', () => {
  const yaml = `lib:\n  anima:\n    - A girl in Edo. ${LORA}\n  ill:\n    - "${LORA}"\n  simple:\n    - "${LORA}"\n`
  const r = lintYaml(yaml, {loraDirs: [LORA_DIR]})
  assert.deepEqual(
    only(r, 'S-base').map((f) => [f.keyPath, f.message]),
    [
      ['lib/ill', '<lora:EdoEraAnimeAnima:0.9> is a "Anima" LoRA, but it is under ill: (accepts Illustrious, NoobAI)'],
      [
        'lib/simple',
        '<lora:EdoEraAnimeAnima:0.9> under simple: a LoRA works with one base model only; move it under ill:, anima: or krea:',
      ],
    ],
  )
})

test('S-base: without a sidecar (or without loraDirs) only the simple: check runs', () => {
  const r = lintYaml(`lib:\n  ill:\n    - "${LORA}"\n  simple:\n    - "${LORA}"\n`)
  assert.deepEqual(
    only(r, 'S-base').map((f) => f.keyPath),
    ['lib/simple'],
  )
})

test('civit-tool loras.yaml (a top-level list) lints as one wildcard named after the file', () => {
  const source = readFileSync(LORA_DIR + 'loras.yaml', 'utf8')
  const file = parseWildcardFile(source, {path: 'loras.yaml'})
  assert.deepEqual([...file.keys.keys()], ['loras'])
  const r = lintFiles([file], index, {...DEFAULT_CONFIG, loraDirs: [LORA_DIR]})
  // The trigger word is not a Danbooru tag, and the LoRA has no branch yet.
  assert.deepEqual(brief({...r, findings: r.findings}), [
    ['S-branch', 'tags here have no ill:/anima:/krea:/simple: ancestor, so the base model is unknown; checked as tags only'],
    ['R1', 'unknown tag "EdoEraAnime"'],
  ])
})

test('--fix changes only escaping and aliases, keeps the rest, and is idempotent', () => {
  // real library lines (l.258, l.348, l.694 patterns) plus an unknown tag that must stay
  const source = [
    'lib:',
    '  simple:',
    '    - casting_spell, water, wave{, splashing|, bubble|}',
    '    - club, holding_club',
    '    - 1girl, {crossbow|axe|bow_(weapon)}, lnog_hair',
    '    - (red_ribbon:1.2), j@ck, chains',
    '',
  ].join('\n')
  const file = parseWildcardFile(source, {path: 'lib.yaml'})
  const first = applyFixes(file, lintFiles([file], index, DEFAULT_CONFIG).findings)
  assert.equal(first.applied, 5) // wave, club, bow_(weapon), j@ck, chains
  const fixed = parseWildcardFile(first.output, {path: 'lib.yaml'})
  assert.deepEqual(
    fixed.entries.map((e) => e.value),
    [
      'casting_spell, water, waving{, splashing|, bubble|}',
      'club_\\(weapon\\), holding_club',
      '1girl, {crossbow|axe|bow_\\(weapon\\)}, lnog_hair',
      '(red_ribbon:1.2), j\\@ck, chain',
    ],
  )
  // second run: nothing left to fix, file untouched
  const second = applyFixes(fixed, lintFiles([fixed], index, DEFAULT_CONFIG).findings)
  assert.deepEqual(second, {output: null, applied: 0})
})

test('applyEdits: a replacement wins over an insertion inside it; duplicates apply once', () => {
  assert.equal(
    applyEdits('club(x)', [
      {start: 0, end: 7, text: 'club_\\(weapon\\)'},
      {start: 4, end: 4, text: '\\'},
    ]),
    'club_\\(weapon\\)',
  )
  assert.equal(
    applyEdits('a(b', [
      {start: 1, end: 1, text: '\\'},
      {start: 1, end: 1, text: '\\'},
    ]),
    'a\\(b',
  )
})

test('--json output is exactly Finding[]', () => {
  const r = lintYaml('simple:\n  - chains, lnog_hair\n')
  const json = JSON.parse(formatJson(r))
  assert.deepEqual(json[0], {
    file: 'test-0.yaml',
    line: 2,
    col: 5,
    keyPath: 'simple',
    rule: 'R3',
    severity: 'error',
    message: '"chains" is an alias of chain; aliases break generation',
    fix: {replace: 'chains', with: 'chain'},
  })
  const allowed = new Set(['file', 'line', 'col', 'keyPath', 'rule', 'severity', 'message', 'fix'])
  for (const f of json)
    assert.ok(
      Object.keys(f).every((k) => allowed.has(k)),
      JSON.stringify(f),
    )
})

test('ignore entries hide findings by key path (and rule), and say how many', () => {
  const yaml = 'lib:\n  custom:\n    - lnog_hair\n  prompt-x:\n    - lnog_hair\n'
  const r = lintYaml(yaml, {ignore: [{path: 'lib/custom', rules: ['S-branch']}, parseIgnoreArg('lib/prompt-*')]})
  assert.deepEqual(
    r.findings.map((f) => [f.keyPath, f.rule]),
    [['lib/custom', 'R1']],
  )
  assert.deepEqual(
    r.suppressed.map((s) => s.count),
    [1, 2],
  )
  assert.match(
    formatText(r),
    /ignored 1 finding\(s\) under lib\/custom \(S-branch\)\nignored 2 finding\(s\) under lib\/prompt-\* \(all rules\)$/,
  )
})

test('parseIgnoreArg validates rule names', () => {
  assert.deepEqual(parseIgnoreArg('a/**:S-branch,R1'), {path: 'a/**', rules: ['S-branch', 'R1']})
  assert.throws(() => parseIgnoreArg('a/**:R9'), /unknown rule "R9"/)
})
