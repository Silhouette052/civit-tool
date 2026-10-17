// Reads the generation metadata that Forge / A1111 store in images: the "parameters" text chunk of a PNG,
// or the EXIF UserComment of a JPEG or WebP. parseParameters splits that text into the prompt, the negative
// prompt and the settings line, the same way A1111's own "PNG Info" tab does.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.webp'])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1')

const TAG_IMAGE_DESCRIPTION = 0x010e
const TAG_EXIF_IFD = 0x8769
const TAG_USER_COMMENT = 0x9286

/** Text chunks of a PNG as {keyword: text}; zTXt and compressed iTXt are inflated. */
function readPngTexts(buffer) {
  const texts = {}
  let offset = PNG_SIGNATURE.length

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (data.length < length) throw new Error('truncated PNG chunk')
    offset += 12 + length

    if (type === 'IEND') break
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue

    const keywordEnd = data.indexOf(0)
    if (keywordEnd < 0) continue
    const keyword = data.toString('latin1', 0, keywordEnd)
    const rest = data.subarray(keywordEnd + 1)

    if (type === 'tEXt') {
      texts[keyword] = rest.toString('latin1')
    } else if (type === 'zTXt') {
      texts[keyword] = zlib.inflateSync(rest.subarray(1)).toString('latin1')
    } else {
      // iTXt: compression flag, method, language tag \0, translated keyword \0, UTF-8 text
      const compressed = rest[0] === 1
      const languageEnd = rest.indexOf(0, 2)
      const translatedEnd = languageEnd < 0 ? -1 : rest.indexOf(0, languageEnd + 1)
      if (translatedEnd < 0) continue
      const text = rest.subarray(translatedEnd + 1)
      texts[keyword] = (compressed ? zlib.inflateSync(text) : text).toString('utf8')
    }
  }

  return texts
}

/** UTF-16 without a BOM: the byte order whose high bytes are mostly zero (prompts are mostly ASCII). */
function decodeUtf16(bytes) {
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0) evenZeros++
    if (bytes[i + 1] === 0) oddZeros++
  }

  const even = bytes.subarray(0, bytes.length - (bytes.length % 2))
  if (evenZeros > oddZeros) return Buffer.from(even).swap16().toString('utf16le')
  return even.toString('utf16le')
}

/** EXIF UserComment: an 8-byte charset header, then the text. */
function decodeUserComment(bytes) {
  const charset = bytes.toString('latin1', 0, 8).replace(/\0+$/, '')
  const body = bytes.subarray(8)
  const text = charset === 'UNICODE' ? decodeUtf16(body) : body.toString(charset === 'ASCII' ? 'latin1' : 'utf8')
  return text.replace(/\0+$/, '')
}

/** The UserComment (or, failing that, the ImageDescription) of a TIFF/EXIF block. */
function readExifText(tiff) {
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') throw new Error('bad EXIF byte order')
  const little = order === 'II'
  const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))

  const readIfd = (start) => {
    const entries = new Map()
    if (start + 2 > tiff.length) return entries
    const count = u16(start)
    for (let i = 0; i < count; i++) {
      const at = start + 2 + i * 12
      if (at + 12 > tiff.length) break
      const size = u32(at + 4) * ({1: 1, 2: 1, 3: 2, 4: 4, 7: 1}[u16(at + 2)] ?? 0)
      const valueAt = size > 4 ? u32(at + 8) : at + 8
      entries.set(u16(at), {bytes: tiff.subarray(valueAt, valueAt + size), valueAt: at + 8})
    }

    return entries
  }

  const ifd0 = readIfd(u32(4))
  const exifPointer = ifd0.get(TAG_EXIF_IFD)
  const comment = exifPointer ? readIfd(u32(exifPointer.valueAt)).get(TAG_USER_COMMENT) : undefined
  if (comment && comment.bytes.length > 8) {
    const text = decodeUserComment(comment.bytes)
    if (text) return text
  }

  const description = ifd0.get(TAG_IMAGE_DESCRIPTION)
  return description ? description.bytes.toString('utf8').replace(/\0+$/, '') || undefined : undefined
}

const stripExifHeader = (data) => (data.subarray(0, 6).equals(EXIF_HEADER) ? data.subarray(6) : data)

