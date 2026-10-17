// Expands sd-dynamic-prompts wildcards into every prompt they can produce, following its combinatorial mode
// (dynamicprompts/samplers/combinatorial.py):
// - `{a|b}` variants, nested, with empty options `{|a}`. Weights `{2::a|b}` don't matter: every option is used.
//   Sampler marks `~` / `@` are ignored too, so `{~a|b}` is expanded like `{a|b}`.
// - `{2$$a|b|c}` / `{1-2$$ and $$a|b|c}`: every ordered pick without repeats ("a,b" and "b,a"), joined with ","
//   (dynamicprompts' default) or the given separator. `{2$$__ref__}` picks from the wildcard's entries.
//   Prompt-postprocessor's `__2-3$$name__` works the same way, and its `r` flag allows repeats.
// - `__path__` references. `*` matches within one path segment, `**` across segments. A glob uses every matching
//   wildcard. Like the extension, a reference that matches nothing is retried as `__**/path__`.
//   The path given on the command line may also pick siblings with `{a|b}`, e.g. `lib/{hair|eyes}/*`.
// - Escapes (`\(`, `\{`, `\@`, …) are kept verbatim and never act as syntax.
// Kept verbatim, with a warning: `${variables}`, prompt-postprocessor `<ppp:…>` commands and its `'filter'` /
// `(var=value)` reference extras.
//
// Ported from tarsasest/tshirt_template/tools/expand-wildcards.mjs.
//
// sortWildcardKeys (the `wc sort` command) sorts a file's keys by name under a path, keeping comments.

import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

import {printWildcardFile} from './wildcard-parser/yaml-file.js'

export class ExpandError extends Error {}

// ── Wildcard library: every YAML key that holds a list is a wildcard ──────────────────────────────────────

/** Leaf path → entries, in file order. Keys holding a single value are ignored, as in sd-dynamic-prompts. */
export function parseLibrary(text, warn = () => {}, source = 'input') {
  const doc = YAML.parseDocument(text)
  if (doc.errors.length > 0) throw new ExpandError(`${source}: ${doc.errors[0].message}`)

  const leaves = new Map()
  const deref = (node) => (YAML.isAlias(node) ? node.resolve(doc) : node)

  const walk = (node, keyPath) => {
    node = deref(node)
    if (YAML.isMap(node)) {
      for (const pair of node.items) {
        const key = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
        walk(pair.value, keyPath ? `${keyPath}/${key}` : key)
      }
    } else if (YAML.isSeq(node)) {
      const entries = []
      for (const raw of node.items) {
        const item = deref(raw)
        if (item === null || item === undefined || YAML.isScalar(item)) {
          entries.push(item?.value === null || item?.value === undefined ? '' : String(item.value))
        } else {
          warn(
            `${keyPath}: a list item is not plain text (an entry that starts with "{" must be quoted); it was skipped`,
          )
        }
      }

      leaves.set(keyPath, entries)
    }
  }

  walk(doc.contents, '')
  return leaves
}

/** As given (relative to the current folder), else a bare file name inside the configured wildcards folder. */
export function findInput(given, wildcardsDir) {
  const direct = path.resolve(given)
  if (fs.existsSync(direct)) return direct

  if (wildcardsDir && path.basename(given) === given) {
    const inWildcards = path.resolve(wildcardsDir, given)
    if (fs.existsSync(inWildcards)) return inWildcards
  }

  return null
}

/** The files to read for a command that takes several paths: a file as is, a folder's .yaml/.yml files. */
export function findYamlFiles(given, wildcardsDir) {
  const target = findInput(given, wildcardsDir)
  if (!target) throw new Error(`No such file or folder: ${path.resolve(given)}`)
  if (!fs.statSync(target).isDirectory()) return [target]
  return fs
    .readdirSync(target, {recursive: true})
    .filter((p) => /\.ya?ml$/i.test(p))
    .sort()
    .map((p) => path.join(target, p))
}

export function loadLibrary(file, warn) {
  return parseLibrary(fs.readFileSync(file, 'utf8'), warn, file)
}

/**
 * `*` stays inside one path segment, `**` crosses segments, `{a|b}` matches either alternative (nested, with
 * globs inside, e.g. `lib/{hair|eyes/*}/color`). Everything else is literal.
 */
