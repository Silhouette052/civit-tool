import {Args, Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

import {
  apiBaseFor,
  buildModelUrl,
  domainOrder,
  fetchModelById,
  fetchModelVersionByHash,
  fetchModelVersionById,
  fetchModelVersionSettings,
  withDomainFallback,
} from '../../lib/civitaiClient.js'
import {baseModelFolder} from '../../lib/baseModels.js'
import {DEFAULT_WARN_CHARS, loadConfig, loadLocalConfig, saveHomeSetting} from '../../lib/config.js'
import {sha256} from '../../lib/hash.js'
import {findSafetensorFiles, getCivitaiIdsFromMetadata, readSafetensorMetadata} from '../../lib/safetensors.js'
import {stripHtml} from '../../lib/text.js'
import {findRenameConflicts} from '../file/rename.js'

const DEFAULT_WEIGHT = 1
const DEFAULT_WEIGHT_SOURCE = 'default (not found)'

function safeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeTriggers(value) {
  if (!value) return []
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)
}

function getTriggerWords(versionData) {
  return normalizeTriggers(
    versionData.trainedWords ??
      versionData.activationText ??
      versionData.activation_text ??
      versionData.triggerWords ??
      versionData.trigger_words,
  )
}

const MAX_WEIGHT = 2

function round2(n) {
  return Math.round(n * 100) / 100
}

// A plausible LoRA weight (0-2), not glued to a neighbouring word or number,
// so "v4.0", "anima3", "Steps 4-16" or "25-40" can't produce a value.
const VALUE = String.raw`(?<![\w.])(?:\d?\.\d+|[0-2](?:\.\d+)?)(?!\d)`
// A single value, a range ("0.4~0.6", "0.2 - 1.2", "0.7 to 0.9") or a
// bracketed pair ("[0.8,1]"). Captured whole and parsed by parseRange().
const RANGE = String.raw`(\[\s*${VALUE}\s*,\s*${VALUE}\s*\]|${VALUE}(?:\s*(?:-|–|—|~|to)\s*${VALUE})?)`
// Filler allowed between a keyword and the value: no digits (so the first
// number after the keyword is always the one taken) and no line breaks.
const GAP = (max) => String.raw`[^\d\n]{0,${max}}?`

// Tiers in priority order. Within a tier, the earliest match in the text wins.
const WEIGHT_PATTERN_TIERS = [
  // An explicit personal pick beats a general range: "I prefer 0.9", "best at 1", "1.5 is the sweet spot".
  [String.raw`\b(?:prefer(?:red)?|best\s+at|sweet\s*spot)\b${GAP(20)}${RANGE}`, String.raw`${RANGE}\s+(?:is\s+)?(?:the\s+)?sweet\s*spot`],
  // "recommended to be around 0.8", "I recommend starting in the 0.8 - 1 range", "2.0 is recommended".
  [String.raw`\brecommend(?:ed|s|ation)?\b${GAP(40)}${RANGE}`, String.raw`${RANGE}\s+(?:is\s+)?recommended`],
  // Generic: "Weight: 0.6-0.8", "Strength 0.75", "use at 0.7 strength", "works great in the 0.2 - 1.2 range".
  [
    String.raw`\b(?:weights?|strength)\b${GAP(25)}${RANGE}`,
    String.raw`\b(?:use|try|works?(?:\s+(?:best|great|well))?)\s+(?:it\s+)?(?:at|with|on|in)\b${GAP(20)}${RANGE}`,
    String.raw`${RANGE}\s*(?:weights?|strength|range)\b`,
  ],
].map((tier) => tier.map((source) => new RegExp(source, 'gi')))

/**
 * Turns a captured value/range string into {weight, min, max}. Ranges use
 * the midpoint. Returns null when anything falls outside (0, MAX_WEIGHT].
 */
function parseRange(raw) {
  const numbers = (raw.match(/\d*\.?\d+/g) ?? []).map(Number)
  if (numbers.length === 0 || numbers.some((n) => !(n > 0 && n <= MAX_WEIGHT))) return null

  const min = Math.min(...numbers)
  const max = Math.max(...numbers)

  return numbers.length === 1 ? {max: null, min: null, weight: numbers[0]} : {max, min, weight: round2((min + max) / 2)}
}

