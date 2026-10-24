import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  buildModelPageUrl,
  buildModelUrl,
  CIVITAI_DOMAINS,
  domainOrder,
  modelSlug,
  withDomainFallback,
} from '../lib/civitaiClient.js'

test('domainOrder: civitai.red first by default; the preferred domain first, then the other', () => {
  assert.deepEqual(CIVITAI_DOMAINS, ['civitai.red', 'civitai.com'])
  assert.deepEqual(domainOrder(), ['civitai.red', 'civitai.com'])
  assert.deepEqual(domainOrder('civitai.com'), ['civitai.com', 'civitai.red'])
  assert.deepEqual(domainOrder('civitai.red'), ['civitai.red', 'civitai.com'])
})

test('withDomainFallback: the first domain that answers wins; when all fail, every error is kept', async () => {
  const tried = []
  const found = await withDomainFallback(['civitai.red', 'civitai.com'], async (domain) => {
    tried.push(domain)
    if (domain === 'civitai.red') throw new Error('HTTP 404 Not Found')
    return {id: 1}
  })
  assert.deepEqual(found, {domain: 'civitai.com', value: {id: 1}})
  assert.deepEqual(tried, ['civitai.red', 'civitai.com'])

  // found on the first domain: the second is never asked
  tried.length = 0
  const first = await withDomainFallback(['civitai.red', 'civitai.com'], async (domain) => tried.push(domain))
  assert.equal(first.domain, 'civitai.red')
  assert.deepEqual(tried, ['civitai.red'])

  await assert.rejects(
    withDomainFallback(['civitai.red', 'civitai.com'], async (domain) => {
      throw new Error(`HTTP 404 on ${domain}`)
    }),
    {message: 'civitai.red: HTTP 404 on civitai.red; civitai.com: HTTP 404 on civitai.com'},
  )
})

test('buildModelPageUrl links to the model page with the slug Civitai makes from its name', () => {
  assert.equal(
    buildModelPageUrl({displayDomain: 'civitai.red', modelId: 3017367, modelName: '//ASHLEY WOOD//'}),
    'https://civitai.red/models/3017367/ashley-wood',
  )
  assert.equal(modelSlug('Edo Era Anime'), 'edo-era-anime')
  assert.equal(modelSlug('Café-Style  v2.0 (Illustrious)'), 'cafe-style-v20-illustrious')
  assert.equal(modelSlug('R&B_mix'), 'randbmix')
  assert.equal(buildModelPageUrl({modelId: 1, modelName: 'ノート'}), 'https://civitai.com/models/1')
  assert.equal(buildModelPageUrl({modelName: 'x'}), null)
})

test('buildModelUrl links to the given domain', () => {
  assert.equal(
    buildModelUrl({displayDomain: 'civitai.red', modelId: 4384, versionId: 128713}),
    'https://civitai.red/models/4384?modelVersionId=128713',
  )
})