function globToRegExp(pattern, ignoreCase = false) {
  let source = ''
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (pattern[i] === '*') {
      source += '[^/]*'
    } else if (pattern[i] === '{') {
      source += '(?:'
      depth++
    } else if (pattern[i] === '}' && depth > 0) {
      source += ')'
      depth--
    } else if (pattern[i] === '|' && depth > 0) {
      source += '|'
    } else {
      source += pattern[i].replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }

  if (depth > 0) throw new ExpandError(`__${pattern}__ has an unclosed "{"`)
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '')
}

// ── Template syntax ───────────────────────────────────────────────────────────────────────────────────────

// Sticky regexes, matched at an exact position through `lastIndex`.
// Group header: sampler, prompt-postprocessor flags (r = repeats allowed), range, separator.
const HEADER = /([~@])?(?:([ro]*)(\d+(?:-\d*)?|-\d+)?\$\$(?:([^${}]*?)\$\$)?)?/y
const WEIGHT = /\s*(?:\d+(?:\.\d+)?|\.\d+)\s*::/y
// __[params$$]name['filter'][(vars)]__ ; the name has no spaces, commas or variant syntax (as in wc lint).
const REF = /__(?:([^\s,{}|$]*)\$\$)?([^\s,{}|'()_][^\s,{}|'()]*?)(?:'([^']*)')?(?:\(([^)]*)\))?__/y

/** `2` → exactly 2, `1-3`, `-3` (1 to 3), `2-` (2 to all). No range: a normal one-option variant. */
function parseRange(text) {
  if (text === undefined) return {max: 1, min: 1, multi: false}
  if (!text.includes('-')) return {max: Number(text), min: Number(text), multi: true}
  const [lo, hi] = text.split('-')
  return {max: hi === '' ? Infinity : Number(hi), min: lo === '' ? 1 : Number(lo), multi: true}
}

/**
 * One entry → nodes: {t: 'text', v} | {t: 'ref', name} | {t: 'group', options: nodes[][], multi, min, max, sep, repeat}.
 * Throws on an unclosed "{"; reports oddities through `warn`.
 */
export function parseTemplate(src, warn = () => {}) {
  let i = 0

  function sequence(inGroup) {
    const nodes = []
    let text = ''
    const flush = () => {
      if (text) nodes.push({t: 'text', v: text})
      text = ''
    }

    while (i < src.length) {
      const ch = src[i]
      if (ch === '\\' && i + 1 < src.length) {
        text += src.slice(i, i + 2) // an escaped character is always literal
        i += 2
        continue
      }

      if (inGroup && (ch === '|' || ch === '}')) break
      if (ch === '{') {
        flush()
        nodes.push(group())
        continue
      }

      if (ch === '}') warn('has a "}" without a matching "{"; it was kept as text')
      if (src.startsWith('__', i)) {
        REF.lastIndex = i
        const m = REF.exec(src)
        if (m) {
          flush()
          nodes.push(refNode(m))
          i = REF.lastIndex
          continue
        }

        warn('has a "__" that is not a wildcard reference; it was kept as text')
        text += '__'
        i += 2
        continue
      }

      if (src.startsWith('${', i)) {
        const end = closingBrace(i + 1)
        if (end !== -1) {
          warn(`uses a variable (${src.slice(i, end + 1)}); variables are not expanded, it was kept as text`)
          text += src.slice(i, end + 1)
          i = end + 1
          continue
        }
      }

      if (src.startsWith('<ppp:', i)) warn('uses a prompt-postprocessor <ppp:…> command; it was kept as text')
      text += ch
      i++
    }

    flush()
    return nodes
  }

  function group() {
    const at = i
    i++ // '{'
    HEADER.lastIndex = i
    const h = HEADER.exec(src) // always matches: every part is optional
    i = HEADER.lastIndex
    const g = {options: [], t: 'group', ...parseRange(h[3]), repeat: (h[2] ?? '').includes('r'), sep: h[4] ?? ','}
    for (;;) {
      WEIGHT.lastIndex = i
      if (WEIGHT.exec(src)) i = WEIGHT.lastIndex // weights don't matter when every option is used
      g.options.push(sequence(true))
      if (src[i] === '|') {
        i++
        continue
      }

      if (src[i] === '}') {
        i++
        return g
      }

      throw new ExpandError(`has an unclosed "{" (character ${at + 1})`)
    }
  }

  function refNode(m) {
    const [raw, params, name, filter, vars] = m
    if (filter !== undefined || vars !== undefined) {
      warn(`uses prompt-postprocessor extras in ${raw}; the filter / variables were ignored`)
    }

    const ref = {name: name.replace(/^[~@]/, ''), t: 'ref'} // __~name__ / __@name__: sampler marks
    const p = params === undefined ? null : /^[~@]?([ro]*)(\d+(?:-\d*)?|-\d+)?$/.exec(params)
    if (params !== undefined && !p) warn(`uses unknown reference parameters in ${raw}; they were ignored`)
    if (!p || p[2] === undefined) return ref
    // prompt-postprocessor `__2-3$$name__` = `{2-3$$__name__}`
    return {options: [[ref]], t: 'group', ...parseRange(p[2]), repeat: p[1].includes('r'), sep: ','}
  }

  /** Index of the "}" closing the "{" at `open`, or -1. */
  function closingBrace(open) {
    let depth = 0
    for (let j = open; j < src.length; j++) {
      if (src[j] === '\\') j++
      else if (src[j] === '{') depth++
      else if (src[j] === '}' && --depth === 0) return j
    }

    return -1
  }

  return sequence(false)
}

