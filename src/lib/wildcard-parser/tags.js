// Which tags does an entry put in front of the model? ("lint the options, not the combinations")
//
// One rule covers every case in the real library:
//   1. Split the entry at top-level commas (outside `{}`) into segments.
//   2. Expand each segment into its variations (every choice of option in its groups, nested
//      groups included; an empty option is a choice too).
//   3. Split each variation at commas and trim: every non-empty piece is a tag.
//
//   `{red|3::white|gold|} hair`  → red hair, white hair, gold hair, hair   (group glued to text)
//   `{cape,|} {breastplate,|}`   → cape, breastplate                        (options carry commas)
//   `explosion{, embers|}`       → explosion, embers
//   `{{orb,|grimoire,} floating|}` → orb, floating, grimoire
//
// The number of variations per segment is the product of its groups' option counts. Above
// `maxVariations` (256) the segment is reported and falls back to option-by-option, so it is
// never silently skipped.
//
// `(text:1.2)` emphasis markup is found first and dropped from the tag text; the weight is kept.

export const DEFAULT_MAX_VARIATIONS = 256

// A variation is a flat list of atoms: literal text pieces `{text, start}` and indivisible
// ref/lora/variable nodes `{node}`. While a tag is built, each item is one character `{ch, pos}`
// or one such `{node}`.
//
// Result: {tags: TagOccurrence[], overflows: {offset, count}[]}. A TagOccurrence is
//   {kind: 'tag' | 'ref' | 'lora' | 'dynamic', text, spans: {start, end}[], glued, emphasis?, ref?, lora?}
// - `tag`: plain text to validate against Danbooru.
// - `ref`: a lone `__ref__` (resolved by S-ref, not validated as a tag).
// - `lora`: a `<lora:…>`.
// - `dynamic`: text mixed with a ref or variable; its final text is unknown, so it isn't validated.
// `text` is trimmed, as written (escapes kept); more than one span means glued from several pieces.

export function extractTags(value, template, options = {}) {
  const max = options.maxVariations ?? DEFAULT_MAX_VARIATIONS
  const emphasis = findEmphasis(value)
  const tags = []
  const overflows = []
  const seen = new Set()

  for (const segment of splitSegments(sliceFrom(template, options.from ?? 0))) {
    const count = countVariations(segment)
    let variations
    if (count > max) {
      overflows.push({offset: segment[0].start, count})
      variations = fallbackVariations(segment, max)
    } else {
      variations = expand(segment)
    }
    for (const variation of variations) {
      for (const tag of tagsOfVariation(variation, emphasis)) {
        const key = tag.kind + ':' + tag.spans.map((s) => `${s.start}-${s.end}`).join(',')
        if (!seen.has(key)) {
          seen.add(key)
          tags.push(tag)
        }
      }
    }
  }
  tags.sort((a, b) => a.spans[0].start - b.spans[0].start || a.text.localeCompare(b.text))
  return {tags, overflows}
}

/** Tags of a parsed entry: for `anima` entries, only the tag line after the sentence. */
export function extractEntryTags(entry, options = {}) {
  return extractTags(entry.value, entry.template, {...options, from: entry.tagLineStart ?? 0})
}

/**
 * The most tags one expansion of an entry can put in front of the model (rule S-budget).
 * Segments are independent, so this is the sum over segments of each segment's worst variation.
 * Approximations: a multi-select group counts as one pick, text glued to a ref counts as one tag,
 * and a segment over the variation cap uses its option-by-option fallback.
 */
export function countMaxTags(entry, options = {}) {
  const max = options.maxVariations ?? DEFAULT_MAX_VARIATIONS
  const refTags = options.refTags ?? (() => 1)
  const emphasis = findEmphasis(entry.value)
  let total = 0
  for (const segment of splitSegments(sliceFrom(entry.template, entry.tagLineStart ?? 0))) {
    const variations = countVariations(segment) > max ? fallbackVariations(segment, max) : expand(segment)
    let worst = 0
    for (const variation of variations) {
      let n = 0
      for (const tag of tagsOfVariation(variation, emphasis)) {
        if (tag.kind === 'ref') n += refTags(tag.ref)
        else if (tag.kind !== 'lora') n += 1
      }
      worst = Math.max(worst, n)
    }
    total += worst
  }
  return total
}

