import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {
  createJsonMetadata,
  extractWeightFromText,
  findWeightHint,
  formatXyzValues,
  getPreferredWeight,
  makePrompt,
  mergeSidecar,
  fixLoraName,
  nameProblems,
  planBaseSort,
  planNameFixes,
} from '../commands/lora/activation.js'
import {baseModelFolder} from '../lib/baseModels.js'
import {homeConfigPath, saveHomeSetting} from '../lib/config.js'
import {stripHtml} from '../lib/text.js'

// Real model description of "Edo Era Anime" (model 572988), as returned by
// GET /api/v1/models/572988. No "Strength:" label anywhere -- the hint is
// prose with a range above 1.
const EDO_ERA_DESCRIPTION =
  '<p>Works great in the 0.2 - 1.2 range, depending on the Lora Stack you use.</p>' +
  '<p>The training images are really sharp , so you can go pretty high and still get a coherent images.</p>' +
  '<p>Above 1.2 everything starts getting abstract for <strong>SDXL/Pony</strong>.<br /><strong>Flux </strong>works without any issues up to 1.5<br /></p>' +
  '<p>I recommend starting in the 0.8 - 1 range on all versions.</p>'

// Phrasings taken from real Civitai LoRA descriptions.
const REAL_PHRASES = [
  ['I recommend starting in the 0.8 - 1 range on all versions.', 0.9],
  ['The strength of Lora is recommended to be 0.4~0.6.', 0.5],
  ['pony The strength of Lora is recommended to be around 0.8. XL The', 0.8],
  ['--Qwen2.1 Use at 0.7 strength -- Z-image I generate with res2s_ode', 0.7],
  ['Krea 2 version: weight between [0.8,1], best at 1 trigger words : retro_scifi_90s_an', 1],
  ['Flux: Trigger word: DeathW40K Works on: 0.6-1 weights, I prefer 0.9', 0.9],
  ['Handles higher strength. Up to 2.0 is recommended. 1.5 is the sweet spot', 1.5],
  ['good with Lenovo lora and nsfw loras. recommended weight 0.6-0.8', 0.7],
  ['recommended weight 0.8 for raw and 1.2-2 for turbo', 0.8],
  ['Generation Settings Weight: 0.6-0.8 Krea_V2_Pro Trigger: no trigger', 0.7],
  ['best settings: 4-6 steps, er_sde/euler, simple, Strength 0.75', 0.75],
  ['Recommended strength: 0.7-0.9', 0.8],
  ['Strength 0.9 works best', 0.9],
]

for (const [text, expected] of REAL_PHRASES) {
  test(`extractWeightFromText: "${text}" -> ${expected}`, () => {
    assert.equal(extractWeightFromText(text), expected)
  })
}

// Numbers next to unrelated settings or version names must not be read as weights.
const NON_WEIGHTS = [
  'QW21 -Turbo-0.1 by Viggle Steps 4-16 CFG=1 T2i/i2i',
  'Recommended settings: Steps: 25-40 CFG scale: 5-7 Strength – Varies',
  'which is still trained from base anima 1.0 , with a fix of a dataset errors',
  'the model was merged with the v4.0 weights via SVD fusion',
  'Recommended LoRA Strength: please see the info card for your version',
]

for (const text of NON_WEIGHTS) {
  test(`extractWeightFromText ignores: "${text}"`, () => {
    assert.equal(extractWeightFromText(text), null)
  })
}

test('findWeightHint reports the range bounds alongside the midpoint', () => {
  assert.deepEqual(findWeightHint('The strength of Lora is recommended to be 0.4~0.6.'), {max: 0.6, min: 0.4, weight: 0.5})
})

test('the real Edo Era model description resolves to the recommended range midpoint', () => {
  const result = getPreferredWeight({description: null}, {description: EDO_ERA_DESCRIPTION}, null)

  assert.equal(result.weight, 0.9)
  assert.equal(result.source, 'model description')
  assert.equal(stripHtml(EDO_ERA_DESCRIPTION).includes('<'), false)
})

test('getPreferredWeight prefers settings.strength over description text', () => {
  // Real tRPC settings for Edo Era Anime, version 3271798.
  const result = getPreferredWeight({description: null}, {description: EDO_ERA_DESCRIPTION}, {maxStrength: 1.2, strength: 0.9})

  assert.equal(result.weight, 0.9)
  assert.equal(result.source, 'civitai settings (usage tips)')
  assert.equal(result.max, 1.2)
  assert.equal(result.note, null)
})