// ── Expansion ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Words in an entry as written, all its options included: the pieces between spaces, commas and the
 * `{ } | ( )` marks that contain a letter. `star (sky), {2$$knight|samurai}` has 4 (`2$$knight` is one).
 */
export function countWords(text) {
  return text.split(/[\s,{}|()]+/).filter((piece) => /\p{L}/u.test(piece)).length
}

/**
 * `keepWords`: an entry with at least this many words is not expanded but used as it is written, as
 * one plain-text option (its variants and references are left for Dynamic Prompts to pick from).
 * `kept` collects those entries. Generation yields a placeholder `\0<index>\0` for each, so the
 * whitespace clean-up in expandWildcard leaves them exactly as written.
 */
export function createExpander(leaves, warn = () => {}, {keepWords = Infinity} = {}) {
  const kept = [] // entries used as written
  const parsed = new Map() // entry text → nodes
  const counted = new Map() // leaf path → number of combinations
  const counting = new Set() // leaf paths being counted (cycle check)

  function match(pattern, ignoreCase) {
    const re = globToRegExp(pattern, ignoreCase)
    return [...leaves.keys()].filter((key) => re.test(key))
  }

  /** Leaf paths for a reference. A miss is retried as **\/name, like sd-dynamic-prompts does. */
  function resolveRef(name, where) {
    let keys = match(name)
    if (keys.length === 0 && !name.startsWith('**')) {
      keys = match(`**/${name}`)
      if (keys.length > 0)
        warn(`${where}: __${name}__ matched nothing, so __**/${name}__ was used (as Dynamic Prompts does)`)
    }

    if (keys.length === 0) throw new ExpandError(`${where}: __${name}__ matches no wildcard${suggest(name)}`)
    return keys
  }

  /** A hint for error messages: the pattern names a folder of wildcards, or up to 5 leaf paths that end like it. */
  function suggest(pattern) {
    const inside = match(`${pattern}/**`, true).length
    if (inside) return `. It is a folder of ${inside} wildcards: use __${pattern}/*__ or __${pattern}/**__`
    const last = pattern.split('/').pop().replaceAll('*', '').toLowerCase()
    const close = last ? [...leaves.keys()].filter((key) => key.toLowerCase().endsWith(last)).slice(0, 5) : []
    return close.length > 0 ? `. Did you mean: ${close.map((k) => `__${k}__`).join(', ')}?` : ''
  }

  function entryNodes(text, key) {
    let nodes = parsed.get(text)
    if (!nodes && countWords(text) >= keepWords) {
      nodes = [{i: kept.push(text) - 1, t: 'kept'}]
      parsed.set(text, nodes)
    }

    if (!nodes) {
      try {
        nodes = parseTemplate(text, (msg) => warn(`${key}: an entry ${msg}: ${text}`))
      } catch (error) {
        if (error instanceof ExpandError) throw new ExpandError(`${key}: an entry ${error.message}: ${text}`)
        throw error
      }

      parsed.set(text, nodes)
    }

    return nodes
  }

  /** A multi-select's choices: its options, or the entries of `{2$$__ref__}`'s wildcard. */
  function choices(g, where) {
    const only = g.options.length === 1 && g.options[0].length === 1 ? g.options[0][0] : null
    if (!g.multi || only?.t !== 'ref') return g.options.map((nodes) => ({key: null, nodes}))
    return resolveRef(only.name, where).flatMap((key) =>
      leaves.get(key).map((text) => ({key, nodes: entryNodes(text, key)})),
    )
  }

  /** The clamped pick range: dynamicprompts never picks more choices than there are. */
  const bounds = (g, n) => [Math.min(g.min, n), Math.min(g.max, n)]

  // Counting (memoised per leaf) lets us refuse huge expansions before generating anything.
  function countLeaf(key) {
    if (counted.has(key)) return counted.get(key)
    if (counting.has(key)) throw new ExpandError(`reference cycle: ${[...counting, key].join(' → ')}`)
    counting.add(key)
    const n = leaves.get(key).reduce((sum, text) => sum + countSeq(entryNodes(text, key), key), 0)
    counting.delete(key)
    counted.set(key, n)
    return n
  }

  function countSeq(nodes, where) {
    return nodes.reduce((n, node) => n * countNode(node, where), 1)
  }

  function countNode(node, where) {
    if (node.t === 'text' || node.t === 'kept') return 1
    if (node.t === 'ref') return resolveRef(node.name, where).reduce((n, key) => n + countLeaf(key), 0)
    const counts = choices(node, where).map((c) => (c.key ? countGuarded(c) : countSeq(c.nodes, where)))
    if (!node.multi) return counts.reduce((a, b) => a + b, 0)
    const [lo, hi] = bounds(node, counts.length)
    const total = counts.reduce((a, b) => a + b, 0)
    if (node.repeat) {
      let n = 0
      for (let k = lo; k <= hi; k++) n += total ** k
      return n
    }

    // Ordered picks of k different choices: k! · e_k(counts), e_k = elementary symmetric polynomial.
    const e = [1]
    for (const c of counts) for (let k = Math.min(hi, e.length); k >= 1; k--) e[k] = (e[k] ?? 0) + e[k - 1] * c
    let n = 0
    for (let k = lo, fact = factorial(lo); k <= hi; fact *= ++k) n += fact * (e[k] ?? 0)
    return n
  }

  /** A pooled choice comes from a leaf, so it takes part in the cycle check. */
  function countGuarded(choice) {
    if (counting.has(choice.key)) throw new ExpandError(`reference cycle: ${[...counting, choice.key].join(' → ')}`)
    counting.add(choice.key)
    const n = countSeq(choice.nodes, choice.key)
    counting.delete(choice.key)
    return n
  }

  // Generation: the cartesian product, first element varying slowest, as in dynamicprompts.
  function* genLeaf(key, stack) {
    if (stack.includes(key)) throw new ExpandError(`reference cycle: ${[...stack, key].join(' → ')}`)
    for (const text of leaves.get(key)) yield* genSeq(entryNodes(text, key), [...stack, key])
  }

  function* genSeq(nodes, stack, at = 0) {
    if (at === nodes.length) {
      yield ''
      return
    }

    for (const head of genNode(nodes[at], stack)) for (const tail of genSeq(nodes, stack, at + 1)) yield head + tail
  }

  function* genNode(node, stack) {
    const where = stack.at(-1) ?? 'path'
    if (node.t === 'text') {
      yield node.v
    } else if (node.t === 'kept') {
      yield `\0${node.i}\0`
    } else if (node.t === 'ref') {
      for (const key of resolveRef(node.name, where)) yield* genLeaf(key, stack)
    } else if (node.multi) {
      const list = choices(node, where)
      const expand = (c) => () => {
        if (c.key && stack.includes(c.key)) throw new ExpandError(`reference cycle: ${[...stack, c.key].join(' → ')}`)
        return genSeq(c.nodes, c.key ? [...stack, c.key] : stack)
      }

      const [lo, hi] = bounds(node, list.length)
      for (let k = lo; k <= hi; k++) {
        for (const pick of picks(list.length, k, node.repeat)) {
          for (const parts of product(pick.map((j) => expand(list[j])))) {
            // dynamicprompts drops a pick whose values come out the same ("a,a")
            if (!node.repeat && new Set(parts).size < parts.length) continue
            yield parts.join(node.sep)
          }
        }
      }
    } else {
      for (const option of node.options) yield* genSeq(option, stack)
    }
  }

  return {countLeaf, genLeaf, kept, match, resolveRef, suggest}
}

