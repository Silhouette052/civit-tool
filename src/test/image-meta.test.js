import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import zlib from 'node:zlib'

import {collectImageMetadata, parseParameters, promptLine, readImageTexts} from '../lib/imageMeta.js'

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

// --- tiny image builders (the reader skips CRCs and image data, but the files are still valid) ---

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes) => {
  let c = 0xff_ff_ff_ff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xff_ff_ff_ff) >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

function png(chunks) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth; colour type 0 (grey)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...chunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const tEXt = (key, text) =>
  pngChunk('tEXt', Buffer.concat([Buffer.from(`${key}\0`, 'latin1'), Buffer.from(text, 'latin1')]))
const iTXt = (key, text) =>
  pngChunk(
    'iTXt',
    Buffer.concat([Buffer.from(`${key}\0\x01\0\0\0`, 'latin1'), zlib.deflateSync(Buffer.from(text, 'utf8'))]),
  )

/** A TIFF block: IFD0 -> Exif IFD -> UserComment (UNICODE, UTF-16 in the given byte order). */
function tiffWithUserComment(text, {little = false} = {}) {
  const body = Buffer.from(text, 'utf16le')
  if (!little) body.swap16()
  const comment = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), body])

  const tiff = Buffer.alloc(8 + 18 + 18 + comment.length)
  const u16 = (value, at) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at))
  const u32 = (value, at) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at))
  tiff.write(little ? 'II' : 'MM', 0, 'latin1')
  u16(42, 2)
  u32(8, 4)
  // IFD0 at 8: one entry, the Exif IFD pointer (LONG) to 26
  u16(1, 8)
  u16(0x87_69, 10)
  u16(4, 12)
  u32(1, 14)
  u32(26, 18)
  u32(0, 22)
  // Exif IFD at 26: UserComment (UNDEFINED) with its data at 44
  u16(1, 26)
  u16(0x92_86, 28)
  u16(7, 30)
  u32(comment.length, 32)
  u32(44, 36)
  u32(0, 40)
  comment.copy(tiff, 44)
  return tiff
}

function jpeg(tiff) {
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const length = Buffer.alloc(2)
  length.writeUInt16BE(app1.length + 2)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    app1,
    Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
  ])
}

function webp(tiff) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32LE(data.length, 4)
    return Buffer.concat([head, data, Buffer.alloc(data.length % 2)])
  }

  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    chunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])),
    chunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])),
  ])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
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
