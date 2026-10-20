// img loras: which LoRAs a folder of images used, ranked by how many images use each.

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {collectImageMetadata} from '../lib/imageMeta.js'
import {extractLoras, formatWeights, rankLoras} from '../lib/loraUsage.js'
import {jpeg, png, tEXt, tiffWithUserComment, webp} from './image-helpers.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')

// Forge's parameters text, as in the real images: the prompt, then the settings line with Lora hashes
const forge = (prompt, hashes) =>
  `${prompt}\nNegative prompt: lowres\nSteps: 30, Sampler: Euler a, CFG scale: 5, Seed: 1, Lora hashes: "${hashes}", Version: f2.0.1`

const entry = (prompt, hashes = '', other) => ({
  file: 'x.png',
  prompt,
  negativePrompt: 'lowres',
  settings: hashes ? {'Lora hashes': hashes} : {},
  ...(other ? {other} : {}),
})

test('extractLoras: prompt tags with weights, a missing weight is 1, lyco too', () => {
  const {loras, duplicates} = extractLoras(
    entry('1girl, <lora:Hata4564:0.6>, <lora:iLLMythD4rkL1nes:0.7:0.5> <lyco:MinimalStyle> smile'),
  )
  assert.deepEqual(loras, [
    {name: 'Hata4564', weight: 0.6},
    {name: 'iLLMythD4rkL1nes', weight: 0.7},
    {name: 'MinimalStyle', weight: 1},
  ])
  assert.deepEqual(duplicates, [])
})

test('extractLoras: a LoRA only in Lora hashes counts, with an unknown weight', () => {
  const {loras} = extractLoras(entry('<lora:guildwar:1>', 'guildwar: ebc1452e8dc2, hidden: 0123456789ab'))
  assert.deepEqual(loras, [
    {name: 'guildwar', weight: 1},
    {name: 'hidden', weight: null},
  ])
})

test('extractLoras: the same LoRA twice in one prompt is a duplicate (case-insensitive), listed once', () => {
  const {loras, duplicates} = extractLoras(entry('<lora:Style:1>, girl, <lora:style:0.5>, <lora:Other:1>'))
  assert.deepEqual(loras, [
    {name: 'Style', weight: 1},
    {name: 'Other', weight: 1},
  ])
  assert.deepEqual(duplicates, ['Style'])
})

test('extractLoras: ComfyUI loader nodes, by file name without folder and extension', () => {
  const graph = {
    3: {class_type: 'KSampler', inputs: {seed: 1}},
    10: {class_type: 'LoraLoader', inputs: {lora_name: 'styles\\PaintedWorldv2.safetensors', strength_model: 0.8}},
    11: {class_type: 'LoraLoaderModelOnly', inputs: {lora_name: 'krea/ektafadeV1.safetensors', strength_model: 0.6}},
    12: {
      class_type: 'Power Lora Loader (rgthree)',
      inputs: {
        lora_1: {on: true, lora: 'Hata4564.safetensors', strength: 0.5},
        lora_2: {on: false, lora: 'Off.safetensors', strength: 1},
      },
    },
  }
  const {loras, duplicates} = extractLoras(entry(null, '', {prompt: JSON.stringify(graph)}))
  assert.deepEqual(loras, [
    {name: 'PaintedWorldv2', weight: 0.8},
    {name: 'ektafadeV1', weight: 0.6},
    {name: 'Hata4564', weight: 0.5},
  ])
  assert.deepEqual(duplicates, [])

  // two loaders of the same LoRA are a duplicate too
  const twice = {...graph, 13: {class_type: 'LoraLoader', inputs: {lora_name: 'PaintedWorldv2.safetensors'}}}
  assert.deepEqual(extractLoras(entry(null, '', {prompt: JSON.stringify(twice)})).duplicates, ['PaintedWorldv2'])
  // an upscale-only graph (like the real ComfyUI test image) or broken JSON has none
  assert.deepEqual(extractLoras(entry(null, '', {prompt: '{"6": {"inputs": {"value": "2x"}}}'})).loras, [])
  assert.deepEqual(extractLoras(entry(null, '', {prompt: 'not json'})).loras, [])
})