function factorial(n) {
  let f = 1
  for (let k = 2; k <= n; k++) f *= k
  return f
}

/** Index lists of length k, in order: without repeats (permutations), or with them (n^k tuples). */
function* picks(n, k, repeat, prefix = []) {
  if (prefix.length === k) {
    yield prefix
    return
  }

  for (let j = 0; j < n; j++) if (repeat || !prefix.includes(j)) yield* picks(n, k, repeat, [...prefix, j])
}

function* product(factories, at = 0) {
  if (at === factories.length) {
    yield []
    return
  }

  for (const head of factories[at]()) for (const rest of product(factories, at + 1)) yield [head, ...rest]
}

// ── Whole-path expansion ──────────────────────────────────────────────────────────────────────────────────

/** `__a/b__` → `a/b`. */
export function normalizeWildcardPath(text) {
  return text.trim().replace(/^__/, '').replace(/__$/, '')
}

/**
 * Every prompt a wildcard path produces, one string per prompt: newlines become spaces and duplicates are
 * dropped. The path is tried exactly, then as **\/path, then both again ignoring upper/lower case.
 * With `keepWords`, entries of at least that many words are used as written (see createExpander); `kept`
 * counts them. Throws ExpandError when nothing matches or when there are more than `max` combinations.
 * `source` (the file name) only goes into the error message.
 */
