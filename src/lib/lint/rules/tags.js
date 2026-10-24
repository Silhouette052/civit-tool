// R1–R4: is each tag a real, well-used, canonical Danbooru tag? Accepted tags (lint.acceptedTags) aren't asked.

import {isAccepted} from '../accepted.js'

/**
 * R4: colour words that are not tags on their own (bare colour words are invalid without a
 * compound noun). They also fail R1; R4 replaces that with a clearer message. `gold` is not here:
 * it is a real tag (the material).
 */
const COLOUR_WORDS = new Set([
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'pink',
  'black',
  'white',
  'grey',
  'gray',
  'brown',
  'silver',
  'aqua',
  'beige',
  'cyan',
  'magenta',
  'violet',
  'teal',
  'navy',
  'maroon',
  'lavender',
  'crimson',
])

/** Look up every `tag` occurrence of the entry, in one batch per entry. `accepted`: acceptedSet() of the config. */
export function checkTags(ctx, index, accepted = new Set()) {
  // Text with a stray `__` is a broken reference: S-ref reports it, so R1 would only repeat it.
  const tags = ctx.extracted.tags.filter(
    (t) => t.kind === 'tag' && !t.text.includes('__') && !isAccepted(accepted, t.text),
  )
  const results = index.lookup(tags.map((t) => t.text))
  tags.forEach((tag, i) => checkTag(ctx, tag, asA1111Reads(tag.text, results[i], index)))
}

/**
 * Parentheses around a whole tag (`((long_hair))`) are emphasis, already left out of its text. Others, such as
 * an unclosed `(long_hair`, are unknown as written, but A1111 reads a bare parenthesis as emphasis, so the
 * model sees `long_hair`. If dropping unescaped parentheses gives a known tag, judge that tag; R5 still
 * reports the parentheses. (`bow_(weapon)` is found as written, so it never gets here.)
 */
function asA1111Reads(text, result, index) {
  if (result.status !== 'unknown') return result
  const stripped = text.replace(/(?<!\\)[()]/g, '').trim()
  if (stripped === text || stripped === '') return result
  const retry = index.lookupOne(stripped)
  return retry.status === 'unknown' ? result : {...retry, input: text}
}

function checkTag(ctx, tag, result) {
  const at = tag.spans[0].start
  const where = tag.glued ? ' (glued from a {…} group: fix by hand)' : ''

  switch (result.status) {
    case 'valid':
      return
    case 'low-count':
      ctx.report('R2', at, `"${tag.text}" has only ${result.count} posts (minimum ${ctx.config.minCount})${where}`)
      return
    case 'alias': {
      const alternatives = result.suggestions?.length ? ` (or ${result.suggestions.join(', ')})` : ''
      const message = `"${tag.text}" is an alias of ${result.aliasOf}${alternatives}; aliases break generation${where}`
      // Safe to fix only when the tag is one contiguous piece of text and the alias has one target.
      if (!tag.glued && !result.suggestions?.length) {
        const replacement = inUserForm(result.aliasOf, tag.text)
        ctx.report('R3', at, message, {
          replace: tag.text,
          with: replacement,
          edits: [{start: tag.spans[0].start, end: tag.spans[0].end, text: replacement}],
        })
      } else {
        ctx.report('R3', at, message)
      }
      return
    }
    case 'unknown': {
      if (COLOUR_WORDS.has(result.normalized)) {
        ctx.report(
          'R4',
          at,
          `bare colour word "${tag.text}" is not a tag: it needs a noun, e.g. ${result.normalized}_hair${where}`,
        )
        return
      }
      const hint = result.suggestions?.length ? `; did you mean ${result.suggestions.join(', ')}?` : ''
      // the tag as written, for wc lint --calibrate (an internal field: not in the JSON findings)
      ctx.report('R1', at, `unknown tag "${tag.text}"${hint}${where}`).tag = tag.text
    }
  }
}

/**
 * The canonical tag (escaped, underscore form) written the way the user writes tags: if the
 * original used spaces and no underscores, use spaces. `--fix` never switches forms (C5).
 */
export function inUserForm(canonical, original) {
  const usesSpaces = /\s/.test(original) && !original.includes('_')
  return usesSpaces ? canonical.replace(/_/g, ' ') : canonical
}