/**
 * Scans already-stripped plain text for a weight/strength hint, sentence by
 * sentence so unrelated numbers elsewhere (CFG, steps, versions) can't be
 * paired with a keyword. Returns {weight, min, max} or null.
 */
export function findWeightHint(text) {
  if (!text) return null

  const sentences = text.split(/\n|(?<=[.!?])\s+/)

  for (const tier of WEIGHT_PATTERN_TIERS) {
    let best = null

    for (const [sentenceIndex, sentence] of sentences.entries()) {
      for (const pattern of tier) {
        for (const match of sentence.matchAll(pattern)) {
          const hint = parseRange(match[1])
          if (!hint) continue

          const position = [sentenceIndex, match.index]
          if (!best || position[0] < best.position[0] || (position[0] === best.position[0] && position[1] < best.position[1])) {
            best = {hint, position}
          }
        }
      }
    }

    if (best) return best.hint
  }

  return null
}

export function extractWeightFromText(text) {
  return findWeightHint(text)?.weight ?? null
}

/**
 * Resolves the preferred LoRA weight, in priority order:
 *   1. `settings.strength` from Civitai's tRPC API -- the "Usage Tips"
 *      strength the author set on the model page. Exception: a bare
 *      strength of exactly 1 with no min/max is very often just the upload
 *      form's default, so a hint found in the description text overrides
 *      it (flagged via `note` so the console can say so).
 *   2. Only `settings.minStrength`/`maxStrength` -> their midpoint.
 *   3. Free text in the model-VERSION description, then the full MODEL
 *      description (needs the separate GET /models/{id} call, see
 *      discoverCivitai below), then the version's `notes` field.
 *   4. The hardcoded default, clearly labeled as such.
 *
 * Returns {weight, source, min, max, note}.
 */
export function getPreferredWeight(versionData, modelData, settings = null) {
  const strength = safeNumber(settings?.strength)
  const min = safeNumber(settings?.minStrength)
  const max = safeNumber(settings?.maxStrength)
  const range = {max, min}

  const isBareDefault = strength === 1 && min === null && max === null

  if (strength !== null && strength > 0 && !isBareDefault) {
    return {...range, note: null, source: 'civitai settings (usage tips)', weight: strength}
  }

  if (strength === null && min !== null && max !== null && min > 0) {
    return {...range, note: null, source: 'civitai settings range (midpoint)', weight: round2((min + max) / 2)}
  }

  const textSources = [
    {label: 'model-version description', text: stripHtml(versionData.description)},
    {label: 'model description', text: stripHtml(modelData?.description)},
    {label: 'notes field', text: stripHtml(versionData.notes)},
  ]

  for (const {label, text} of textSources) {
    const hint = findWeightHint(text)
    if (!hint) continue

    if (isBareDefault) {
      return {
        max: hint.max,
        min: hint.min,
        note: `Civitai settings say strength 1 (likely the upload default); using ${hint.weight} from the ${label} instead.`,
        source: `${label} (overrode settings.strength=1)`,
        weight: hint.weight,
      }
    }

    return {max: hint.max, min: hint.min, note: null, source: label, weight: hint.weight}
  }

  if (isBareDefault) return {...range, note: null, source: 'civitai settings (usage tips)', weight: 1}

  return {max: null, min: null, note: null, source: DEFAULT_WEIGHT_SOURCE, weight: DEFAULT_WEIGHT}
}

function getBaseModel(versionData) {
  return versionData.baseModel ?? versionData.baseModelType ?? versionData.model?.type ?? 'Unknown'
}

function getDescription(versionData, modelData) {
  return versionData.description || modelData?.description || ''
}

function getModelName(versionData, modelData, filename) {
  return modelData?.name ?? versionData.model?.name ?? path.basename(filename, '.safetensors')
}

export function createJsonMetadata(discovery, filename, displayDomain, weightResult) {
  const versionData = discovery.data
  const triggerWords = getTriggerWords(versionData)

  return {
    'activation text': triggerWords.join(', '),
    'civitai lookup': discovery.source,
    'civitai model id': discovery.modelId,
    'civitai model name': getModelName(versionData, discovery.modelData, filename),
    'civitai model version id': discovery.modelVersionId,
    'civitai url': buildModelUrl({displayDomain, modelId: discovery.modelId, versionId: discovery.modelVersionId}) ?? '',
    description: getDescription(versionData, discovery.modelData),
    'negative text': '',
    notes: '',
    'preferred weight': weightResult.weight,
    ...(weightResult.max === null ? {} : {'preferred weight max': weightResult.max}),
    ...(weightResult.min === null ? {} : {'preferred weight min': weightResult.min}),
    'preferred weight source': weightResult.source,
    'sd version': getBaseModel(versionData),
    ...(discovery.hash ? {sha256: discovery.hash} : {}),
  }
}