export function expandWildcard(leaves, pattern, {keepWords, max = Infinity, source, warn = () => {}} = {}) {
  const expander = createExpander(leaves, warn, {keepWords})

  let keys = expander.match(pattern)
  let note = ''
  if (keys.length === 0 && !pattern.startsWith('**')) {
    keys = expander.match(`**/${pattern}`)
    if (keys.length > 0) note = `no exact match; used __**/${pattern}__`
  }

  if (keys.length === 0) {
    keys = expander.match(pattern, true)
    if (keys.length === 0 && !pattern.startsWith('**')) keys = expander.match(`**/${pattern}`, true)
    if (keys.length > 0) note = 'no exact match; matched ignoring upper/lower case'
  }

  if (keys.length === 0) {
    const where = source ? ` in ${source}` : ''
    throw new ExpandError(`__${pattern}__ matches no wildcard${where}${expander.suggest(pattern)}`)
  }

  const total = keys.reduce((n, key) => n + expander.countLeaf(key), 0)
  if (total === 0) throw new ExpandError(`__${pattern}__ matches only empty wildcards`)
  if (total > max) {
    throw new ExpandError(
      `__${pattern}__ expands to ${total.toLocaleString('en-US')} prompts (before removing duplicates), ` +
        `more than --max=${max}. Narrow the path, or raise --max.`,
    )
  }

  const prompts = new Set()
  for (const key of keys) {
    for (const prompt of expander.genLeaf(key, [])) {
      const tidy = prompt.replaceAll(/\s*[\r\n]+\s*/g, ' ').replaceAll(/[ \t]{2,}/g, ' ')
      // kept entries go back in exactly as written; only line breaks become spaces (one prompt per line)
      prompts.add(tidy.replaceAll(/\0(\d+)\0/g, (_, i) => expander.kept[i].replaceAll(/\s*[\r\n]+\s*/g, ' ')).trim())
    }
  }

  prompts.delete('')

  return {kept: expander.kept.length, keys, note, prompts: [...prompts], total}
}

/**
 * `tshirt-gamenight/wh40k/front-krea/*\/matyi` → `tshirt-gamenight_wh40k_front-krea_all_matyi`,
 * `lib/{a|b}/*` → `lib_a+b_all`
 */
export function fileNameFor(pattern) {
  return pattern
    .replaceAll(/\*\*?/g, 'all')
    .replaceAll(/[{}]/g, '')
    .replaceAll('|', '+')
    .replaceAll(/[\\/]+/g, '_')
    .replaceAll(/[<>:"|?\s]+/g, '-')
}

// ── Sorting keys by name ──────────────────────────────────────────────────────────────────────────────────

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'})
const keyName = (pair) => (YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key))

/** Case-insensitive, numbers by value (v2 before v10); ties by the exact text, so the order is stable. */
function byName(a, b) {
  const [x, y] = [keyName(a), keyName(b)]
  return collator.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0)
}

/**
 * `own/` (or `own`) → {prefix: 'own', deep: false}; `own/*` or `own/**` → {prefix: 'own', deep: true}.
 * `*` alone is the whole file. Only a `/` outside { } splits segments.
 */
