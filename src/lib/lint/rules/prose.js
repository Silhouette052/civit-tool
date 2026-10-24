// Rules for prose branches (Krea 2): the entry is read as natural language, not as tags.
//
// P-tags: the entry still looks like a tag list: underscore words (`long_hair`, `score_7`), or a comma
//         piece that is a quality/count tag (`masterpiece`, `best quality`, `1girl`). One finding per entry.
// P-neg:  a negation (`no helmet`, `without text`). Krea 2 runs without a negative prompt, and naming a
//         thing primes it, so say what you want instead ("bareheaded, his face uncovered").
//
// Only literal text is scanned: refs, loras and variables are syntax. Text pulled in through a
// `__ref__` is checked where it is written. Accepted tags (a LoRA's activation tags) don't count as tag-like.

import {walkTemplate} from '../../wildcard-parser/index.js'
import {isAccepted} from '../accepted.js'

const QUALITY_TAGS = new Set([
  'masterpiece',
  'best quality',
  'high quality',
  'normal quality',
  'low quality',
  'worst quality',
  'highres',
  'absurdres',
  'very aesthetic',
  'newest',
  'solo',
])
const COUNT_TAG = /^\d+\+?(girl|boy|other)s?$/i
const UNDERSCORE_WORD = /[\p{L}\p{N}]+_[\p{L}\p{N}_]*[\p{L}\p{N}]/gu
const NEGATION = /\b(?:no|without|never|don't|do not)\s+[^\s,.;:!?(){}]+(?:\s+(?:or|and)\s+[^\s,.;:!?(){}]+)?/gi

const MAX_EXAMPLES = 3

export function checkProseTags(ctx, accepted = new Set()) {
  const tags = ctx.extracted.tags.filter((tag) => tag.kind === 'tag')
  const acceptedSpans = tags.filter((tag) => isAccepted(accepted, tag.text)).flatMap((tag) => tag.spans)
  const inAccepted = (at) => acceptedSpans.some((span) => at >= span.start && at < span.end)
  const hits = []
  for (const node of walkTemplate(ctx.entry.template)) {
    if (node.type !== 'text') continue
    for (const m of node.raw.matchAll(UNDERSCORE_WORD)) {
      if (!inAccepted(node.start + m.index)) hits.push({at: node.start + m.index, text: m[0]})
    }
  }
  for (const tag of tags) {
    if (isAccepted(accepted, tag.text)) continue
    const text = tag.text.toLowerCase().replace(/_/g, ' ')
    if (QUALITY_TAGS.has(text) || COUNT_TAG.test(text)) hits.push({at: tag.spans[0].start, text: tag.text})
  }
  if (hits.length === 0) return

  hits.sort((a, b) => a.at - b.at)
  const examples = [...new Set(hits.map((h) => h.text))]
  const shown = examples.slice(0, MAX_EXAMPLES).join(', ') + (examples.length > MAX_EXAMPLES ? ', …' : '')
  ctx.report('P-tags', hits[0].at, `${ctx.entry.branch} entry looks like Danbooru tags (${shown}); write it as prose`)
}

export function checkNegations(ctx) {
  for (const node of walkTemplate(ctx.entry.template)) {
    if (node.type !== 'text') continue
    for (const m of node.raw.matchAll(NEGATION)) {
      ctx.report(
        'P-neg',
        node.start + m.index,
        `"${m[0]}": ${ctx.entry.branch} has no negative prompt and naming a thing primes it; say what you want instead`,
      )
    }
  }
}