// Sidecar fields that come from Civitai and are safe to overwrite on --refresh.
const DERIVED_FIELDS = [
  'civitai lookup',
  'civitai model id',
  'civitai model name',
  'civitai model version id',
  'civitai url',
  'description',
  'preferred weight',
  'preferred weight max',
  'preferred weight min',
  'preferred weight source',
  'sd version',
  'sha256',
]
// Fields the user is likely to have hand-edited; kept on --refresh when non-empty.
const USER_FIELDS = ['activation text', 'negative text', 'notes']

/**
 * Merges a freshly resolved sidecar into an existing one for --refresh:
 * Civitai-derived fields are replaced (stale ones dropped), the user's
 * non-empty notes/negative/activation text and any unknown keys are kept.
 */
export function mergeSidecar(existing, fresh) {
  const merged = {}

  for (const [key, value] of Object.entries(existing)) {
    if (!DERIVED_FIELDS.includes(key)) merged[key] = value
  }

  Object.assign(merged, fresh)

  const kept = []

  for (const key of USER_FIELDS) {
    const value = existing[key]

    if (typeof value === 'string' && value.trim() !== '') {
      if (value !== fresh[key]) kept.push(key)
      merged[key] = value
    }
  }

  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))

  return {kept, sidecar: sorted}
}

/**
 * Resolves a SafeTensors file to Civitai data: the model-version record
 * (via embedded metadata ID, or a SHA256 hash lookup as fallback), *and*
 * the full parent model record -- required because the model-version
 * endpoint's nested `model` object is a slim stub with no description.
 * Each domain in `domains` is tried in turn until one knows the LoRA; the
 * model record and settings then come from that domain first.
 */
async function discoverCivitai(filepath, domains) {
  let metadata = {}

  try {
    metadata = readSafetensorMetadata(filepath)
  } catch {
    // fall through to hash lookup below
  }

  const ids = getCivitaiIdsFromMetadata(metadata)

  // hashed once, and only when the file has no embedded ID
  const hash = ids?.modelVersionId ? null : await sha256(filepath)
  const {domain, value: versionData} = await withDomainFallback(domains, async (domain) => {
    const apiBase = apiBaseFor(domain)
    if (hash === null) return fetchModelVersionById(ids.modelVersionId, {apiBase})

    const version = await fetchModelVersionByHash(hash, {apiBase})
    if (!Number.isInteger(safeNumber(version?.id))) throw new Error('Civitai returned no model-version ID for this hash.')
    return version
  })

  const modelVersionId = hash === null ? ids.modelVersionId : safeNumber(versionData.id)
  const source = `${hash === null ? ids.source : 'SHA256 -> Civitai /by-hash'} (${domain})`
  const sameDomainFirst = domainOrder(domain)
  const modelId = safeNumber(versionData.modelId) ?? safeNumber(versionData.model?.id)
  const [modelData, settings] = await Promise.all([
    modelId
      ? withDomainFallback(sameDomainFirst, (d) => fetchModelById(modelId, {apiBase: apiBaseFor(d)})).then(
          (found) => found.value,
          () => null,
        )
      : null,
    withDomainFallback(sameDomainFirst, async (d) => {
      const found = await fetchModelVersionSettings(modelVersionId, {host: d})
      if (!found) throw new Error('no settings')
      return found
    }).then(
      (found) => found.value,
      () => null,
    ),
  ])

  return {data: versionData, domain, hash, modelData, modelId, modelVersionId, settings, source}
}

function getJsonActivationText(json) {
  return normalizeTriggers(json['activation text'] ?? json.activationText ?? json.trainedWords ?? json.triggerWords)
}

function getJsonWeight(json) {
  const value =
    json['preferred weight'] ?? json.preferredWeight ?? json.preferred_weight ?? json.weight ?? json.strength
  const n = safeNumber(value)
  return n !== null && n > 0 ? n : DEFAULT_WEIGHT
}

