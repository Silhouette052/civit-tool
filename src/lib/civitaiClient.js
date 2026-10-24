const DEFAULT_API_BASE = 'https://civitai.com/api/v1'

/**
 * The Civitai domains, in the default lookup order. Both serve the same API, but a LoRA can be
 * visible on one and not the other, so a lookup that fails on the first is retried on the second.
 */
export const CIVITAI_DOMAINS = ['civitai.red', 'civitai.com']

export const apiBaseFor = (domain) => `https://${domain}/api/v1`

/** The lookup order with `preferred` (the config / --domain setting) first, then the other Civitai domains. */
export function domainOrder(preferred = CIVITAI_DOMAINS[0]) {
  return [preferred, ...CIVITAI_DOMAINS.filter((domain) => domain !== preferred)]
}

/**
 * Runs `lookup(domain)` on each domain in turn until one succeeds; returns {domain, value}. Any error
 * (not found, refused, network) moves on to the next domain. When all fail, throws the errors of all.
 */
export async function withDomainFallback(domains, lookup) {
  const errors = []
  for (const domain of domains) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return {domain, value: await lookup(domain)}
    } catch (error) {
      errors.push(`${domain}: ${error.message}`)
    }
  }

  throw new Error(errors.join('; '))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetches a Civitai API URL with retry/backoff on 429 and 5xx responses.
 * The URL decides the domain; see withDomainFallback for trying several.
 */
export async function apiFetch(url, {token = process.env.CIVITAI_API_TOKEN} = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'civit-tool/0.1.0',
  }

  if (token) headers.Authorization = `Bearer ${token}`

  let response

  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(url, {headers})

    if (response.ok) return response.json()

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 1500
      await sleep(delay)
      continue
    }

    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }

  throw new Error(`Civitai request failed after 3 attempts: ${url}`)
}

export function fetchModelVersionById(versionId, {apiBase = DEFAULT_API_BASE, token} = {}) {
  return apiFetch(`${apiBase}/model-versions/${versionId}`, {token})
}

export function fetchModelVersionByHash(hash, {apiBase = DEFAULT_API_BASE, token} = {}) {
  return apiFetch(`${apiBase}/model-versions/by-hash/${hash}`, {token})
}

export function fetchModelById(modelId, {apiBase = DEFAULT_API_BASE, token} = {}) {
  return apiFetch(`${apiBase}/models/${modelId}`, {token})
}

// The tRPC endpoint rejects requests that don't look like they come from
// the site itself (intermittent 401 "Please use the public API instead").
// These three headers together were reliable in testing (30/30 versions).
const TRPC_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'x-client': 'web',
}

/**
 * Fetches a model version's `settings` ({strength, minStrength, maxStrength})
 * -- the "Usage Tips" strength shown on the model page. Only exposed by
 * Civitai's internal, unversioned tRPC API (not the public REST API), so
 * this may break at any time: every failure resolves to null, never throws.
 */
export async function fetchModelVersionSettings(versionId, {host = 'civitai.com', timeoutMs = 10_000} = {}) {
  try {
    const input = encodeURIComponent(JSON.stringify({json: {id: Number(versionId)}}))
    const response = await fetch(`https://${host}/api/trpc/modelVersion.getById?input=${input}`, {
      headers: {...TRPC_HEADERS, Referer: `https://${host}/`},
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) return null

    const body = await response.json()
    const settings = body?.result?.data?.json?.settings

    return settings && typeof settings === 'object' ? settings : null
  } catch {
    return null
  }
}

/** A user-facing Civitai link, on the domain where the LoRA was found. */
export function buildModelUrl({modelId, versionId, displayDomain = 'civitai.com'}) {
  if (!modelId) return versionId ? `https://${displayDomain}/models?modelVersionId=${versionId}` : null

  return versionId
    ? `https://${displayDomain}/models/${modelId}?modelVersionId=${versionId}`
    : `https://${displayDomain}/models/${modelId}`
}

/**
 * The slug Civitai puts after a model's id in its page URL, the way its slugit() makes it (slugify, lower and
 * strict): accents dropped, & as "and", every other character that isn't a letter, digit or space removed, spaces
 * and dashes as "-". "//ASHLEY WOOD//" → "ashley-wood". Civitai finds the page by the id, so a slug that comes out
 * different for a rare symbol still opens it.
 */
export function modelSlug(name = '') {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/&/g, 'and')
    .replace(/-/g, ' ')
    .replace(/[^A-Za-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
}

/** A model's page as Civitai links it, https://<domain>/models/<id>/<slug>; null without a model id. */
export function buildModelPageUrl({displayDomain = 'civitai.com', modelId, modelName}) {
  if (!modelId) return null
  const slug = modelSlug(modelName)
  return `https://${displayDomain}/models/${modelId}${slug ? `/${slug}` : ''}`
}

export {DEFAULT_API_BASE}