/**
 * The most words one expansion of a prose entry can have (rule S-budget for prose branches): like
 * countMaxTags, but it counts words, and a ref counts the words of its longest expansion. A word is
 * a run of non-space text with a letter or digit in it; a LoRA counts none.
 */
export function countMaxWords(entry, options = {}) {
  const max = options.maxVariations ?? DEFAULT_MAX_VARIATIONS
  const refWords = options.refWords ?? (() => 1)
  let total = 0
  for (const segment of splitSegments(entry.template)) {
    const variations = countVariations(segment) > max ? fallbackVariations(segment, max) : expand(segment)
    let worst = 0
    for (const variation of variations) {
      let n = 0
      let text = ''
      for (const atom of variation) {
        if (!('node' in atom)) {
          text += atom.text
          continue
        }
        text += ' '
        if (atom.node.type === 'ref') n += refWords(atom.node)
        else if (atom.node.type === 'variable') n += 1
      }
      n += text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
      worst = Math.max(worst, n)
    }
    total += worst
  }
  return total
}

// ---- Step 0: the part of the template after `from` -------------------------------------------

function sliceFrom(template, from) {
  if (from <= 0) return template
  const out = []
  for (const node of template) {
    if (node.end <= from) continue
    if (node.start >= from || node.type !== 'text') out.push(node)
    else out.push({...node, raw: node.raw.slice(from - node.start), start: from})
  }
  return out
}

// ---- Step 1: segments ------------------------------------------------------------------------

/** Split the top level at unescaped commas. Commas inside groups don't split. */
function splitSegments(template) {
  const segments = [[]]
  for (const node of template) {
    if (node.type !== 'text') {
      segments[segments.length - 1].push(node)
      continue
    }
    let pieceStart = 0
    for (let k = 0; k < node.raw.length; k++) {
      if (node.raw[k] === '\\') {
        k++
        continue
      }
      if (node.raw[k] === ',') {
        // Keep the comma with the piece before it: tag building splits on it again, harmlessly.
        segments[segments.length - 1].push(textPiece(node.raw, node.start, pieceStart, k + 1))
        segments.push([])
        pieceStart = k + 1
      }
    }
    if (pieceStart < node.raw.length) {
      segments[segments.length - 1].push(textPiece(node.raw, node.start, pieceStart, node.raw.length))
    }
  }
  return segments.filter((s) => s.length > 0)
}

function textPiece(raw, base, from, to) {
  return {type: 'text', raw: raw.slice(from, to), start: base + from, end: base + to}
}

// ---- Step 2: variations ----------------------------------------------------------------------

function countVariations(nodes) {
  let count = 1
  for (const node of nodes) {
    if (node.type === 'group') count *= node.options.reduce((sum, o) => sum + countVariations(o.body), 0)
  }
  return count
}

/** Every variation of `nodes`: the cartesian product over its groups. */
function expand(nodes) {
  let variations = [[]]
  for (const node of nodes) {
    if (node.type === 'group') {
      // A multi-select group (`{2$$a|b|c}`) is expanded as single picks: good enough for checking
      // tags, since its picks are joined by a separator (", " by default) anyway.
      const choices = node.options.flatMap((o) => expand(o.body))
      variations = variations.flatMap((v) => choices.map((c) => [...v, ...c]))
    } else {
      const atom = node.type === 'text' ? {text: node.raw, start: node.start} : {node}
      for (const v of variations) v.push(atom)
    }
  }
  return variations
}

