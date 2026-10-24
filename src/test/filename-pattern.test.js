// Forge's filename pattern as a matcher (img sort) and its example names (img config).

import assert from 'node:assert/strict'
import {test} from 'node:test'

import {compileFilenamePattern, exampleName, imageNaming} from '../lib/filenamePattern.js'

const modelOf = (pattern, name, options) => compileFilenamePattern(pattern, options).parse(name)?.model ?? null

test("the user's pattern: [seed]_[denoising]_[model_name]_[datetime], with or without the denoising value", () => {
  const pattern = '[seed]_[denoising]_[model_name]_[datetime]'
  assert.equal(modelOf(pattern, '2447751738_0.6_waiANIMA_v10Base10_20260929160902.png'), 'waiANIMA_v10Base10')
  assert.equal(modelOf(pattern, '12345_.75_ponyV6_20260101120000.webp'), 'ponyV6')
  // no denoising strength: Forge drops the value and the _ before it
  assert.equal(modelOf(pattern, '2447751738_waiANIMA_v10Base10_20260929160902.png'), 'waiANIMA_v10Base10')
  assert.equal(modelOf(pattern, '2447751738_0.6_waiANIMA_2026092916.png'), null) // the date has 14 digits
  assert.equal(modelOf(pattern, '00042-2447751738_0.6_waiANIMA_20260929160902.png'), null) // a number it doesn't expect
})

test('the ascending number: a counter of 5 or more digits and a dash before the name', () => {
  const pattern = '[model_name]-[seed]'
  assert.equal(modelOf(pattern, '00042-my model v2-12345.png', {addNumber: true}), 'my model v2')
  assert.equal(modelOf(pattern, '100000-ill_xl-99.png', {addNumber: true}), 'ill_xl')
  assert.equal(modelOf(pattern, 'my model v2-12345.png', {addNumber: true}), null)
  assert.equal(modelOf(pattern, 'my model v2-12345.png'), 'my model v2')
})

test('dates, hashes, free text, tags in any case, unknown tags and regex characters in the pattern', () => {
  // a datetime format: : can't be in a file name, so Forge writes _
  assert.equal(
    modelOf('[datetime<%Y-%m-%d_%H:%M:%S>] [Model_Name] [seed]', '2026-09-29_16_09_02 waiANIMA 2447751738.png'),
    'waiANIMA',
  )
  assert.equal(modelOf('[date]_[model_name]_[prompt_hash<6>]', '2026-09-29_ill xl_a1b2c3.png'), 'ill xl')
  assert.equal(modelOf('[prompt]_[seed]_[model_name]_[date]', '1girl,_solo_123_ill xl_2026-09-29.png'), 'ill xl')
  // Forge keeps a tag it doesn't know as written; ( and . in the pattern are plain text
  assert.equal(modelOf('[seed]_(v2).[model_name]_[foo<x>]', '1_(v2).modelA_[foo].png'), 'modelA')
  assert.equal(modelOf('[seed]_(v2).[model_name]', '1_xv2y.modelA.png'), null)
})

test('a pattern without [model_name], or an empty one, is refused', () => {
  assert.throws(() => compileFilenamePattern('[seed]_[datetime]'), /needs \[model_name\]/)
  assert.throws(() => compileFilenamePattern('  '), /empty/)
})

test('exampleName: the name Forge would write, which the matcher reads back', () => {
  for (const [pattern, addNumber, name] of [
    ['[seed]_[denoising]_[model_name]_[datetime]', false, '2447751738_0.6_waiANIMA_v10Base10_20260929160902.png'],
    ['[model_name]-[seed]', true, '00042-waiANIMA_v10Base10-2447751738.png'],
    ['[datetime<%Y-%m-%d %H:%M>] [model_name][batch_number]', false, '2026-09-29 16_09 waiANIMA_v10Base10.png'],
  ]) {
    assert.equal(exampleName(pattern, {addNumber}), name)
    assert.equal(modelOf(pattern, name, {addNumber}), 'waiANIMA_v10Base10')
  }
})

test('imageNaming: the img section of the config, else the defaults', () => {
  assert.deepEqual(imageNaming({}), {addNumber: false, pattern: '[seed]_[denoising]_[model_name]_[datetime]'})
  assert.deepEqual(imageNaming({img: {addNumber: true, filenamePattern: '[model_name]'}}), {
    addNumber: true,
    pattern: '[model_name]',
  })
})
