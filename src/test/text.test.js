import assert from 'node:assert/strict'
import {test} from 'node:test'

import {stripHtml} from '../lib/text.js'

test('stripHtml removes inline tags without inserting a gap', () => {
  const html = '<li><strong>Strength:</strong> 0.9</li>'
  assert.equal(stripHtml(html), 'Strength: 0.9')
})

test('stripHtml turns block-level tags into newlines', () => {
  const html = '<p>Usage Tips</p><ul><li>Strength: 0.9</li><li>Sampler: DPM++ 2M</li></ul>'
  const result = stripHtml(html)
  assert.match(result, /Usage Tips\nStrength: 0.9\nSampler: DPM\+\+ 2M/)
})

test('stripHtml decodes common HTML entities', () => {
  assert.equal(stripHtml('Tom &amp; Jerry &nbsp;&mdash;&nbsp;test'.replace('&mdash;', '&#8212;')), 'Tom & Jerry — test')
})

test('stripHtml returns empty string for null/undefined input', () => {
  assert.equal(stripHtml(null), '')
  assert.equal(stripHtml(undefined), '')
  assert.equal(stripHtml(''), '')
})
