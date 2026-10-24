// wc lint --calibrate: the tags lint reports as unknown (R1), one row per tag, with the LoRAs whose activation text
// has it, so the user can pick which to accept (lint.acceptedTags).

import path from 'node:path'

import {findSidecarActivations} from '../loraSidecar.js'
import {normalizeTag} from '../tag-index/index.js'
import {plainTags} from './accepted.js'

const SHOWN_PLACES = 3
const MAX_TAG_WIDTH = 30

/**
 * Normalised tag → the names of the LoRAs whose sidecar activation text has it, for the sidecars in `dirs` (and
 * their subfolders with `recursive`). Read the way wc config's gather reads them: wildcard syntax is left out.
 */
export function loraTagIndex(dirs, {recursive = false} = {}) {
  const index = new Map()
  for (const dir of dirs) {
    for (const {file, text} of findSidecarActivations(dir, {recursive}).texts) {
      const lora = path.basename(file, path.extname(file))
      for (const tag of plainTags(text).tags) {
        const names = index.get(normalizeTag(tag)) ?? []
        if (!names.includes(lora)) names.push(lora)
        index.set(normalizeTag(tag), names)
      }
    }
  }

  return index
}

/**
 * The unknown tags of lint's findings (R1), one row per tag in its normalised form: {tag (the first spelling),
 * count, places: ['file:line', …], loras: [names]}. LoRA activation tags first, then the most used, then by name.
 */
export function unknownTags(findings, loraTags = new Map()) {
  const rows = new Map()
  for (const finding of findings) {
    if (finding.rule !== 'R1' || finding.tag === undefined) continue
    const key = normalizeTag(finding.tag)
    const row = rows.get(key) ?? {count: 0, loras: loraTags.get(key) ?? [], places: [], tag: finding.tag}
    row.count++
    row.places.push(`${finding.file}:${finding.line}`)
    rows.set(key, row)
  }

  const isLora = (row) => (row.loras.length > 0 ? 1 : 0)
  return [...rows.values()].sort((a, b) => isLora(b) - isLora(a) || b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Where a row's tag is used: the first few places, then how many more. */
export function placesOf(row) {
  const more = row.places.length > SHOWN_PLACES ? `, +${row.places.length - SHOWN_PLACES} more` : ''
  return row.places.slice(0, SHOWN_PLACES).join(', ') + more
}

/** The width that lines the rows' tags up (long ones run over). */
export const tagWidth = (rows) => Math.min(MAX_TAG_WIDTH, Math.max(...rows.map((row) => row.tag.length)))

/** A row as the picker and the printed list show it: the tag, how often it's used, where first, its LoRAs. */
export function rowText(row, width) {
  const loras = row.loras.length > 0 ? `  LoRA: ${row.loras.join(', ')}` : ''
  return `${row.tag.padEnd(width)}  ${String(row.count).padStart(3)}×  ${row.places[0]}${loras}`
}

/** The rows as printed without a terminal, LoRA tags marked [x], then how to accept them. */
export function formatUnknownTags(rows) {
  const width = tagWidth(rows)
  const lines = [
    `${rows.length} unknown ${rows.length === 1 ? 'tag' : 'tags'} (R1); [x] = a LoRA's activation tag:`,
    ...rows.map((row) => `${row.loras.length > 0 ? '[x]' : '[ ]'} ${rowText(row, width)}`),
    '',
  ]
  const loraTags = rows.filter((row) => row.loras.length > 0).map((row) => row.tag)
  if (loraTags.length > 0) {
    lines.push(`Accept the LoRA tags with: civit-tool wc config --accept "${loraTags.join(',')}"`)
  }

  lines.push('In a terminal, wc lint --calibrate lets you pick the tags to accept.')
  return lines.join('\n')
}
