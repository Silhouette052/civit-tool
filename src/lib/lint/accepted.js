// Accepted tags (`lint.acceptedTags`): tags that aren't Danbooru tags but are right as written, such as a LoRA's
// activation tags. Lint skips the Danbooru checks for them (R1–R4, so --fix never "corrects" one either) and P-tags,
// everywhere in the library. They match in the normalised form (C5): case, spaces or underscores, and escapes
// don't matter. Syntax rules (R5/R6 escaping, S-dup) still apply.

import {normalizeTag} from '../tag-index/index.js'
import {extractTags, parseTemplate} from '../wildcard-parser/index.js'

/** The normalised forms of the accepted tags, for isAccepted(). */
export const acceptedSet = (tags = []) => new Set(tags.map((tag) => normalizeTag(tag)))

/** Whether a tag is accepted as written, or as A1111 reads it with bare ( ) taken as emphasis. */
export function isAccepted(accepted, text) {
  if (accepted.size === 0) return false
  return accepted.has(normalizeTag(text)) || accepted.has(normalizeTag(text.replace(/(?<!\\)[()]/g, '')))
}

/**
 * The plain tags of prompt text as lint reads them ((tag:1.2) gives tag), leaving out each wildcard construct
 * whole: a {…|…} group with the tags in its options, which are ordinary prompt tags lint goes on checking, a
 * __reference__, a <lora:…> and a ${variable}. Returns {tags, dropped}, dropped being the constructs as written.
 */
export function plainTags(text) {
  const {template} = parseTemplate(text)
  const constructs = template.filter((node) => node.type !== 'text')
  const inConstruct = (span) => constructs.some((node) => span.start < node.end && span.end > node.start)
  const tags = extractTags(text, template)
    .tags.filter((tag) => tag.kind === 'tag' && !tag.text.includes('__') && !tag.spans.some(inConstruct))
    .map((tag) => tag.text)
  return {dropped: constructs.map((node) => text.slice(node.start, node.end)), tags}
}

const sortKey = (tag) => normalizeTag(tag)

/**
 * The list after adding `add` and removing `remove`: one tag per normalised form (the first spelling stays),
 * sorted. Throws, naming them, when a tag to remove isn't in the list.
 */
export function mergeAccepted(current = [], add = [], remove = []) {
  const byForm = new Map()
  for (const tag of [...current, ...add]) {
    const text = tag.trim()
    if (text && !byForm.has(sortKey(text))) byForm.set(sortKey(text), text)
  }

  const missing = remove.filter((tag) => !byForm.has(sortKey(tag)))
  if (missing.length > 0) throw new Error(`Not an accepted tag: ${missing.join(', ')}.`)
  for (const tag of remove) byForm.delete(sortKey(tag))
  return [...byForm.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, tag]) => tag)
}

/** A config's acceptedTags must be a list of tags. `where` names the source in the error. */
export function validateAcceptedTags(tags, where) {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
    throw new Error(`${where}: lint.acceptedTags must be a list of tags, e.g. ["EdoEraAnime"]`)
  }
}