test('getPreferredWeight uses the midpoint when settings only has min/max', () => {
  const result = getPreferredWeight({}, null, {maxStrength: 2, minStrength: 1})

  assert.equal(result.weight, 1.5)
  assert.equal(result.source, 'civitai settings range (midpoint)')
})

test('a bare settings.strength of 1 is overridden by a description hint, with a note', () => {
  const result = getPreferredWeight(
    {description: '<p>The strength of Lora is recommended to be 0.4~0.6.</p>'},
    null,
    {strength: 1},
  )

  assert.equal(result.weight, 0.5)
  assert.equal(result.source, 'model-version description (overrode settings.strength=1)')
  assert.match(result.note, /strength 1/)
})

test('settings.strength of 1 with a min/max range is trusted, not treated as the upload default', () => {
  const result = getPreferredWeight({description: 'recommended weight 0.6'}, null, {maxStrength: 1, minStrength: 1, strength: 1})

  assert.equal(result.weight, 1)
  assert.equal(result.source, 'civitai settings (usage tips)')
})

test('a bare settings.strength of 1 is kept when no text hint exists', () => {
  const result = getPreferredWeight({description: 'A cool style LoRA.'}, null, {strength: 1})

  assert.equal(result.weight, 1)
  assert.equal(result.source, 'civitai settings (usage tips)')
  assert.equal(result.note, null)
})

test('getPreferredWeight falls back to the labeled default when nothing is found anywhere', () => {
  const result = getPreferredWeight({description: 'A cool anime style LoRA, no usage notes.'}, {description: null}, {})

  assert.equal(result.weight, 1)
  assert.equal(result.source, 'default (not found)')
})

test('mergeSidecar refreshes Civitai fields but keeps hand-edited ones', () => {
  const existing = {
    'activation text': 'my custom trigger',
    'civitai model name': 'Old Name',
    'my own key': 'keep me',
    'negative text': 'lowres',
    notes: 'great with style X',
    'preferred weight': 1,
    'preferred weight max': 1.5,
    'preferred weight source': 'default (not found)',
  }
  const fresh = {
    'activation text': 'EdoEraAnime',
    'civitai model name': 'Edo Era Anime',
    'negative text': '',
    notes: '',
    'preferred weight': 0.9,
    'preferred weight source': 'civitai settings (usage tips)',
  }

  const {kept, sidecar} = mergeSidecar(existing, fresh)

  assert.equal(sidecar['preferred weight'], 0.9)
  assert.equal(sidecar['preferred weight source'], 'civitai settings (usage tips)')
  assert.equal(sidecar['preferred weight max'], undefined, 'stale derived fields are dropped')
  assert.equal(sidecar['civitai model name'], 'Edo Era Anime')
  assert.equal(sidecar['activation text'], 'my custom trigger')
  assert.equal(sidecar['negative text'], 'lowres')
  assert.equal(sidecar.notes, 'great with style X')
  assert.equal(sidecar['my own key'], 'keep me')
  assert.deepEqual(kept, ['activation text', 'negative text', 'notes'])
})

test("mergeSidecar adds the model page link to the user's notes, unless they link the model already", () => {
  const fresh = {'civitai model id': 572988, notes: 'https://civitai.red/models/572988/edo-era-anime'}
  const notes = (existing) => mergeSidecar({notes: existing}, fresh).sidecar.notes

  assert.equal(notes(''), 'https://civitai.red/models/572988/edo-era-anime')
  assert.equal(notes('great with style X'), 'great with style X\nhttps://civitai.red/models/572988/edo-era-anime')
  assert.equal(notes('see https://civitai.com/models/572988?modelVersionId=1'), 'see https://civitai.com/models/572988?modelVersionId=1')
  assert.equal(mergeSidecar({}, fresh).sidecar.notes, 'https://civitai.red/models/572988/edo-era-anime')
})

test('mergeSidecar takes fresh activation text when the existing one is empty', () => {
  const {kept, sidecar} = mergeSidecar({'activation text': ''}, {'activation text': 'EdoEraAnime'})

  assert.equal(sidecar['activation text'], 'EdoEraAnime')
  assert.deepEqual(kept, [])
})