function formatSettings(settings) {
  if (!settings) return 'unavailable (internal API did not answer)'

  const parts = []
  if (settings.strength != null) parts.push(`strength ${settings.strength}`)
  if (settings.minStrength != null) parts.push(`min ${settings.minStrength}`)
  if (settings.maxStrength != null) parts.push(`max ${settings.maxStrength}`)

  return parts.length > 0 ? parts.join(', ') : 'none set by author'
}

/** One LoRA's prompt, e.g. `<lora:MyStyle:0.7>, mystyle,`. In loras.yaml it is one list item. */
export function makePrompt(safetensorFilename, json) {
  const loraName = path.basename(safetensorFilename, '.safetensors')
  const weight = getJsonWeight(json)
  const triggers = getJsonActivationText(json)

  let prompt = `<lora:${loraName}:${weight}>`
  if (triggers.length > 0) prompt += `, ${triggers.join(', ')}`
  prompt += ','

  return prompt
}

/**
 * The prompts as one X/Y/Z plot values line: each in double quotes, separated by commas, e.g.
 * `"<lora:A:1>, a,","<lora:B:0.8>, b,"`. The quotes keep the commas inside a prompt from splitting
 * it (the plot reads the line as CSV, so a `"` inside a prompt is doubled).
 */
export function formatXyzValues(prompts) {
  return prompts.map((prompt) => `"${prompt.replaceAll('"', '""')}"`).join(',')
}

/** What is wrong with a LoRA name: "__" and/or the warn characters it contains, e.g. ['"__"', '"@"']. */
export function nameProblems(stem, warnChars = '') {
  const problems = stem.includes('__') ? ['"__"'] : []
  for (const ch of new Set(warnChars)) if (stem.includes(ch)) problems.push(`"${ch}"`)
  return problems
}

/**
 * The fixed name: warn characters removed, then every run of underscores made one "_" and every run
 * of spaces one space, trimmed. `Rock & Roll__v2` → `Rock Roll_v2`.
 */
export function fixLoraName(stem, warnChars = '') {
  const kept = [...stem].filter((ch) => !warnChars.includes(ch)).join('')
  return kept.replaceAll(/_{2,}/g, '_').replaceAll(/\s{2,}/g, ' ').trim()
}

/**
 * The files of each LoRA in a folder: the LoRA and every file named after it (sidecar .json,
 * .preview.png, .civitai.info…), as Map LoRA file → names, the LoRA itself first. A file belongs to
 * the longest LoRA name it starts with: `a.v2.json` is a.v2's, not a's. `exclude`: names to leave out.
 */
function filesOfLoras(folder, safetensorFiles, exclude = []) {
  const stems = safetensorFiles.map((file) => path.basename(file, path.extname(file)))
  const names = fs
    .readdirSync(folder, {withFileTypes: true})
    .filter((entry) => entry.isFile() && !exclude.includes(entry.name))
    .map((entry) => entry.name)
  const ownerOf = (name) => stems.filter((stem) => name.startsWith(`${stem}.`)).sort((a, b) => b.length - a.length)[0]

  return new Map(
    safetensorFiles.map((file, i) => {
      const lora = path.basename(file)
      const owned = names
        .filter((name) => ownerOf(name) === stems[i])
        .sort((a, b) => (a === lora ? -1 : b === lora ? 1 : a.localeCompare(b)))
      return [file, owned]
    }),
  )
}

/**
 * Renames for LoRAs whose name has "__" or a warn character (see fixLoraName). Each LoRA is renamed
 * together with the files that share its name (sidecar .json, .preview.png, .civitai.info…).
 * Returns one group per LoRA: {lora, name (the fixed name, '' when nothing is left), problems,
 * items: [{dir, newName, newPath, oldName, oldPath}]}, the LoRA itself first in `items`.
 */
export function planNameFixes(folder, safetensorFiles, warnChars = '') {
  const owned = filesOfLoras(folder, safetensorFiles)

  return safetensorFiles
    .filter((file) => nameProblems(path.basename(file, path.extname(file)), warnChars).length > 0)
    .map((file) => {
      const stem = path.basename(file, path.extname(file))
      const newStem = fixLoraName(stem, warnChars)
      const items = owned
        .get(file)
        .map((oldName) => {
          const newName = newStem + oldName.slice(stem.length)
          return {
            dir: folder,
            newName,
            newPath: path.join(folder, newName),
            oldName,
            oldPath: path.join(folder, oldName),
          }
        })
      return {items, lora: path.basename(file), name: newStem, problems: nameProblems(stem, warnChars)}
    })
}

