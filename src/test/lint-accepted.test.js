// Accepted tags (lint.acceptedTags): no Danbooru checks or P-tags for them, syntax rules still apply; the list
// helpers; and reading activation tags from LoRA sidecars.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {applyFixes, DEFAULT_CONFIG, lintFiles, makeLintConfig, mergeAccepted, plainTags} from '../lib/lint/index.js'
import {findSidecarActivations} from '../lib/loraSidecar.js'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'
import {brief, index, lintYaml, rules} from './lint-helpers.js'

const LORA_DIR = fileURLToPath(new URL('fixtures/lint/loras/', import.meta.url))

test("the real loras.yaml: an accepted activation tag isn't an unknown tag", () => {
  const file = parseWildcardFile(fs.readFileSync(LORA_DIR + 'loras.yaml', 'utf8'), {path: 'loras.yaml'})
  const lint = (acceptedTags) => rules(lintFiles([file], index, {...DEFAULT_CONFIG, acceptedTags}))
  assert.deepEqual(lint([]), ['S-branch', 'R1'])
  assert.deepEqual(lint(['edoeraanime']), ['S-branch']) // any case
})

test('accepted tags skip R1–R4 in any written form; escaping still applies, and --fix leaves them alone', () => {
  const yaml = [
    'lib:',
    '  ill:',
    '    - edo era anime, chains, red, long_hair',
    '    - (cv4n14-style',
    '    - ((cv4n14-style))',
    '    - 1girl, @iterl1nes',
    '    - 1girl, \\@iterl1nes',
    '',
  ].join('\n')
  assert.deepEqual(rules(lintYaml(yaml)), ['R1', 'R3', 'R4', 'R1', 'R5', 'R1', 'R1', 'R6', 'R1'])

  const acceptedTags = ['Edo_Era_Anime', 'cv4n14-style', 'chains', 'RED', '@iterl1nes']
  const result = lintYaml(yaml, {acceptedTags})
  assert.deepEqual(brief(result), [
    ['R5', 'unescaped parenthesis in "(cv4n14-style": A1111 reads it as emphasis'],
    ['R6', 'unescaped "@" in "@iterl1nes": prompt-postprocessor fails on it'],
  ])

  const file = parseWildcardFile(yaml, {path: 'test-0.yaml'})
  const fixed = applyFixes(file, lintFiles([file], index, {...DEFAULT_CONFIG, acceptedTags}).findings).output
  assert.match(fixed, /- edo era anime, chains, red, long_hair\n/) // the accepted alias is not "fixed"
  assert.match(fixed, /- 1girl, \\@iterl1nes\n {4}- 1girl, \\@iterl1nes\n/)
})

test('P-tags: an accepted tag in a prose entry is not tag-like, other underscore words still are', () => {
  const yaml = [
    'shirts:',
    '  krea:',
    "    - '<lora:Style:1>, my_style_v2, A knight in dented armor, smiling at the viewer.'",
    "    - '<lora:Style:1>, my_style_v2, A knight with long_hair, smiling at the viewer.'",
    '',
  ].join('\n')
  const pTags = (acceptedTags) =>
    lintYaml(yaml, {acceptedTags})
      .findings.filter((f) => f.rule === 'P-tags')
      .map((f) => f.message)
  assert.deepEqual(pTags([]), [
    'krea entry looks like Danbooru tags (my_style_v2); write it as prose',
    'krea entry looks like Danbooru tags (my_style_v2, long_hair); write it as prose',
  ])
  assert.deepEqual(pTags(['my style v2']), ['krea entry looks like Danbooru tags (long_hair); write it as prose'])
})

test('makeLintConfig accepts acceptedTags only as a list of tags', () => {
  assert.deepEqual(makeLintConfig({acceptedTags: ['EdoEraAnime']}).acceptedTags, ['EdoEraAnime'])
  assert.deepEqual(makeLintConfig({}).acceptedTags, [])
  for (const acceptedTags of ['EdoEraAnime', ['ok', ''], [1], null]) {
    assert.throws(
      () => makeLintConfig({acceptedTags}, 'my.json'),
      /my\.json: lint\.acceptedTags must be a list of tags/,
    )
  }
})

test('mergeAccepted: one tag per written form, the first spelling kept, sorted; removing needs an accepted tag', () => {
  const list = mergeAccepted(['b', 'EdoEraAnime'], ['edoeraanime', 'A tag', 'a_tag', ' c ', ''])
  assert.deepEqual(list, ['A tag', 'b', 'c', 'EdoEraAnime'])
  assert.deepEqual(mergeAccepted(list, [], ['A_TAG', 'EDOERAANIME']), ['b', 'c'])
  assert.throws(() => mergeAccepted(list, [], ['b', 'nope', 'zip']), /^Error: Not an accepted tag: nope, zip\.$/)
})

test('plainTags: the tags of an activation text, each wildcard construct left out whole', () => {
  assert.deepEqual(plainTags('{2::pualdrons, gauntlets|1::bare arms}, EdoEraAnime'), {
    dropped: ['{2::pualdrons, gauntlets|1::bare arms}'],
    tags: ['EdoEraAnime'],
  })
  assert.deepEqual(plainTags('actress, {__own/clothes/actress/prompt-rand__|}, (cv4n14-style:1.2), \\@iterl1nes'), {
    dropped: ['{__own/clothes/actress/prompt-rand__|}'],
    tags: ['actress', 'cv4n14-style', '\\@iterl1nes'],
  })
  // a tag glued to a group, text glued to a reference, variables and LoRAs go too
  assert.deepEqual(plainTags('{~red|blue}_hair, __a/b__ suit, ${x=a}, <lora:x:1>, plain'), {
    dropped: ['{~red|blue}', '__a/b__', '${x=a}', '<lora:x:1>'],
    tags: ['plain'],
  })
  // a group left open runs to the end of the text
  assert.deepEqual(plainTags('kept, {2::pualdrons, gauntlets'), {dropped: ['{2::pualdrons, gauntlets'], tags: ['kept']})
})

test('findSidecarActivations: the activation text of the sidecars in a folder, its subfolders with recursive', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civit-sidecars-')))
  try {
    const write = (name, content) => {
      fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true})
      fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
    }

    write('A.json', {'activation text': 'EdoEraAnime, long hair', 'sd version': 'Anima'})
    write('B.json', {'activation text': '', 'sd version': 'Illustrious'}) // a sidecar without activation tags
    write('sub/C.json', {trainedWords: ['cv4n14-style', '{2::medieval, castle|ruins}']})
    write('broken.json', '{not json')
    write('other.json', {name: 'not a sidecar'})
    write('notes.txt', 'EdoEraAnime')
    fs.mkdirSync(path.join(dir, 'folder.json'))

    // the text whole, a list joined with commas, so wildcard syntax with commas in it stays intact
    const texts = (found) => found.texts.map(({file, text}) => [path.relative(dir, file), text])
    const top = findSidecarActivations(dir)
    assert.equal(top.sidecars, 2)
    assert.deepEqual(texts(top), [['A.json', 'EdoEraAnime, long hair']])

    const all = findSidecarActivations(dir, {recursive: true})
    assert.equal(all.sidecars, 3)
    assert.deepEqual(texts(all).at(-1), [path.join('sub', 'C.json'), 'cv4n14-style, {2::medieval, castle|ruins}'])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
