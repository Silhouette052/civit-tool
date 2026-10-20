import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {collectImageMetadata, parseParameters, promptLine, readImageTexts} from '../lib/imageMeta.js'
import {iTXt, jpeg, png, tEXt, tiffWithUserComment, webp} from './image-helpers.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')

// a real Forge Neo parameters text, shortened
const PARAMETERS = `masterpiece, best quality, 1girl, silver hair,
<lora:EdoEraAnimeAnima:0.8>, edo period, kimono
Negative prompt: lowres, bad hands,
watermark
Steps: 30, Sampler: Euler a, Schedule type: Automatic, CFG scale: 5, Seed: 2447751738, Size: 832x1216, Model hash: 1b2c3d4e5f, Model: waiANIMA_v10Base10, Denoising strength: 0.6, Lora hashes: "EdoEraAnimeAnima: 9f8e7d6c5b4a, other: 0123", Version: f2.0.1v1.10.1`

const SETTINGS = {
  'CFG scale': '5',
  'Denoising strength': '0.6',
  'Lora hashes': 'EdoEraAnimeAnima: 9f8e7d6c5b4a, other: 0123',
  Model: 'waiANIMA_v10Base10',
  'Model hash': '1b2c3d4e5f',
  Sampler: 'Euler a',
  'Schedule type': 'Automatic',
  Seed: '2447751738',
  Size: '832x1216',
  Steps: '30',
  Version: 'f2.0.1v1.10.1',
}

// --- parsing ---

test('parseParameters splits prompt, negative prompt and settings; quoted values keep their commas', () => {
  assert.deepEqual(parseParameters(PARAMETERS), {
    negativePrompt: 'lowres, bad hands,\nwatermark',
    prompt: 'masterpiece, best quality, 1girl, silver hair,\n<lora:EdoEraAnimeAnima:0.8>, edo period, kimono',
    settings: SETTINGS,
  })
})

test('parseParameters: no negative prompt, no settings line, and a prompt with colons', () => {
  assert.deepEqual(parseParameters('a cat\nSteps: 20, Sampler: Euler, Seed: 1'), {
    negativePrompt: '',
    prompt: 'a cat',
    settings: {Sampler: 'Euler', Seed: '1', Steps: '20'},
  })
  assert.deepEqual(parseParameters('(masterpiece:1.2), style: ink, lighting: soft'), {
    negativePrompt: '',
    prompt: '(masterpiece:1.2), style: ink, lighting: soft',
    settings: {},
  })
  // Forge leaves a blank line before "Negative prompt:" when the prompt ends with a newline
  assert.deepEqual(parseParameters('a cat,\n\nNegative prompt: lowres\nSteps: 20, Sampler: Euler, Seed: 1'), {
    negativePrompt: 'lowres',
    prompt: 'a cat,',
    settings: {Sampler: 'Euler', Seed: '1', Steps: '20'},
  })
})

test('promptLine puts a multi-line prompt on one line', () => {
  assert.equal(promptLine('a,\n  b,\r\nc'), 'a, b, c')
})

// --- reading ---

test('PNG: tEXt and compressed iTXt give the same parameters; other chunks are kept', () => {
  assert.deepEqual(readImageTexts(png([tEXt('parameters', PARAMETERS)])), {parameters: PARAMETERS})
  const unicode = `${PARAMETERS.replace('kimono', 'kimono, 着物')}`
  assert.deepEqual(readImageTexts(png([iTXt('parameters', unicode), tEXt('workflow', '{"a":1}')])), {
    parameters: unicode,
    workflow: '{"a":1}',
  })
  assert.deepEqual(readImageTexts(png([])), {})
})

test('JPEG and WebP: the EXIF UserComment in either UTF-16 byte order', () => {
  assert.deepEqual(readImageTexts(jpeg(tiffWithUserComment(PARAMETERS))), {parameters: PARAMETERS})
  assert.deepEqual(readImageTexts(jpeg(tiffWithUserComment(PARAMETERS, {little: true}))), {parameters: PARAMETERS})
  assert.deepEqual(readImageTexts(webp(tiffWithUserComment(PARAMETERS))), {parameters: PARAMETERS})
})

