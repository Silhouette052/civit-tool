import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {buildSortPlan, parseImageName} from '../commands/img/sort.js'
import {compileFilenamePattern} from '../lib/filenamePattern.js'

test('parseImageName keeps underscores inside the model name', () => {
  assert.deepEqual(parseImageName('2447751738_0.6_waiANIMA_v10Base10_20260929160902.png'), {
    model: 'waiANIMA_v10Base10',
  })
})

test('parseImageName handles a model name without underscores and other image extensions', () => {
  assert.equal(parseImageName('12345_1_illustriousXL_20260101120000.webp')?.model, 'illustriousXL')
  assert.equal(parseImageName('12345_.75_ponyV6_20260101120000.JPG')?.model, 'ponyV6')
  // Forge leaves [denoising] out, with the _ before it, when there is no denoising strength
  assert.equal(parseImageName('12345_ponyV6_20260101120000.png')?.model, 'ponyV6')
})

test('parseImageName rejects names that do not follow the pattern', () => {
  assert.equal(parseImageName('0001-2026-08-20-12-33.png'), null)
  assert.equal(parseImageName('2447751738_0.6_waiANIMA_2026092916.png'), null, 'date must be 14 digits')
  assert.equal(parseImageName('2447751738_0.6_waiANIMA_v10Base10_20260929160902.txt'), null)
})

test('buildSortPlan groups direct files by model and ignores subfolders and non-matching files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-sort-'))

  try {
    for (const name of [
      '2_0.6_waiANIMA_v10Base10_20260929160902.png',
      '1_0.6_waiANIMA_v10Base10_20260929160901.png',
      '3_0.5_illustriousXL_20260929160903.png',
      'notes.txt',
      'random.png',
    ]) {
      fs.writeFileSync(path.join(dir, name), '')
    }

    fs.mkdirSync(path.join(dir, 'illustriousXL'))
    fs.writeFileSync(path.join(dir, 'illustriousXL', '9_0.5_illustriousXL_20260929160909.png'), '')

    const {plan, skipped} = buildSortPlan(dir)

    assert.deepEqual(
      plan.map((g) => [g.folder, g.files, g.targetExists]),
      [
        ['illustriousXL', ['3_0.5_illustriousXL_20260929160903.png'], true],
        [
          'waiANIMA_v10Base10',
          ['1_0.6_waiANIMA_v10Base10_20260929160901.png', '2_0.6_waiANIMA_v10Base10_20260929160902.png'],
          false,
        ],
      ],
    )
    assert.deepEqual(skipped, ['random.png'])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('buildSortPlan follows another filename pattern, here with the ascending number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civit-sort-'))

  try {
    for (const name of ['00001-my model v2-111.png', '00002-ill_xl-222.png', '2_0.6_ill_xl_20260929160902.png']) {
      fs.writeFileSync(path.join(dir, name), '')
    }

    const {plan, skipped} = buildSortPlan(dir, compileFilenamePattern('[model_name]-[seed]', {addNumber: true}))
    assert.deepEqual(
      plan.map((g) => [g.folder, g.files]),
      [
        ['ill_xl', ['00002-ill_xl-222.png']],
        ['my model v2', ['00001-my model v2-111.png']],
      ],
    )
    assert.deepEqual(skipped, ['2_0.6_ill_xl_20260929160902.png'])
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