/** {parameters} from a JPEG's APP1 Exif block, plus {comment} from a COM marker. */
function readJpegTexts(buffer) {
  const texts = {}
  let offset = 2

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('bad JPEG marker')
    const marker = buffer[offset + 1]
    if (marker === 0xff) {
      offset++ // fill byte
      continue
    }

    if (marker === 0xda || marker === 0xd9) break // start of scan / end of image: no metadata after this
    const length = buffer.readUInt16BE(offset + 2)
    const data = buffer.subarray(offset + 4, offset + 2 + length)
    offset += 2 + length

    if (marker === 0xe1 && data.subarray(0, 6).equals(EXIF_HEADER)) {
      const text = readExifText(data.subarray(6))
      if (text) texts.parameters = text
    } else if (marker === 0xfe) {
      texts.comment = data.toString('utf8')
    }
  }

  return texts
}

/** {parameters} from a WebP's EXIF chunk. */
function readWebpTexts(buffer) {
  const texts = {}
  let offset = 12

  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const data = buffer.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)

    if (type === 'EXIF') {
      const text = readExifText(stripExifHeader(data))
      if (text) texts.parameters = text
    }
  }

  return texts
}

/**
 * The text metadata of an image as {key: text}. The format is taken from the file's first bytes, not its
 * extension. Forge / A1111 keep the generation parameters under "parameters".
 */
export function readImageTexts(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return readPngTexts(buffer)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegTexts(buffer)
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return readWebpTexts(buffer)
  }

  throw new Error('not a PNG, JPEG or WebP file')
}

// A1111's re_param_code: `Key: value` pairs, where a value may be quoted and contain commas
const PARAM_PATTERN = /\s*(\w[\w \-/]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g

const unquote = (value) => {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Splits A1111 / Forge "parameters" text into {prompt, negativePrompt, settings}. The last line holds the
 * settings when it has at least 3 `Key: value` pairs (A1111's rule) and starts with one, so a prompt such as
 * "(masterpiece:1.2), style: ink, light: soft" stays a prompt. "Negative prompt:" starts the negative prompt.
 * Settings values stay strings, as written.
 */
export function parseParameters(text) {
  const lines = text.trim().split(/\r?\n/)
  let settingsLine = lines.at(-1)
  const pairs = [...settingsLine.matchAll(PARAM_PATTERN)]
  if (pairs.length < 3 || pairs[0].index !== 0) settingsLine = ''
  else lines.pop()

  const prompt = []
  const negative = []
  let inNegative = false
  for (let line of lines) {
    line = line.trim()
    if (line.startsWith('Negative prompt:')) {
      inNegative = true
      line = line.slice('Negative prompt:'.length).trim()
    }

    ;(inNegative ? negative : prompt).push(line)
  }

  const settings = {}
  for (const [, key, value] of settingsLine.matchAll(PARAM_PATTERN)) settings[key.trim()] = unquote(value.trim())

  // Forge may leave a blank line before "Negative prompt:"
  return {negativePrompt: negative.join('\n').trim(), prompt: prompt.join('\n').trim(), settings}
}

/**
 * One image's entry: {file, prompt, negativePrompt, settings, parameters, other?}, or null when the image
 * has no text metadata at all. Without a "parameters" text, prompt / negativePrompt / parameters are null.
 */
export function readImageMetadata(file) {
  const {parameters, ...other} = readImageTexts(fs.readFileSync(file))
  if (parameters === undefined && Object.keys(other).length === 0) return null

  const {negativePrompt, prompt, settings} =
    parameters === undefined ? {negativePrompt: null, prompt: null, settings: {}} : parseParameters(parameters)
  // in reading order, for the JSON file
  const entry = {file: path.basename(file), prompt, negativePrompt, settings, parameters: parameters ?? null}
  if (Object.keys(other).length > 0) entry.other = other
  return entry
}

/**
 * Reads every image directly in a folder (not recursive), in natural name order.
 * Returns {entries, missing: names without metadata, failed: [{file, error}], total}.
 */
export function collectImageMetadata(folder) {
  const files = fs
    .readdirSync(folder, {withFileTypes: true})
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))

  const entries = []
  const missing = []
  const failed = []
  for (const name of files) {
    try {
      const entry = readImageMetadata(path.join(folder, name))
      if (entry) entries.push(entry)
      else missing.push(name)
    } catch (error) {
      failed.push({error: error.message, file: name})
    }
  }

  return {entries, failed, missing, total: files.length}
}

/** One prompt per line for "Prompts from file or textbox": line breaks inside a prompt become a space. */
export const promptLine = (prompt) => prompt.replace(/\s*\r?\n\s*/g, ' ').trim()