/**
 * Sorting a folder's LoRAs into one folder per base model family (see baseModelFolder): `loras` is
 * [{file, baseModel}], baseModel being the sidecar's "sd version" (undefined without a sidecar). Each
 * LoRA moves with the files named after it; `exclude` names files that never move (loras.yaml).
 * Returns {families: Map folder → LoRA count, in name order, moves: [{baseModel, folder, lora, items}],
 * unknown: [{baseModel, lora}]}. items are as in planNameFixes. Only worth doing when families.size > 1.
 */
export function planBaseSort(folder, loras, exclude = []) {
  const owned = filesOfLoras(
    folder,
    loras.map(({file}) => file),
    exclude,
  )
  const moves = []
  const unknown = []

  for (const {baseModel, file} of loras) {
    const lora = path.basename(file)
    const family = baseModelFolder(baseModel)
    if (!family) {
      unknown.push({baseModel: typeof baseModel === 'string' ? baseModel : null, lora})
      continue
    }

    const dir = path.join(folder, family)
    const items = owned.get(file).map((name) => ({
      dir,
      newName: name,
      newPath: path.join(dir, name),
      oldName: name,
      oldPath: path.join(folder, name),
    }))
    moves.push({baseModel, folder: family, items, lora})
  }

  const counts = new Map()
  for (const move of moves) counts.set(move.folder, (counts.get(move.folder) ?? 0) + 1)
  const families = new Map([...counts].sort(([a], [b]) => a.localeCompare(b)))

  return {families, moves, unknown}
}

export default class Activation extends Command {
  static description =
    'Resolve trigger words/weight for each LoRA (creating a JSON sidecar if one is missing) and (re)generate a yaml wildcard block from all of them.'

  static examples = [
    '<%= config.bin %> lora activation ./loras',
    '<%= config.bin %> lora activation ./loras --yaml-name loras.yaml',
    '<%= config.bin %> lora activation ./loras --refresh',
    '<%= config.bin %> lora activation ./loras --xyz',
    '<%= config.bin %> lora activation ./loras --warn-chars "@&#"',
    '<%= config.bin %> lora activation ./loras --reset-warn-chars',
    '<%= config.bin %> lora activation ./loras --skip-sort-base',
  ]

  static args = {
    path: Args.string({description: 'Folder to scan (top-level only, matching the original tool).', required: true}),
  }

  static flags = {
    domain: Flags.string({
      description:
        'Civitai domain to look LoRAs up on first (default civitai.red). A LoRA it doesn\'t know is looked up on the other one; the sidecar\'s "civitai url" points to the domain that had it.',
    }),
    refresh: Flags.boolean({
      default: false,
      description:
        're-resolve weight/Civitai info even if a JSON sidecar already exists. Keeps your non-empty notes, negative text and activation text.',
    }),
    'fix-names': Flags.boolean({
      default: false,
      description: 'Rename LoRAs with "__" or a warn character in their name without asking.',
    }),
    'skip-sort-base': Flags.boolean({
      default: false,
      description:
        'Don\'t offer to sort the LoRAs into one folder per base model (illustrious/, pony/, anima/…). Without it, the sort is previewed and asked about when the folder holds LoRAs for more than one base model.',
    }),
    'reset-warn-chars': Flags.boolean({
      default: false,
      description: `Forget the saved --warn-chars, so the default (${DEFAULT_WARN_CHARS}) applies again.`,
      exclusive: ['warn-chars'],
    }),
    'warn-chars': Flags.string({
      description: `Characters to warn about in LoRA names, offering to remove them, e.g. "@&#". Saved for later runs until --reset-warn-chars. Default: ${DEFAULT_WARN_CHARS}`,
    }),
    xyz: Flags.boolean({
      default: false,
      description:
        'Print only the X/Y/Z plot values line (every LoRA prompt in quotes, comma-separated). Sidecars and the yaml file are still created/updated as usual; problems go to stderr.',
    }),
    'yaml-name': Flags.string({default: 'loras.yaml', description: 'Output yaml filename.'}),
  }

