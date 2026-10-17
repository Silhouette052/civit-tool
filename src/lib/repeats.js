// Repeated phrases and tag runs across wildcard entries (wc repeats): text that could live in one
// shared leaf and be pulled in with a __reference__.
//
// Each entry is read as runs of tokens, by its branch style (see DEFAULT_BRANCHES):
// - prose (krea): words. Case, and punctuation at a word's edges, don't matter: `cape,` = `Cape`.
// - tags (ill, simple, no branch): the comma-separated tags. Case doesn't matter, `_` = space.
// - sentence (anima): the sentence as words, then the tag line as tags.
// A `__ref__`, `{…}` group, `<lora:…>` or `${…}` inside a run is one token, compared as written.
//
// In order (default): every run of at least `minWords` words / `minTags` tags that appears twice or
// more, in its longest form: a run is reported only where it can't be extended to the left or right
// with the same occurrences, so a 12-word repeat isn't also eight 5-word ones. Found with a suffix
// array over all tokens, with a unique separator after each run so no match crosses entries.
//
// Any order (`anyOrder`, tags only): every set of at least `minTags` tags that two or more entries
// share, in its largest form (all the tags those entries have in common).
//
// Runs made only of __refs__ are skipped: that text is already shared.

import {entryPosition, globToRegExp} from './wildcard-parser/index.js'

/**
 * @returns {{unit: 'words' | 'tags', anyOrder: boolean, length: number, text: string,
 *   occurrences: {file: string, line: number, col: number, keyPath: string}[]}[]}
 *   sorted by size (length × extra copies), biggest first.
 */
export function findRepeats(files, {minWords = 5, minTags = 5, anyOrder = false, path} = {}) {
  const keep = path ? globToRegExp(path) : null
  const runs = []
  for (const file of files) {
    for (const entry of file.entries) {
      if (keep && !keep.test(entry.keyPath)) continue
      for (const run of tokenizeEntry(entry)) {
        if (run.tokens.length >= (run.unit === 'words' ? minWords : minTags)) runs.push({file, entry, ...run})
      }
    }
  }

  const ordered = anyOrder ? runs.filter((r) => r.unit === 'words') : runs
  const repeats = [...findOrderedRepeats(ordered, {words: minWords, tags: minTags})]
  if (anyOrder)
    repeats.push(
      ...findTagSetRepeats(
        runs.filter((r) => r.unit === 'tags'),
        minTags,
      ),
    )

  const size = (r) => r.length * (r.occurrences.length - 1)
  return repeats.sort((a, b) => size(b) - size(a) || b.length - a.length || a.text.localeCompare(b.text))
}

// ---- Tokens ---------------------------------------------------------------------------------

/** An entry's token runs: [{unit, tokens: [{key, start, end, ref}]}]; offsets index into entry.value. */
export function tokenizeEntry(entry) {
  if (entry.style === 'prose') return [{unit: 'words', tokens: wordTokens(entry.template)}]
  if (entry.style === 'sentence' && entry.tagLineStart !== undefined) {
    const [sentence, tagLine] = splitTemplate(entry.template, entry.tagLineStart)
    return [
      {unit: 'words', tokens: wordTokens(sentence)},
      {unit: 'tags', tokens: tagTokens(tagLine)},
    ]
  }
  return [{unit: 'tags', tokens: tagTokens(entry.template)}]
}

function wordTokens(nodes) {
  const tokens = []
  for (const node of nodes) {
    if (node.type !== 'text') {
      tokens.push({key: 'w:' + node.raw, start: node.start, end: node.end, ref: node.type === 'ref'})
      continue
    }
    for (const m of node.raw.matchAll(/\S+/g)) {
      const word = m[0].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (word) tokens.push({key: 'w:' + word, start: node.start + m.index, end: node.start + m.index + m[0].length})
    }
  }
  return tokens
}

