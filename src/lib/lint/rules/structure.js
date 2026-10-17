// Structural rules per entry: S-expand, S-ref, S-range, S-dup (within an entry), S-budget.

import {normalizeTag} from '../../tag-index/index.js'
import {walkTemplate, countMaxTags, countMaxWords, resolveRef} from '../../wildcard-parser/index.js'

/** S-expand: a tag with more glued variations than the cap (it was checked option by option). */
export function checkExpand(ctx) {
  for (const o of ctx.extracted.overflows) {
    ctx.report(
      'S-expand',
      o.offset,
      `a tag here has ${o.count} variations (cap ${ctx.config.maxVariations}); its options were checked one by one`,
    )
  }
}

/** S-ref: every `__ref__` must match at least one leaf key; a stray `__` is a broken marker. */
export function checkRefs(ctx, library) {
  for (const node of walkTemplate(ctx.entry.template)) {
    if (node.type === 'ref' && resolveRef(library, node.name).length === 0) {
      const what = node.glob ? 'glob matches no wildcard' : 'reference matches no wildcard'
      ctx.report('S-ref', node.start, `${what}: ${node.raw}`)
    }
    if (node.type === 'text') {
      // A `__` left in text means a reference that didn't parse (unclosed, or a space inside).
      // No Danbooru tag contains `__`, so this never hits a real tag.
      const at = node.raw.indexOf('__')
      if (at !== -1) ctx.report('S-ref', node.start + at, `unmatched "__" marker in "${node.raw.trim()}"`)
    }
  }
}

/** S-range: a multi-select group must be able to pick what it asks for. */
export function checkRanges(ctx) {
  for (const node of walkTemplate(ctx.entry.template)) {
    if (node.type !== 'group' || !node.select) continue
    const options = node.options.length
    const min = node.select.min ?? 1
    const max = node.select.max ?? options
    // `{2$$__colors__}` picks from the referenced wildcard, so its option count isn't the limit.
    const picksFromRef = node.options.some((o) => o.body.length === 1 && o.body[0].type === 'ref')
    let problem = ''
    if (min > max) problem = `min ${min} is above max ${max}`
    else if (max === 0) problem = 'it picks nothing'
    else if (!picksFromRef && (min > options || (node.select.max !== undefined && max > options))) {
      problem = `it asks for ${min === max ? min : `${min}-${max}`} picks but has only ${options} option(s)`
    }
    if (problem) ctx.report('S-range', node.start, `impossible selection "{${node.headerRaw}…}": ${problem}`)
  }
}

/** S-dup (entry level): the same always-present tag twice in one entry. */
export function checkDuplicateTags(ctx) {
  // "Always present" = not inside any group and not glued: those appear in every expansion.
  const groups = ctx.entry.template.filter((n) => n.type === 'group')
  const seen = new Set()
  for (const tag of ctx.extracted.tags) {
    if (tag.kind !== 'tag' || tag.glued) continue
    const at = tag.spans[0].start
    if (groups.some((g) => g.start < at && at < g.end)) continue
    const key = normalizeTag(tag.text)
    if (seen.has(key)) ctx.report('S-dup', at, `"${tag.text}" appears twice in this entry`)
    seen.add(key)
  }
}

/**
 * S-budget: the most tags one expansion can produce, following refs recursively. Prose entries
 * count words instead, against `maxWordsPerEntry`.
 */
export function checkBudget(ctx, budgets) {
  const maxVariations = ctx.config.maxVariations
  if (ctx.entry.style === 'prose') {
    const n = countMaxWords(ctx.entry, {maxVariations, refWords: budgets.words})
    if (n > ctx.config.maxWordsPerEntry) {
      ctx.report('S-budget', 0, `this entry can expand to ${n} words (budget ${ctx.config.maxWordsPerEntry})`)
    }
    return
  }
  const n = countMaxTags(ctx.entry, {maxVariations, refTags: budgets.tags})
  if (n > ctx.config.maxTagsPerEntry) {
    ctx.report('S-budget', 0, `this entry can expand to ${n} tags (budget ${ctx.config.maxTagsPerEntry})`)
  }
}

/** Ref budgets for checkBudget: the most tags and the most words each ref can expand to. */
export function makeRefBudgets(library, maxVariations) {
  return {
    tags: makeRefBudget(library, (entry, refTags) => countMaxTags(entry, {maxVariations, refTags})),
    words: makeRefBudget(library, (entry, refWords) => countMaxWords(entry, {maxVariations, refWords})),
  }
}

/**
 * Memoised "how many tags (or words) can this ref expand to": the worst leaf it may pick, and in that
 * leaf the worst entry, as `countEntry` counts it. A reference cycle counts as 0 for the repeated
 * step, so it terminates.
 */
function makeRefBudget(library, countEntry) {
  const byLeaf = new Map()
  const inProgress = new Set()
  const refCount = (ref) => {
    const leaves = resolveRef(library, ref.name)
    if (leaves.length === 0) return 1 // unresolved: S-ref reports it; count it as one
    let worst = 0
    for (const leaf of leaves) {
      if (!byLeaf.has(leaf.path)) {
        if (inProgress.has(leaf.path)) continue
        inProgress.add(leaf.path)
        const n = Math.max(0, ...leaf.entries.map((e) => countEntry(e, refCount)))
        inProgress.delete(leaf.path)
        byLeaf.set(leaf.path, n)
      }
      worst = Math.max(worst, byLeaf.get(leaf.path))
    }
    return worst
  }
  return refCount
}
