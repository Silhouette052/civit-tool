// R5/R6: characters that must be escaped everywhere.
//
// R5: a bare `(` or `)` is read as emphasis by A1111/Forge, so one inside a tag (`bow_(weapon)`, `some (thing)`)
//     must be escaped. Emphasis itself is fine: `(text:1.2)`, and parentheses around whole tags such as
//     `(((tag)))` or `(red hair, blue eyes)` (findEmphasis in the wildcard parser).
// R6: a bare `@` breaks prompt-postprocessor. (`{@a|b}` is a sampler prefix: it lives in the group
//     header, not in text, so it is never flagged.)
//
// Only literal text is scanned: refs, loras and variables are syntax, and escaped characters are fine.

import {findEmphasis, walkTemplate} from '../../wildcard-parser/index.js'

export function checkEscaping(ctx) {
  const markup = findEmphasis(ctx.entry.value).markup
  const offsets = {R5: [], R6: []}

  for (const node of walkTemplate(ctx.entry.template)) {
    if (node.type !== 'text') continue
    for (let k = 0; k < node.raw.length; k++) {
      const ch = node.raw[k]
      if (ch === '\\') {
        k++ // escaped: fine
        continue
      }
      const pos = node.start + k
      if ((ch === '(' || ch === ')') && !markup.has(pos)) offsets.R5.push(pos)
      if (ch === '@') offsets.R6.push(pos)
    }
  }

  for (const rule of ['R5', 'R6']) {
    for (const group of groupByTag(ctx, offsets[rule])) report(ctx, rule, group)
  }
}

/** One finding per tag (so `bow_(weapon)` is one finding, not two). */
function groupByTag(ctx, offsets) {
  const groups = new Map()
  for (const pos of offsets) {
    const owner = ctx.extracted.tags.flatMap((t) => t.spans).find((s) => s.start <= pos && pos < s.end) ?? {
      start: 0,
      end: ctx.entry.value.length,
    }
    const key = `${owner.start}-${owner.end}`
    const group = groups.get(key) ?? {offsets: [], span: owner}
    group.offsets.push(pos)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function report(ctx, rule, group) {
  const original = ctx.entry.value.slice(group.span.start, group.span.end)
  let fixed = ''
  let last = group.span.start
  for (const pos of group.offsets) {
    fixed += ctx.entry.value.slice(last, pos) + '\\'
    last = pos
  }
  fixed += ctx.entry.value.slice(last, group.span.end)
  const what = rule === 'R5' ? 'unescaped parenthesis' : 'unescaped "@"'
  const why = rule === 'R5' ? 'A1111 reads it as emphasis' : 'prompt-postprocessor fails on it'
  const edits = group.offsets.map((pos) => ({start: pos, end: pos, text: '\\'}))
  ctx.report(rule, group.offsets[0], `${what} in "${original.trim()}": ${why}`, {
    replace: original.trim(),
    with: fixed.trim(),
    edits,
  })
}