// Contract with wc lint: its rule S-base reads "sd version" from these sidecars
// (src/lib/lint/rules/lora.js). Real values of "Edo Era Anime" (model 572988, version 3271798).
test('createJsonMetadata writes "sd version" from Civitai baseModel (read by wc lint S-base)', () => {
  const discovery = {
    data: {baseModel: 'Anima', trainedWords: ['EdoEraAnime']},
    modelData: {name: 'Edo Era Anime'},
    modelId: 572988,
    modelVersionId: 3271798,
    source: 'SHA256 -> Civitai /by-hash',
  }
  const weight = {max: 1.2, min: null, source: 'civitai settings (usage tips)', weight: 0.9}

  const sidecar = createJsonMetadata(discovery, 'EdoEraAnimeAnima.safetensors', 'civitai.red', weight)

  assert.equal(sidecar['sd version'], 'Anima')
  assert.equal(typeof sidecar['sd version'], 'string')
  // the notes link to the model's page, on the domain that had the LoRA
  assert.equal(sidecar.notes, 'https://civitai.red/models/572988/edo-era-anime')
  assert.equal(sidecar['civitai url'], 'https://civitai.red/models/572988?modelVersionId=3271798')
  assert.equal(createJsonMetadata({...discovery, data: {}}, 'x.safetensors', 'civitai.red', weight)['sd version'], 'Unknown')
})

test('formatXyzValues: each LoRA prompt in double quotes, comma-separated, for X/Y/Z plot', () => {
  const prompts = [
    makePrompt('CastlevaniaTV-ANIMA.safetensors', {'activation text': 'cv4n14-style', 'preferred weight': 1}),
    makePrompt('Dawnmap Anima.safetensors', {'activation text': 'medieval', 'preferred weight': 1}),
    makePrompt('IterL1nesV2.safetensors', {'activation text': '@iterl1nes', 'preferred weight': 1}),
  ]
  assert.equal(
    formatXyzValues(prompts),
    '"<lora:CastlevaniaTV-ANIMA:1>, cv4n14-style,","<lora:Dawnmap Anima:1>, medieval,","<lora:IterL1nesV2:1>, @iterl1nes,"',
  )
  assert.equal(formatXyzValues(['<lora:a:1>, "quoted",']), '"<lora:a:1>, ""quoted"","', 'quotes are doubled, as CSV')
  assert.equal(formatXyzValues([makePrompt('NoTrigger.safetensors', {'preferred weight': 0.8})]), '"<lora:NoTrigger:0.8>,"')
})

test('planNameFixes: "__" LoRAs with their own companion files, not a longer name\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-activation-'))
  try {
    const names = ['my__style.safetensors', 'my__style.json', 'my__style.preview.png', 'my__style.v2.safetensors']
    for (const name of [...names, 'my__style.v2.json', 'a___b.safetensors', 'ok.safetensors', 'ok.json']) {
      fs.writeFileSync(path.join(dir, name), '')
    }

    const loras = ['a___b.safetensors', 'my__style.safetensors', 'my__style.v2.safetensors', 'ok.safetensors']
    const groups = planNameFixes(dir, loras.map((name) => path.join(dir, name)))
    const brief = groups.map((g) => [g.lora, g.items.map((item) => `${item.oldName} -> ${item.newName}`)])

    assert.deepEqual(brief, [
      ['a___b.safetensors', ['a___b.safetensors -> a_b.safetensors']],
      [
        'my__style.safetensors',
        [
          'my__style.safetensors -> my_style.safetensors',
          'my__style.json -> my_style.json',
          'my__style.preview.png -> my_style.preview.png',
        ],
      ],
      [
        'my__style.v2.safetensors',
        ['my__style.v2.safetensors -> my_style.v2.safetensors', 'my__style.v2.json -> my_style.v2.json'],
      ],
    ])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('nameProblems and fixLoraName: "__" and warn characters, removed and tidied', () => {
  assert.deepEqual(nameProblems('Rock & Roll__v2@x', '@&'), ['"__"', '"@"', '"&"'])
  assert.deepEqual(nameProblems('plain_name', '@&'), [])
  assert.equal(fixLoraName('Rock & Roll__v2', '@&'), 'Rock Roll_v2')
  assert.equal(fixLoraName('IterL1nes@V2', '@&'), 'IterL1nesV2')
  assert.equal(fixLoraName('a_&_b', '@&'), 'a_b', 'removing a character can create "__", which is fixed too')
  assert.equal(fixLoraName('@&', '@&'), '')
  assert.equal(fixLoraName('a#b', '@&'), 'a#b', 'only the listed characters are removed')
})

test('planNameFixes with warn characters renames the LoRA and its files without them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-activation-'))
  try {
    for (const name of ['Iter@Lines.safetensors', 'Iter@Lines.json', 'ok.safetensors', '@&.safetensors']) {
      fs.writeFileSync(path.join(dir, name), '')
    }

    const loras = ['@&.safetensors', 'Iter@Lines.safetensors', 'ok.safetensors'].map((n) => path.join(dir, n))
    const groups = planNameFixes(dir, loras, '@&')
    assert.deepEqual(
      groups.map((g) => [g.lora, g.name, g.problems, g.items.map((item) => item.newName)]),
      [
        ['@&.safetensors', '', ['"@"', '"&"'], ['.safetensors']],
        ['Iter@Lines.safetensors', 'IterLines', ['"@"'], ['IterLines.safetensors', 'IterLines.json']],
      ],
    )
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('saveHomeSetting saves, keeps other settings, removes with undefined, and never overwrites broken JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-home-'))
  try {
    fs.writeFileSync(homeConfigPath(home), JSON.stringify({domain: 'civitai.red'}))
    saveHomeSetting('warnChars', '@&#', home)
    assert.deepEqual(JSON.parse(fs.readFileSync(homeConfigPath(home), 'utf8')), {domain: 'civitai.red', warnChars: '@&#'})
    saveHomeSetting('warnChars', undefined, home)
    assert.deepEqual(JSON.parse(fs.readFileSync(homeConfigPath(home), 'utf8')), {domain: 'civitai.red'})

    fs.writeFileSync(homeConfigPath(home), '{"domain": ')
    assert.throws(() => saveHomeSetting('warnChars', '@', home), /not valid JSON/)
    assert.equal(fs.readFileSync(homeConfigPath(home), 'utf8'), '{"domain": ')
  } finally {
    fs.rmSync(home, {force: true, recursive: true})
  }
})

