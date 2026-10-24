// Forge's "Filename pattern for saving images" (Settings → Saving images/grids) turned into a matcher, so img sort
// can read the model name out of the file names it produces. It mirrors FilenameGenerator in Forge's
// modules/images.py (lllyasviel/stable-diffusion-webui-forge, checked 2026-10-24):
//
// - The pattern is text with [tag] or [tag<arg>] pieces; tags are matched in any case, and an unknown tag stays in
//   the name as written ([tag]).
// - With "Add number to filename when saving" on, the name starts with a 5-digit counter and a dash: 00042-….
// - [denoising] without a denoising strength, [seed_last], [batch_number] and [generation_number] (for a single
//   image) produce nothing, and the text just before them is dropped too: [seed]_[denoising]_[model_name] gives
//   seed_model.
// - [model_name] keeps its spaces; [datetime] is %Y%m%d%H%M%S unless [datetime<format>] gives a strftime format,
//   whose characters that can't be in a file name (# < > : " / \ | ? *) become _.

export const DEFAULT_FILENAME_PATTERN = '[seed]_[denoising]_[model_name]_[datetime]'

const INVALID_FILENAME_CHARS = new Set('#<>:"/\\|?*\n\r\t')
const DEFAULT_TIME_FORMAT = '%Y%m%d%H%M%S'

// the strftime directives as regex, and as the sample date of exampleName (2026-09-29 16:09:02, a Tuesday)
const STRFTIME = {
  A: ['[A-Za-z]+', 'Tuesday'],
  B: ['[A-Za-z]+', 'September'],
  H: ['\\d{2}', '16'],
  I: ['\\d{2}', '04'],
  M: ['\\d{2}', '09'],
  S: ['\\d{2}', '02'],
  Y: ['\\d{4}', '2026'],
  a: ['[A-Za-z]+', 'Tue'],
  b: ['[A-Za-z]+', 'Sep'],
  d: ['\\d{2}', '29'],
  f: ['\\d{6}', '000000'],
  j: ['\\d{3}', '272'],
  m: ['\\d{2}', '09'],
  p: ['[AaPp][Mm]', 'PM'],
  y: ['\\d{2}', '26'],
}

const DIGITS = '\\d+'
const DECIMAL = '\\d*\\.?\\d+'
const FREE_TEXT = '.+?'
const hash = (length = 8) => `[0-9a-f]{${Number(length) || 8}}`

/** What each tag matches, and the sample value exampleName puts in its place. */
const TAGS = {
  basename: [FREE_TEXT, 'img'],
  batch_number: [DIGITS, null],
  batch_size: [DIGITS, '1'],
  cfg: [DECIMAL, '7'],
  clip_skip: [DIGITS, '2'],
  date: ['\\d{4}-\\d{2}-\\d{2}', '2026-09-29'],
  datetime: [null, null], // from its format, below
  denoising: [DECIMAL, '0.6'],
  full_prompt_hash: [hash, 'a1b2c3d4e5f60718'],
  generation_number: [DIGITS, null],
  hasprompt: ['.*?', ''],
  height: [DIGITS, '1216'],
  image_hash: [hash, 'a1b2c3d4e5f60718'],
  job_timestamp: ['\\d{14}', '20260929160902'],
  model_hash: ['[0-9a-f]+', 'a1b2c3d4e5'],
  model_name: [null, 'waiANIMA_v10Base10'], // captured, below
  negative_prompt_hash: [hash, 'a1b2c3d4e5f60718'],
  none: ['', ''],
  prompt: [FREE_TEXT, '1girl,_solo'],
  prompt_hash: [hash, 'a1b2c3d4e5f60718'],
  prompt_no_styles: [FREE_TEXT, '1girl,_solo'],
  prompt_spaces: [FREE_TEXT, '1girl, solo'],
  prompt_words: [FREE_TEXT, '1girl solo'],
  sampler: [FREE_TEXT, 'Euler a'],
  sampler_scheduler: [FREE_TEXT, 'Euler a_Karras'],
  scheduler: [FREE_TEXT, 'Karras'],
  seed: [DIGITS, '2447751738'],
  seed_first: [DIGITS, '2447751738'],
  seed_last: [DIGITS, null],
  steps: [DIGITS, '30'],
  styles: [FREE_TEXT, 'None'],
  user: [FREE_TEXT, 'user'],
  vae_filename: [FREE_TEXT, 'None'],
  width: [DIGITS, '832'],
}