test('a file that is not an image is an error', () => {
  assert.throws(() => readImageTexts(Buffer.from('hello')), /not a PNG, JPEG or WebP/)
})

// --- folder + command ---

function makeFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-meta-'))
  fs.writeFileSync(path.join(dir, 'b10.png'), png([tEXt('parameters', PARAMETERS)]))
  fs.writeFileSync(path.join(dir, 'b2.jpg'), jpeg(tiffWithUserComment('a dog\nSteps: 20, Sampler: Euler, Seed: 7')))
  fs.writeFileSync(path.join(dir, 'c.webp'), webp(tiffWithUserComment('a bird\nSteps: 20, Sampler: Euler, Seed: 8')))
  fs.writeFileSync(path.join(dir, 'comfy.png'), png([tEXt('workflow', '{"nodes":[]}')]))
  fs.writeFileSync(path.join(dir, 'plain.png'), png([]))
  fs.writeFileSync(path.join(dir, 'broken.png'), Buffer.from('not a png'))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'deep.png'), png([tEXt('parameters', 'deep')]))
  return dir
}

test('collectImageMetadata: natural order, missing and broken files reported, subfolders skipped', () => {
  const dir = makeFolder()
  const {entries, failed, missing, total} = collectImageMetadata(dir)
  assert.equal(total, 6)
  assert.deepEqual(
    entries.map((entry) => entry.file),
    ['b2.jpg', 'b10.png', 'c.webp', 'comfy.png'],
  )
  assert.deepEqual(entries[1], {
    file: 'b10.png',
    negativePrompt: 'lowres, bad hands,\nwatermark',
    parameters: PARAMETERS,
    prompt: 'masterpiece, best quality, 1girl, silver hair,\n<lora:EdoEraAnimeAnima:0.8>, edo period, kimono',
    settings: SETTINGS,
  })
  assert.deepEqual(entries[3], {
    file: 'comfy.png',
    negativePrompt: null,
    other: {workflow: '{"nodes":[]}'},
    parameters: null,
    prompt: null,
    settings: {},
  })
  assert.deepEqual(missing, ['plain.png'])
  assert.deepEqual(
    failed.map((f) => f.file),
    ['broken.png'],
  )
  fs.rmSync(dir, {force: true, recursive: true})
})

test('img meta writes metadata.json, --prompt writes prompts.txt, --stdout writes no file', () => {
  const dir = makeFolder()
  const run = (...args) => execFileSync('node', [BIN, 'img', 'meta', dir, ...args], {encoding: 'utf8', stdio: 'pipe'})

  run()
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'))
  assert.deepEqual(
    json.map((entry) => entry.file),
    ['b2.jpg', 'b10.png', 'c.webp', 'comfy.png'],
  )

  // comfy.png has metadata but no prompt, so it has no line
  const prompts =
    'a dog\nmasterpiece, best quality, 1girl, silver hair, <lora:EdoEraAnimeAnima:0.8>, edo period, kimono\na bird\n'
  run('--prompt')
  assert.equal(fs.readFileSync(path.join(dir, 'prompts.txt'), 'utf8'), prompts)

  fs.rmSync(path.join(dir, 'prompts.txt'))
  assert.equal(run('--prompt', '--stdout'), prompts)
  assert.equal(fs.existsSync(path.join(dir, 'prompts.txt')), false, '--stdout writes no file')
  assert.deepEqual(JSON.parse(run('--stdout')), json, 'only the JSON goes to stdout')
  assert.deepEqual(Object.keys(json[1]), ['file', 'prompt', 'negativePrompt', 'settings', 'parameters'])
  fs.rmSync(dir, {force: true, recursive: true})
})