  async run() {
    const {args, flags} = await this.parse(Activation)
    const config = loadConfig()
    // civitai.red first by default; a LoRA it doesn't know is looked up on civitai.com
    const domains = domainOrder(flags.domain ?? config.domain)
    // with --xyz, stdout carries only the values line
    const log = flags.xyz ? () => {} : (message) => this.log(message)

    const folder = path.resolve(args.path)
    const findFiles = () =>
      findSafetensorFiles(folder, {recursive: false}).sort((a, b) =>
        path.basename(a).localeCompare(path.basename(b), undefined, {numeric: true, sensitivity: 'base'}),
      )
    let files = findFiles()

    const warnChars = this.warnCharsFor(flags, config)
    const badNames = planNameFixes(folder, files, warnChars)
    if (badNames.length > 0 && (await this.offerNameFixes(badNames, flags))) files = findFiles()

    if (files.length === 0) {
      if (flags.xyz) this.logToStderr('No .safetensors files found.')
      else log('No .safetensors files found.')
      return
    }

    log(`Found ${files.length} .safetensors file(s).`)
    log(`Folder: ${folder}\n`)

    const prompts = []
    // [{file, baseModel}] for the base model sort
    const bases = []
    let existingJsonCount = 0
    let createdJsonCount = 0
    let refreshedJsonCount = 0
    let fallbackWeightCount = 0
    let overriddenWeightCount = 0
    let failedCount = 0

    for (const filepath of files) {
      const filename = path.basename(filepath)
      const jsonPath = path.join(folder, `${path.basename(filename, '.safetensors')}.json`)

      log(`\n[${filename}]`)

      let json = null

      try {
        // eslint-disable-next-line no-await-in-loop
        json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
      } catch {
        json = null
      }

      try {
        if (json && !flags.refresh) {
          existingJsonCount++
          log(`  JSON: existing -> ${path.basename(jsonPath)}`)
        } else {
          log(json ? '  JSON: refreshing' : '  JSON: missing')
          log('  Civitai: checking embedded SafeTensors metadata...')

          // eslint-disable-next-line no-await-in-loop
          const discovery = await discoverCivitai(filepath, domains)

          log(`  Civitai: version ${discovery.modelVersionId} on ${discovery.domain}`)
          log(`  Source: ${discovery.source}`)
          if (discovery.hash) log(`  SHA256: ${discovery.hash}`)
          if (!discovery.modelData) log('  Model page: could not be fetched (weight search limited to version data)')
          log(`  Usage tips: ${formatSettings(discovery.settings)}`)

          const triggers = getTriggerWords(discovery.data)
          const weightResult = getPreferredWeight(discovery.data, discovery.modelData, discovery.settings)

          log(`  Trigger words: ${triggers.length ? triggers.join(', ') : '(none)'}`)
          log(`  Preferred weight: ${weightResult.weight}  (source: ${weightResult.source})`)

          if (weightResult.note) {
            overriddenWeightCount++
            log(`  NOTE: ${weightResult.note}`)
          }

          if (weightResult.source === DEFAULT_WEIGHT_SOURCE) {
            fallbackWeightCount++
            log(
              '  WARNING: no weight/strength hint found anywhere -- defaulted to 1. Check the model page manually.',
            )
          }

          const fresh = createJsonMetadata(discovery, filename, discovery.domain, weightResult)
          const merge = json ? mergeSidecar(json, fresh) : null
          json = merge ? merge.sidecar : fresh

          // eslint-disable-next-line no-await-in-loop
          await fsp.writeFile(jsonPath, JSON.stringify(json, null, 4) + '\n', 'utf8')

          if (merge) {
            refreshedJsonCount++
            const keptNote = merge.kept.length > 0 ? ` (kept your ${merge.kept.join(', ')})` : ''
            log(`  JSON: refreshed -> ${path.basename(jsonPath)}${keptNote}`)
          } else {
            createdJsonCount++
            log(`  JSON: created -> ${path.basename(jsonPath)}`)
          }
        }

        const prompt = makePrompt(filename, json)
        prompts.push(prompt)
        log(`  YAML: - ${prompt}`)
      } catch (error) {
        failedCount++
        log(`  ERROR: ${error.message}`)
        log('  Skipping this LoRA; the rest will continue.')
        if (flags.xyz) this.logToStderr(`${filename}: ${error.message} (skipped)`)
      }

      bases.push({baseModel: json?.['sd version'], file: filepath})
    }

    const sortedCount = flags['skip-sort-base'] ? 0 : await this.offerBaseSort(folder, bases, flags)

    const yamlPath = path.join(folder, flags['yaml-name'])

    await fsp.writeFile(yamlPath, prompts.map((prompt) => `- ${prompt}\n`).join(''), 'utf8')

    log(`\n${'='.repeat(72)}`)
    log('DONE')
    log('='.repeat(72))
    log(`SafeTensors:      ${files.length}`)
    log(`Existing JSON:    ${existingJsonCount}`)
    log(`Created JSON:     ${createdJsonCount}`)
    log(`Refreshed JSON:   ${refreshedJsonCount}`)
    log(`Weight fallbacks: ${fallbackWeightCount}${fallbackWeightCount > 0 ? '  <-- worth checking by hand' : ''}`)
    log(`Text overrides:   ${overriddenWeightCount}${overriddenWeightCount > 0 ? '  <-- settings said 1, text said otherwise' : ''}`)
    log(`Failed:           ${failedCount}`)
    if (sortedCount > 0) log(`Sorted by base:   ${sortedCount}`)
    log(`YAML entries:     ${prompts.length}`)
    log(`Wildcard file:    ${yamlPath}`)

    if (prompts.length === 0) return
    log('\nX/Y/Z plot values (X type "Prompt S/R"):')
    this.log(formatXyzValues(prompts))
  }

