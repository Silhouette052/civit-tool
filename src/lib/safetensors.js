import fs from 'node:fs'
import path from 'node:path'

/**
 * Reads the __metadata__ block from a SafeTensors file header.
 *
 * SafeTensors files begin with:
 *   uint64 LE = JSON header byte length
 *   JSON header
 *
 * This is the hardened version (rejects corrupt/hostile header sizes)
 * that previously only existed in lora_activation.js; the other two
 * legacy scripts had a looser, unvalidated copy of the same logic.
 */
export function readSafetensorMetadata(filepath) {
  const fd = fs.openSync(filepath, 'r')

  try {
    const headerSizeBuffer = Buffer.alloc(8)
    fs.readSync(fd, headerSizeBuffer, 0, 8, 0)

    const headerSize = Number(headerSizeBuffer.readBigUInt64LE(0))

    if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) {
      throw new Error(`Invalid SafeTensors header size: ${headerSize}`)
    }

    const headerBuffer = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuffer, 0, headerSize, 8)

    const header = JSON.parse(headerBuffer.toString('utf8'))

    return header.__metadata__ || {}
  } finally {
    fs.closeSync(fd)
  }
}

const MODEL_ID_KEYS = ['modelId', 'model_id', 'civitai_model_id', 'civitaiModelId']
const VERSION_ID_KEYS = [
  'versionId',
  'modelVersionId',
  'model_version_id',
  'civitai_version_id',
  'civitaiModelVersionId',
]

function safeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Some tools store a raw civitai URL (or a bare modelVersionId=NNN
 * fragment) as a metadata string value instead of a dedicated key.
 */
function findCivitaiIdInMetadataValues(metadata) {
  for (const value of Object.values(metadata)) {
    if (typeof value !== 'string') continue

    const urlMatch = value.match(/civitai\.\w+\/(?:models\/)?(?:[^/?#]+)?[?&]modelVersionId=(\d+)/i)
    if (urlMatch) {
      return {modelId: null, modelVersionId: Number(urlMatch[1]), source: 'embedded metadata: civitai URL'}
    }

    const versionMatch = value.match(/modelVersionId[=:](\d+)/i)
    if (versionMatch) {
      return {
        modelId: null,
        modelVersionId: Number(versionMatch[1]),
        source: 'embedded metadata: modelVersionId parameter',
      }
    }
  }

  return null
}

/**
 * Resolves a modelId or modelVersionId out of a SafeTensors metadata
 * object, accepting every key spelling seen across the three legacy
 * scripts (url_exporter.js, url_with_author.js, lora_activation.js).
 */
export function getCivitaiIdsFromMetadata(metadata) {
  const embedded = findCivitaiIdInMetadataValues(metadata)
  if (embedded) return embedded

  for (const key of VERSION_ID_KEYS) {
    const id = safeNumber(metadata[key])
    if (Number.isInteger(id) && id > 0) {
      return {modelId: null, modelVersionId: id, source: `embedded metadata: ${key}`}
    }
  }

  for (const key of MODEL_ID_KEYS) {
    const id = safeNumber(metadata[key])
    if (Number.isInteger(id) && id > 0) {
      return {modelId: id, modelVersionId: null, source: `embedded metadata: ${key}`}
    }
  }

  return null
}

/**
 * Finds .safetensors files under a folder. Recurses by default,
 * matching the more capable of the two legacy url scripts.
 */
export function findSafetensorFiles(folderPath, {recursive = true} = {}) {
  const results = []

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, {withFileTypes: true})

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        if (recursive) walk(fullPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.safetensors')) {
        results.push(fullPath)
      }
    }
  }

  walk(folderPath)

  return results
}