/** Tags that can produce nothing, taking the text before them along (Forge's NOTHING_AND_SKIP_PREVIOUS_TEXT). */
const SKIPPABLE = new Set(['batch_number', 'denoising', 'generation_number', 'seed_last'])

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sanitize = (text) => [...text].map((ch) => (INVALID_FILENAME_CHARS.has(ch) ? '_' : ch)).join('')

/** The pattern's pieces, split as Forge splits them: [{text, tag?, args}], tag lowercased. */
function tokenize(pattern) {
  const pieces = []
  for (const match of pattern.matchAll(/(.*?)(?:\[([^[\]]+)\]|$)/gs)) {
    if (match[0] === '') continue
    let tag = match[2]
    const args = []
    for (let arg = tag && /^(.*)<([^>]*)>$/s.exec(tag); arg; arg = /^(.*)<([^>]*)>$/s.exec(tag)) {
      tag = arg[1]
      args.unshift(arg[2])
    }

    pieces.push({args, tag: tag?.toLowerCase(), text: match[1]})
  }

  return pieces
}

/** A strftime format as a regex (`sample` false) or as the sample date (`sample` true). */
function strftime(format, sample) {
  let out = ''
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]
    if (ch === '%' && i + 1 < format.length) {
      const directive = format[++i]
      if (directive === '%') out += '%'
      else out += STRFTIME[directive]?.[sample ? 1 : 0] ?? (sample ? '' : FREE_TEXT)
    } else {
      out += sample ? sanitize(ch) : escapeRegex(sanitize(ch))
    }
  }

  return out
}

/**
 * A matcher for the file names Forge saves with `pattern` (and the ascending number when `addNumber`): {regex,
 * parse(filename) → {model} or null}. Throws when the pattern is empty or has no [model_name], which sort needs.
 */
export function compileFilenamePattern(pattern, {addNumber = false} = {}) {
  const pieces = tokenize(pattern.trim())
  if (pieces.length === 0) throw new Error('The filename pattern is empty.')
  if (!pieces.some((piece) => piece.tag === 'model_name')) {
    throw new Error('The filename pattern needs [model_name]: img sort makes one folder per model.')
  }

  let source = addNumber ? '\\d{5,}-' : ''
  let modelSeen = false
  for (const {args, tag, text} of pieces) {
    const literal = escapeRegex(text)
    let value
    if (tag === undefined) value = ''
    else if (tag === 'model_name') {
      value = modelSeen ? '\\k<model>' : '(?<model>.+)'
      modelSeen = true
    } else if (tag === 'datetime') value = strftime(args[0] || DEFAULT_TIME_FORMAT, false)
    else if (tag in TAGS) value = typeof TAGS[tag][0] === 'function' ? TAGS[tag][0](args[0]) : TAGS[tag][0]
    else value = escapeRegex(`[${tag}]`) // Forge keeps a tag it doesn't know as written

    source += SKIPPABLE.has(tag) ? `(?:${literal}${value})?` : literal + value
  }

  const regex = new RegExp(`^${source}\\.[^.]+$`)
  return {
    parse(filename) {
      const match = regex.exec(filename)
      return match ? {model: match.groups.model} : null
    },
    regex,
  }
}

/** A file name Forge would save with this pattern, filled with sample values, to compare with your own files. */
export function exampleName(pattern, {addNumber = false} = {}) {
  let name = addNumber ? '00042-' : ''
  for (const {args, tag, text} of tokenize(pattern.trim())) {
    let value
    if (tag === undefined) value = ''
    else if (tag === 'datetime') value = strftime(args[0] || DEFAULT_TIME_FORMAT, true)
    else if (tag in TAGS) value = TAGS[tag][1]
    else value = `[${tag}]`
    if (tag in TAGS && /hash$/.test(tag) && args[0]) value = value.slice(0, Number(args[0]))
    if (value !== null) name += text + value // null: the tag gives nothing, and its text goes too
  }

  return `${name}.png`
}

/** The pattern and ascending number img sort uses: from the config's img section, else the defaults. */
export const imageNaming = (config = {}) => ({
  addNumber: config.img?.addNumber === true,
  pattern: config.img?.filenamePattern ?? DEFAULT_FILENAME_PATTERN,
})