/** Tags: split at top-level commas (commas inside groups and escaped `\,` don't split). */
function tagTokens(nodes) {
  const tokens = []
  let parts = [] // contiguous pieces of one tag: {text, start, end, node?}
  const finish = () => {
    const text = parts.map((p) => p.text).join('')
    const key = text.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ')
    if (key) {
      const solid = parts.filter((p) => p.node || p.text.trim())
      tokens.push({
        key: 't:' + key,
        start: parts[0].start + (text.length - text.trimStart().length),
        end: parts[parts.length - 1].end - (text.length - text.trimEnd().length),
        ref: solid.length === 1 && solid[0].node?.type === 'ref',
      })
    }
    parts = []
  }
  for (const node of nodes) {
    if (node.type !== 'text') {
      parts.push({text: node.raw, start: node.start, end: node.end, node})
      continue
    }
    let from = 0
    for (let k = 0; k < node.raw.length; k++) {
      if (node.raw[k] === '\\') {
        k++
        continue
      }
      if (node.raw[k] !== ',') continue
      if (k > from) parts.push({text: node.raw.slice(from, k), start: node.start + from, end: node.start + k})
      if (parts.length > 0) finish()
      from = k + 1
    }
    if (from < node.raw.length) {
      parts.push({text: node.raw.slice(from), start: node.start + from, end: node.end})
    }
  }
  if (parts.length > 0) finish()
  return tokens
}

/** The top-level template nodes before and after a value offset (a text node is cut in two). */
function splitTemplate(template, at) {
  const before = []
  const after = []
  for (const node of template) {
    if (node.end <= at) before.push(node)
    else if (node.start >= at) after.push(node)
    else {
      const cut = at - node.start
      before.push({...node, raw: node.raw.slice(0, cut), end: at})
      after.push({...node, raw: node.raw.slice(cut), start: at})
    }
  }
  return [before, after]
}

// ---- In order -------------------------------------------------------------------------------

function* findOrderedRepeats(runs, min) {
  // One token sequence; a unique negative separator ends every run.
  const ids = new Map()
  const seq = []
  const where = [] // seq index → {run, index}
  runs.forEach((run, r) => {
    run.tokens.forEach((token, index) => {
      if (!ids.has(token.key)) ids.set(token.key, ids.size)
      seq.push(ids.get(token.key))
      where.push({run, index})
    })
    seq.push(-1 - r)
    where.push(null)
  })

  const sa = []
  for (let i = 0; i < seq.length; i++) if (seq[i] >= 0) sa.push(i)
  const common = (a, b) => {
    let k = 0
    while (seq[a + k] >= 0 && seq[a + k] === seq[b + k]) k++
    return k
  }
  sa.sort((a, b) => {
    const k = common(a, b)
    return seq[a + k] - seq[b + k]
  })
  const lcp = [0]
  for (let i = 1; i < sa.length; i++) lcp.push(common(sa[i - 1], sa[i]))
  lcp.push(0)

  // Bottom-up walk over the LCP intervals: each interval with lcp L is a run of L tokens that
  // occurs at every suffix in it, and can't be extended to the right with the same occurrences.
  const threshold = Math.min(min.words, min.tags)
  const stack = [{lcp: 0, lb: 0}]
  for (let i = 1; i <= sa.length; i++) {
    let lb = i - 1
    while (lcp[i] < stack[stack.length - 1].lcp) {
      const interval = stack.pop()
      lb = interval.lb
      if (interval.lcp >= threshold) {
        const repeat = orderedRepeat(sa.slice(interval.lb, i), interval.lcp, seq, where, min)
        if (repeat) yield repeat
      }
    }
    if (lcp[i] > stack[stack.length - 1].lcp) stack.push({lcp: lcp[i], lb})
  }
}

function orderedRepeat(positions, length, seq, where, min) {
  const first = where[positions[0]]
  if (length < min[first.run.unit]) return null
  // Left-maximal: if every occurrence has the same token before it, the longer run is the repeat.
  const before = new Set(positions.map((p) => (p === 0 ? -Infinity : seq[p - 1])))
  if (before.size === 1 && [...before][0] >= 0) return null
  if (first.run.tokens.slice(first.index, first.index + length).every((t) => t.ref)) return null

  const occurrences = positions
    .map((p) => where[p])
    .sort(
      (a, b) =>
        a.run.file.path.localeCompare(b.run.file.path) || a.run.entry.line - b.run.entry.line || a.index - b.index,
    )
    .map(({run, index}) => occurrence(run, run.tokens[index].start))
  const head = first.run.tokens[first.index]
  const tail = first.run.tokens[first.index + length - 1]
  return {
    unit: first.run.unit,
    anyOrder: false,
    length,
    text: first.run.entry.value.slice(head.start, tail.end),
    occurrences,
  }
}