  /**
   * When the folder holds LoRAs for more than one base model family, previews moving each LoRA, with
   * its sidecar and the other files named after it, into a folder per family (illustrious/, pony/…)
   * and asks. LoRAs with an unknown base model stay, with a warning. With --xyz everything goes to
   * stderr. Returns the number of LoRAs moved.
   */
  async offerBaseSort(folder, loras, flags) {
    const say = (message) => (flags.xyz ? this.logToStderr(message) : this.log(message))
    const plan = planBaseSort(folder, loras, [flags['yaml-name']])
    if (plan.families.size < 2) return 0

    const conflicts = findRenameConflicts(plan.moves.flatMap((move) => move.items))
    // why a LoRA can't be moved, or '' when it can
    const whyNot = (move) =>
      move.items
        .filter((item) => conflicts.has(item))
        .map((item) => `${item.newName}: ${conflicts.get(item)}`)
        .join('; ')
    const movable = plan.moves.filter((move) => !whyNot(move))
    const families = [...plan.families].map(([family, count]) => `${family} ${count}`).join(', ')

    say(`\n${'='.repeat(72)}`)
    say(`LoRAs for ${plan.families.size} base models in this folder: ${families}.`)
    say(`  ${movable.length} LoRA(s) will be moved into ${new Set(movable.map((move) => move.folder)).size} folder(s):`)
    for (const family of plan.families.keys()) {
      const moves = plan.moves.filter((move) => move.folder === family)
      const state = fs.existsSync(path.join(folder, family)) ? 'existing' : 'new'
      say(`\n  ${family}/  (${state}, ${moves.length} LoRA(s))`)
      for (const move of moves) {
        const [lora, ...companions] = move.items
        const base = move.baseModel.toLowerCase() === family ? '' : `  [${move.baseModel}]`
        const also = companions.length > 0 ? ` (with ${companions.map((item) => item.oldName).join(', ')})` : ''
        const problem = whyNot(move) ? `  - can't move: ${whyNot(move)}` : ''
        say(`    ${lora.oldName}${base}${also}${problem}`)
      }
    }

    if (plan.unknown.length > 0) {
      say(`\nWARNING: ${plan.unknown.length} LoRA(s) have no known base model and stay where they are:`)
      for (const {baseModel, lora} of plan.unknown) {
        say(`  ${lora}  (${baseModel === null ? 'no sidecar' : `base model "${baseModel}"`})`)
      }
    }

    say('')
    if (movable.length === 0) return 0

    const rl = readline.createInterface({input: process.stdin, output: flags.xyz ? process.stderr : process.stdout})
    const answer = await rl.question(`Sort ${movable.length} LoRA(s) into base model folders? [y/N] `)
    rl.close()

    if (!/^y$/i.test(answer.trim())) {
      say('LoRAs left where they are.')
      return 0
    }

    let moved = 0
    for (const move of movable) {
      try {
        fs.mkdirSync(path.join(folder, move.folder), {recursive: true})
        for (const item of move.items) fs.renameSync(item.oldPath, item.newPath)
        moved++
      } catch (error) {
        say(`  ERROR moving ${move.lora}: ${error.message}`)
      }
    }

    say(`Moved ${moved} LoRA(s). Their <lora:…> tags still work: Forge finds LoRAs in subfolders by name.`)
    return moved
  }

