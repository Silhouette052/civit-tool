import assert from 'node:assert/strict'
import {test} from 'node:test'

import {buildModelUrl, CIVITAI_DOMAINS, domainOrder, withDomainFallback} from '../lib/civitaiClient.js'

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

test('buildModelUrl links to the given domain', () => {
  assert.equal(
    buildModelUrl({displayDomain: 'civitai.red', modelId: 4384, versionId: 128713}),
    'https://civitai.red/models/4384?modelVersionId=128713',
  )
})