test('rankLoras: by image count, ties by name; spelling and weights by frequency', () => {
  const entries = [
    entry('<lora:Style:1>, <lora:B:0.5>'),
    entry('<lora:style:0.8>, <lora:A:1>'),
    entry('<lora:Style:1>'),
    entry('<lora:B:0.5>', 'B: 1234, A: 5678'),
    entry('no loras here'),
  ]
  const {ranking, withLoras, duplicates} = rankLoras(entries)
  assert.deepEqual(ranking, [
    {
      name: 'Style',
      images: 3,
      weights: [
        {weight: 1, count: 2},
        {weight: 0.8, count: 1},
      ],
    },
    {
      name: 'A',
      images: 2,
      weights: [
        {weight: 1, count: 1},
        {weight: null, count: 1},
      ],
    },
    {name: 'B', images: 2, weights: [{weight: 0.5, count: 2}]},
  ])
  assert.equal(withLoras, 4)
  assert.deepEqual(duplicates, [])
  assert.equal(formatWeights(ranking[1].weights), '1 ×1, ? ×1')
})

function makeFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-loras-'))
  fs.writeFileSync(path.join(dir, 'a.png'), png([tEXt('parameters', forge('<lora:Style:1>, girl', 'Style: 1'))]))
  fs.writeFileSync(path.join(dir, 'b.jpg'), jpeg(tiffWithUserComment(forge('<lora:Style:0.8>, <lora:Ink:1>', 'x'))))
  fs.writeFileSync(path.join(dir, 'c.webp'), webp(tiffWithUserComment(forge('<lora:Ink:1>, <lora:ink:0.5>', 'x'))))
  fs.writeFileSync(path.join(dir, 'plain.png'), png([]))
  fs.mkdirSync(path.join(dir, 'waiANIMA'))
  fs.writeFileSync(path.join(dir, 'waiANIMA', 'd.png'), png([tEXt('parameters', forge('<lora:Deep:1>', 'x'))]))
  return dir
}

test('collectImageMetadata --recursive reads subfolders, named by relative path', () => {
  const dir = makeFolder()
  try {
    assert.deepEqual(
      collectImageMetadata(dir).entries.map((e) => e.file),
      ['a.png', 'b.jpg', 'c.webp'],
    )
    assert.deepEqual(
      collectImageMetadata(dir, {recursive: true}).entries.map((e) => e.file),
      ['a.png', 'b.jpg', 'c.webp', path.join('waiANIMA', 'd.png')],
    )
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('img loras: the table, the duplicate error and exit code 1; -r; --json; a missing folder', () => {
  const dir = makeFolder()
  try {
    const run = (...args) => spawnSync(process.execPath, [BIN, 'img', 'loras', ...args], {cwd: dir, encoding: 'utf8'})

    const text = run('.')
    assert.equal(text.status, 1) // c.webp has Ink twice
    assert.deepEqual(text.stdout.trim().split('\n').slice(1), [
      'images:  4 (3 with metadata, 3 with LoRAs)',
      '1 image(s) had no metadata: plain.png',
      '',
      '#  images  share  weights       LoRA',
      '1       2    67%  1 ×2          Ink',
      '2       2    67%  0.8 ×1, 1 ×1  Style', // equal counts: the lower weight first
    ])
    assert.match(text.stderr, /error: the same LoRA more than once in one prompt \(1 image\(s\)\):\n {2}c\.webp: Ink/)

    const json = JSON.parse(run('.', '-r', '--json', '--top', '2').stdout)
    assert.deepEqual(
      [json.images, json.withMetadata, json.withLoras, json.ranking.map((r) => [r.rank, r.name, r.images, r.share])],
      [
        5,
        4,
        4,
        [
          [1, 'Ink', 2, 50],
          [2, 'Style', 2, 50],
        ],
      ],
    )
    assert.deepEqual(json.duplicates, [{file: 'c.webp', loras: ['Ink']}])

    assert.equal(run('missing').status, 2)
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})