test('baseModelFolder: Civitai and Forge base model names to generic family folders', () => {
  const cases = [
    ['Illustrious', 'illustrious'],
    ['NoobAI', 'illustrious'],
    ['Pony', 'pony'],
    ['Pony V7', 'pony'],
    ['Anima', 'anima'],
    ['Krea 2', 'krea'],
    ['Flux.1 D', 'flux'],
    ['Flux.2 Klein 9B-base', 'flux2'],
    ['SDXL 1.0', 'sdxl'],
    ['SDXL Hyper', 'sdxl'],
    ['SD 1.5', 'sd15'],
    ['SD1', 'sd15'], // Forge's own sidecars
    ['SD 2.1 768', 'sd2'],
    ['ZImageTurbo', 'zimage'],
    ['Qwen 2.1', 'qwen'],
    ['Wan Video 2.2 T2V-A14B', 'wan'],
    ['Other', null],
    ['Unknown', null],
    ['ACE Audio', null],
    [undefined, null],
  ]
  assert.deepEqual(
    cases.map(([name]) => [name, baseModelFolder(name)]),
    cases,
  )
})

test('planBaseSort: one folder per family, companion files move along, unknown base models stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-activation-'))
  try {
    const files = ['a.safetensors', 'a.json', 'a.preview.png', 'a.v2.safetensors', 'b.safetensors', 'c.safetensors']
    for (const name of [...files, 'd.safetensors', 'loras.yaml', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '')
    const lora = (name, baseModel) => ({baseModel, file: path.join(dir, name)})

    const plan = planBaseSort(
      dir,
      [
        lora('a.safetensors', 'NoobAI'),
        lora('a.v2.safetensors', 'Illustrious'),
        lora('b.safetensors', 'Anima'),
        lora('c.safetensors', 'Other'),
        lora('d.safetensors', undefined),
      ],
      ['loras.yaml'],
    )

    assert.deepEqual([...plan.families], [
      ['anima', 1],
      ['illustrious', 2],
    ])
    assert.deepEqual(
      plan.moves.map((move) => [move.lora, move.folder, move.items.map((item) => path.relative(dir, item.newPath))]),
      [
        ['a.safetensors', 'illustrious', ['illustrious/a.safetensors', 'illustrious/a.json', 'illustrious/a.preview.png'].map(path.normalize)],
        ['a.v2.safetensors', 'illustrious', [path.normalize('illustrious/a.v2.safetensors')]],
        ['b.safetensors', 'anima', [path.normalize('anima/b.safetensors')]],
      ],
    )
    assert.deepEqual(plan.unknown, [
      {baseModel: 'Other', lora: 'c.safetensors'},
      {baseModel: null, lora: 'd.safetensors'},
    ])

    // one family: nothing to sort
    assert.equal(planBaseSort(dir, [lora('a.safetensors', 'Pony'), lora('b.safetensors', 'Pony V7')]).families.size, 1)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