/** Option-by-option fallback for a segment with too many variations. */
function fallbackVariations(nodes, max) {
  const out = [expand(nodes.filter((n) => n.type !== 'group'))[0]]
  for (const node of nodes) {
    if (node.type !== 'group') continue
    for (const option of node.options) {
      out.push(...(countVariations(option.body) > max ? fallbackVariations(option.body, max) : expand(option.body)))
    }
  }
  return out
}

// ---- Step 3: tags --------------------------------------------------------------------------

function tagsOfVariation(variation, emphasis) {
  const tags = []
  let items = []
  for (const atom of variation) {
    if ('node' in atom) {
      items.push({node: atom.node})
      continue
    }
    for (let k = 0; k < atom.text.length; k++) {
      const pos = atom.start + k
      const ch = atom.text[k]
      if (emphasis.markup.has(pos)) continue
      if (ch === '\\' && k + 1 < atom.text.length) {
        items.push({ch, pos}, {ch: atom.text[k + 1], pos: pos + 1})
        k++
        continue
      }
      if (ch === ',') {
        tags.push(...finishTag(items, emphasis))
        items = []
        continue
      }
      items.push({ch, pos})
    }
  }
  tags.push(...finishTag(items, emphasis))
  return tags
}

function finishTag(items, emphasis) {
  const out = []
  // Loras are pulled out: A1111 removes them from the prompt, so the remaining text is the tag.
  const rest = []
  for (const item of items) {
    if ('node' in item && item.node.type === 'lora') {
      out.push({kind: 'lora', text: item.node.raw, spans: [span(item.node)], glued: false, lora: item.node})
    } else {
      rest.push(item)
    }
  }

  const isSpace = (it) => 'ch' in it && /\s/.test(it.ch)
  let a = 0
  let b = rest.length
  while (a < b && isSpace(rest[a])) a++
  while (b > a && isSpace(rest[b - 1])) b--
  const trimmed = rest.slice(a, b)
  if (trimmed.length === 0) return out

  const nodes = trimmed.filter((it) => 'node' in it).map((it) => it.node)
  const text = trimmed.map((it) => ('node' in it ? it.node.raw : it.ch)).join('')
  const spans = toSpans(trimmed)
  const tag = {kind: 'tag', text, spans, glued: spans.length > 1}
  if (nodes.length > 0) {
    const onlyOneRef = trimmed.length === 1 && nodes[0].type === 'ref'
    tag.kind = onlyOneRef ? 'ref' : 'dynamic'
    if (onlyOneRef) tag.ref = nodes[0]
  }
  const weight = emphasis.weightAt(spans[0].start)
  if (weight !== undefined) tag.emphasis = weight
  out.push(tag)
  return out
}

/** Merge item positions into contiguous spans. */
function toSpans(items) {
  const spans = []
  for (const it of items) {
    const s = 'node' in it ? span(it.node) : {start: it.pos, end: it.pos + 1}
    const last = spans[spans.length - 1]
    if (last && last.end === s.start) last.end = s.end
    else spans.push(s)
  }
  return spans
}

function span(node) {
  return {start: node.start, end: node.end}
}

// ---- Emphasis ----------------------------------------------------------------------------

/**
 * Find `(text:number)` emphasis in the raw value. Only that exact form counts; any other
 * bare `(`…`)` stays as text (rule R5 in lint flags it). Escaped `\(` `\)` are never markup.
 */
export function findEmphasis(value) {
  const markup = new Set()
  const ranges = []
  const stack = []
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') stack.push(i)
    else if (ch === ')' && stack.length > 0) {
      const open = stack.pop()
      const m = /:(\d+(?:\.\d+)?|\.\d+)$/.exec(value.slice(open + 1, i))
      if (m) {
        const colon = i - m[0].length
        markup.add(open)
        for (let k = colon; k <= i; k++) markup.add(k)
        ranges.push({open, close: i, weight: Number(m[1])})
      }
    }
  }
  return {
    markup,
    weightAt(pos) {
      let best
      for (const r of ranges) {
        if (r.open < pos && pos < r.close && (!best || r.open > best.open)) best = r
      }
      return best?.weight
    },
  }
}