  /**
   * The warn characters for this run. --warn-chars sets and saves them in the home config,
   * --reset-warn-chars removes the saved ones; otherwise the config (or the default) applies.
   */
  warnCharsFor(flags, config) {
    const say = (message) => (flags.xyz ? this.logToStderr(message) : this.log(message))
    let chars = config.warnChars ?? DEFAULT_WARN_CHARS
    if (flags['warn-chars'] !== undefined) {
      chars = [...new Set(flags['warn-chars'])].join('')
      const file = saveHomeSetting('warnChars', chars)
      say(`Warn characters set to "${chars}" (saved in ${file}).`)
    } else if (flags['reset-warn-chars']) {
      const file = saveHomeSetting('warnChars')
      chars = DEFAULT_WARN_CHARS
      say(`Warn characters reset to the default "${chars}" (removed from ${file}).`)
    }

    const local = loadLocalConfig().warnChars
    if (local !== undefined && local !== chars) {
      say(`Note: ./civit-tool.config.json sets warnChars "${local}", which is used instead.`)
      chars = local
    }

    return chars
  }

  /**
   * Warns about LoRA names with "__" (Dynamic Prompts reads "__" as a wildcard reference marker) or a
   * warn character, and offers to fix them. With --xyz everything goes to stderr, so stdout keeps only
   * the values line. Returns true when something was renamed.
   */
  async offerNameFixes(groups, flags) {
    const say = (message) => (flags.xyz ? this.logToStderr(message) : this.log(message))
    const conflicts = findRenameConflicts(groups.flatMap((group) => group.items))
    // why a LoRA can't be renamed, or '' when it can
    const whyNot = (group) =>
      group.name === ''
        ? 'nothing would be left of the name'
        : group.items
            .filter((item) => conflicts.has(item))
            .map((item) => `${item.newName}: ${conflicts.get(item)}`)
            .join('; ')
    const renamable = groups.filter((group) => !whyNot(group))

    say(`WARNING: ${groups.length} LoRA name(s) contain "__" or a character from the warn list.`)
    if (groups.some((group) => group.problems.includes('"__"'))) {
      say('Dynamic Prompts reads "__" as the start of a wildcard reference, so such <lora:…> tags can be misread.')
    }
    for (const group of groups) {
      const [lora, ...companions] = group.items
      const also = companions.length > 0 ? ` (with ${companions.map((item) => item.oldName).join(', ')})` : ''
      const problem = whyNot(group) ? `  - can't rename: ${whyNot(group)}` : ''
      const target = group.name === '' ? '' : ` -> ${lora.newName}`
      say(`  ${lora.oldName}${target}  [${group.problems.join(' ')}]${also}${problem}`)
    }

    if (renamable.length === 0) {
      say('')
      return false
    }

    let answer = flags['fix-names'] ? 'y' : ''
    if (!flags['fix-names']) {
      const rl = readline.createInterface({input: process.stdin, output: flags.xyz ? process.stderr : process.stdout})
      answer = await rl.question(`Rename ${renamable.length} LoRA(s)? [y/N] `)
      rl.close()
    }

    if (!/^y$/i.test(answer.trim())) {
      say('Names left as they are.\n')
      return false
    }

    let renamed = 0
    for (const group of renamable) {
      for (const item of group.items) {
        try {
          fs.renameSync(item.oldPath, item.newPath)
          renamed++
        } catch (error) {
          say(`  ERROR renaming ${item.oldName}: ${error.message}`)
        }
      }

      say(`  Renamed: ${group.items[0].oldName} -> ${group.items[0].newName}`)
    }

    say(`Renamed ${renamed} file(s). Wildcard files or saved prompts that use the old names need the new ones.\n`)
    return renamed > 0
  }
}