function occurrence(run, offset) {
  const {line, col} = entryPosition(run.file, run.entry, offset)
  return {file: run.file.path, line, col, keyPath: run.entry.keyPath}
}

// ---- Any order (tags) -----------------------------------------------------------------------

function findTagSetRepeats(runs, minTags) {
  const sets = runs.map((run) => new Set(run.tokens.map((t) => t.key)))
  const index = new Map() // tag → run indexes, ascending
  sets.forEach((set, i) => {
    for (const key of set) {
      if (!index.has(key)) index.set(key, [])
      index.get(key).push(i)
    }
  })
  const isRef = new Set(runs.flatMap((run) => run.tokens.filter((t) => t.ref).map((t) => t.key)))

  const seenPairs = new Set()
  const found = new Map() // sorted tags → run indexes
  for (let i = 0; i < sets.length; i++) {
    const shared = new Map()
    for (const key of sets[i]) for (const j of index.get(key)) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1)
    for (const [j, count] of shared) {
      if (count < minTags) continue
      const both = [...sets[i]].filter((key) => sets[j].has(key)).sort()
      const pairKey = both.join('\0')
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      // Every run with all these tags, and the tags those runs all share: the largest form.
      const support = both.reduce((acc, key) => acc.filter((r) => sets[r].has(key)), index.get(both[0]))
      const closure =
        both.length === 0 ? [] : [...sets[support[0]]].filter((key) => support.every((r) => sets[r].has(key)))
      const closureKey = closure.sort().join('\0')
      if (!found.has(closureKey) && !closure.every((key) => isRef.has(key))) found.set(closureKey, support)
    }
  }

  return [...found].map(([closureKey, support]) => {
    const tags = new Set(closureKey.split('\0'))
    const first = runs[support[0]]
    const inOrder = first.tokens.filter(
      (t, k) => tags.has(t.key) && first.tokens.findIndex((u) => u.key === t.key) === k,
    )
    return {
      unit: 'tags',
      anyOrder: true,
      length: tags.size,
      text: inOrder.map((t) => first.entry.value.slice(t.start, t.end)).join(', '),
      occurrences: support.map((r) => occurrence(runs[r], runs[r].tokens[0].start)),
    }
  })
}

// ---- Output ---------------------------------------------------------------------------------

const MAX_TEXT = 160
const MAX_SHOWN = 10

/** One block per repeat: the size and text, then where it occurs. `total`: how many were found before --top. */
export function formatRepeats(repeats, total = repeats.length) {
  const lines = []
  for (const r of repeats) {
    const text = r.text.length > MAX_TEXT ? r.text.slice(0, MAX_TEXT - 1) + '…' : r.text
    const order = r.anyOrder ? ', any order' : ''
    lines.push(`${r.length} ${r.unit} × ${r.occurrences.length}${order}  "${text}"`)
    for (const o of r.occurrences.slice(0, MAX_SHOWN)) lines.push(`  ${o.file}:${o.line}:${o.col}  ${o.keyPath}`)
    if (r.occurrences.length > MAX_SHOWN) lines.push(`  … and ${r.occurrences.length - MAX_SHOWN} more`)
    lines.push('')
  }
  const phrases = repeats.filter((r) => r.unit === 'words').length
  const tagRuns = repeats.length - phrases
  if (total === 0) lines.push('No repeats found.')
  else if (total > repeats.length)
    lines.push(`The ${repeats.length} biggest of ${total} repeats: ${phrases} in words, ${tagRuns} in tags`)
  else lines.push(`${total} repeat(s): ${phrases} in words, ${tagRuns} in tags`)
  return lines.join('\n')
}