function splitSortPath(pattern) {
  if (pattern.endsWith('/')) return {deep: false, prefix: pattern.slice(0, -1)}
  let depth = 0
  let cut = -1
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}') depth--
    else if (pattern[i] === '/' && depth === 0) cut = i
  }

  const last = pattern.slice(cut + 1)
  if (last === '*' || last === '**') return {deep: true, prefix: cut < 0 ? '' : pattern.slice(0, cut)}
  return {deep: false, prefix: pattern}
}

/** Sorts one map's keys; the comment above its first key and blank lines travel with their keys. */
function sortMap(map, deep, where, changed, seen) {
  if (seen.has(map)) return
  seen.add(map)

  const before = map.items.map(keyName)
  const sorted = [...map.items].sort(byName)
  if (sorted.some((pair, i) => pair !== map.items[i])) {
    const first = map.items[0]
    // yaml stores the comment above a map's first key on the map itself
    if (map.commentBefore && YAML.isNode(first.key)) {
      first.key.commentBefore = [map.commentBefore, first.key.commentBefore].filter(Boolean).join('\n')
      map.commentBefore = undefined
    }

    if (YAML.isNode(sorted[0].key)) sorted[0].key.spaceBefore = false
    map.items = sorted
    changed.push({after: sorted.map(keyName), before, path: where})
  }

  if (!deep) return
  for (const pair of map.items) {
    if (YAML.isMap(pair.value))
      sortMap(pair.value, deep, where ? `${where}/${keyName(pair)}` : keyName(pair), changed, seen)
  }
}

/**
 * Sorts the keys of the maps a path picks, by name. `own/` sorts own's keys; `own/*` sorts own's keys and
 * every map below, level by level; the part before the last segment may use * ** and {a|b} as in expand.
 * Lists keep their order. The path is tried exactly, then as **\/path, then both ignoring upper/lower case.
 * Returns the new text, the maps that changed (`path` '' = top level), and `reformatted` when printing
 * alone already changes the file (yaml re-indents to 2 spaces, puts folded `>-` text on one line and moves
 * `key: # comment` to its own line; the values stay the same).
 */
export function sortWildcardKeys(text, pattern, {source} = {}) {
  const doc = YAML.parseDocument(text)
  if (doc.errors.length > 0) throw new ExpandError(`${source ?? 'input'}: ${doc.errors[0].message}`)
  const file = {doc, eol: text.includes('\r\n') ? '\r\n' : '\n'}
  const reformatted = printWildcardFile(file) !== text

  const nodes = new Map() // key path → map or list ('' = the top level)
  const walk = (node, keyPath) => {
    if (YAML.isSeq(node)) nodes.set(keyPath, node)
    if (!YAML.isMap(node)) return
    nodes.set(keyPath, node)
    for (const pair of node.items) walk(pair.value, keyPath ? `${keyPath}/${keyName(pair)}` : keyName(pair))
  }

  walk(doc.contents, '')

  const {deep, prefix} = splitSortPath(pattern)
  const match = (glob, ignoreCase) => {
    const re = globToRegExp(glob, ignoreCase)
    return [...nodes.keys()].filter((key) => key && re.test(key))
  }

  let keys = prefix ? match(prefix) : nodes.has('') ? [''] : []
  let note = ''
  if (keys.length === 0 && prefix && !prefix.startsWith('**')) {
    keys = match(`**/${prefix}`)
    if (keys.length > 0) note = `no exact match; used __**/${prefix}__`
  }

  if (keys.length === 0 && prefix) {
    keys = match(prefix, true)
    if (keys.length === 0 && !prefix.startsWith('**')) keys = match(`**/${prefix}`, true)
    if (keys.length > 0) note = 'no exact match; matched ignoring upper/lower case'
  }

  const where = source ? ` in ${source}` : ''
  if (keys.length === 0) throw new ExpandError(`__${pattern}__ matches no key${where}`)
  const maps = keys.filter((key) => YAML.isMap(nodes.get(key)))
  if (maps.length === 0) {
    const what = keys.length === 1 ? `${keys[0]} is a list` : `__${pattern}__ matches only lists`
    throw new ExpandError(`${what}${where}: list entries keep their order, only keys are sorted`)
  }

  const changed = []
  const seen = new Set()
  for (const key of maps) sortMap(nodes.get(key), deep, key, changed, seen)

  return {changed, keys: maps, note, reformatted, text: changed.length > 0 ? printWildcardFile(file) : text}
}
