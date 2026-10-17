// The in-memory tag index: "is this tag valid, what is its count/category, is it an alias,
// what should I use instead?" Built once per process (~0.3 s); every lookup after that is a
// few Map reads.

import {existsSync} from 'node:fs'
import {join} from 'node:path'

import {loadAliasOverrides} from './aliases-local.js'
import {loadDanbooruCsv} from './csv.js'
import {escapeTag, normalizeTag} from './normalize.js'
import {TypoIndex} from './typo-index.js'

/** Rule R2: a tag needs at least this many posts (configurable). */
export const DEFAULT_MIN_COUNT = 80

const UNKNOWN_SUGGESTION_LIMIT = 5

/** Words of a tag, used for word search: `arrow_(projectile)` → `arrow`, `projectile`. */
function wordsOf(tag) {
  return tag.split(/[_()]+/).filter((w) => w !== '')
}

/**
 * `lookup` / `lookupOne` return a TagResult:
 *   {input, normalized, status: 'valid' | 'alias' | 'unknown' | 'low-count',
 *    tag?, category?, count?, aliasOf?, suggestions?}
 * `tag` and `aliasOf` are canonical and escaped for output. `suggestions` are the nearest valid tags
 * for an unknown tag, or the other targets of an ambiguous alias.
 */
export class TagIndex {
  /** canonical tag (CSV form) → row */
  byTag = new Map()
  /** alias → canonical tags, most-used first. Aliases that are also real tags are left out. */
  aliasTargets = new Map()
  /** aliases from aliases.local.csv: these win even over a real tag of the same name */
  localAliases = new Set()
  /** word → rows whose tag contains that word (for word search) */
  rowsByWord = new Map()
  /** every tag and alias name, for typo suggestions */
  allNames = []
  /** built on the first unknown tag, so runs where every tag is valid never pay for it */
  typoIndex

  constructor(rows, overrides = [], options = {}) {
    this.minCount = options.minCount ?? DEFAULT_MIN_COUNT

    for (const row of rows) {
      this.byTag.set(row.tag, row)
      this.allNames.push(row.tag)
      for (const word of new Set(wordsOf(row.tag))) {
        const list = this.rowsByWord.get(word)
        if (list) list.push(row)
        else this.rowsByWord.set(word, [row])
      }
    }

    // CSV aliases. A name that is itself a tag stays a tag: it has its own post count, so the
    // model has seen it (e.g. `hair_bun`, 244k posts, is also listed as an alias of `single_hair_bun`).
    for (const row of rows) {
      for (const alias of row.aliases) {
        if (this.byTag.has(alias)) continue
        const targets = this.aliasTargets.get(alias)
        if (!targets) {
          this.aliasTargets.set(alias, [row.tag])
          this.allNames.push(alias)
        } else if (!targets.includes(row.tag)) {
          targets.push(row.tag)
        }
      }
    }

    // An alias may point to several tags (`thighhigh` → `thighhighs`, `single_thighhigh`): most-used first.
    for (const targets of this.aliasTargets.values()) {
      targets.sort((a, b) => this.byTag.get(b).count - this.byTag.get(a).count)
    }

    // User overrides come last and win: the user has decided this name breaks generation.
    for (const o of overrides) {
      if (!this.byTag.has(o.tag)) {
        throw new Error(`aliases.local.csv line ${o.line}: tag "${o.tag}" is not in danbooru.csv`)
      }

      if (!this.aliasTargets.has(o.alias)) this.allNames.push(o.alias)
      this.aliasTargets.set(o.alias, [o.tag])
      this.localAliases.add(o.alias)
    }
  }

  /** Number of canonical tags. */
  get size() {
    return this.byTag.size
  }

  /** Look up many tags at once; results are in input order. Repeated inputs are computed once. */
  lookup(inputs) {
    const cache = new Map()
    return inputs.map((input) => {
      let result = cache.get(input)
      if (!result) {
        result = this.lookupOne(input)
        cache.set(input, result)
      }

      return result
    })
  }

  lookupOne(input) {
    const normalized = normalizeTag(input)
    const row = this.byTag.get(normalized)

    if (row && !this.localAliases.has(normalized)) {
      return {
        category: row.category,
        count: row.count,
        input,
        normalized,
        status: row.count >= this.minCount ? 'valid' : 'low-count',
        tag: escapeTag(row.tag),
      }
    }

    const targets = this.aliasTargets.get(normalized)
    if (targets) {
      const target = this.byTag.get(targets[0])
      const result = {
        aliasOf: escapeTag(target.tag),
        category: target.category,
        count: target.count,
        input,
        normalized,
        status: 'alias',
        tag: escapeTag(target.tag),
      }
      if (targets.length > 1) result.suggestions = targets.slice(1).map((t) => escapeTag(t))
      return result
    }

    return {input, normalized, status: 'unknown', suggestions: this.nearestTags(normalized)}
  }

  /**
   * Suggestions for an unknown tag, from two sources:
   * - typo fixes: tags or aliases within a small edit distance (closest first, then most-used);
   * - word matches: tags containing all of its words (`white` → `white_shirt`, …), most-used first.
   * If every word of the input is a real tag word (`black`, `hair_red`), the input is probably an
   * incomplete or reordered tag rather than a typo, so word matches come first.
   */
  nearestTags(normalized) {
    const words = wordsOf(normalized)
    const typos = this.typoMatches(normalized)
    const wordMatches = this.wholeWordMatches(words)
    const allWordsKnown = words.length > 0 && words.every((w) => this.rowsByWord.has(w))

    const out = []
    for (const tag of allWordsKnown ? [...wordMatches, ...typos] : [...typos, ...wordMatches]) {
      const escaped = escapeTag(tag)
      if (!out.includes(escaped)) out.push(escaped)
      if (out.length === UNKNOWN_SUGGESTION_LIMIT) break
    }

    return out
  }

  /** Canonical tags within a small edit distance of `normalized`, best first. */
  typoMatches(normalized) {
    // Short inputs get a tighter bound, or everything would be "close".
    const max = normalized.length <= 3 ? 0 : normalized.length <= 5 ? 1 : 2
    if (max === 0) return []
    this.typoIndex ??= new TypoIndex(this.allNames)

    const hits = this.typoIndex.near(normalized, max).map(({distance, name}) => {
      // An alias stands for its most-used target tag.
      const isTag = this.byTag.has(name) && !this.localAliases.has(name)
      const tag = isTag ? name : this.aliasTargets.get(name)[0]
      return {count: this.byTag.get(tag).count, distance, tag}
    })
    hits.sort((a, b) => a.distance - b.distance || b.count - a.count)
    return hits.slice(0, UNKNOWN_SUGGESTION_LIMIT).map((h) => h.tag)
  }

  /** Canonical tags containing every one of `words` as a whole word, most-used first. */
  wholeWordMatches(words) {
    if (words.length === 0) return []
    // Start from the rarest word's list and keep rows that contain all the other words too.
    const lists = words.map((w) => this.rowsByWord.get(w) ?? [])
    lists.sort((a, b) => a.length - b.length)
    const rows = lists[0].filter((row) => {
      const rowWords = wordsOf(row.tag)
      return words.every((w) => rowWords.includes(w))
    })
    rows.sort((a, b) => b.count - a.count)
    return rows.slice(0, UNKNOWN_SUGGESTION_LIMIT).map((row) => row.tag)
  }
}

/** Load `<dataDir>/danbooru.csv` (+ `aliases.local.csv` when present) and build the index. */
export function loadTagIndex({dataDir, minCount}) {
  const rows = loadDanbooruCsv(join(dataDir, 'danbooru.csv'))
  const aliasesPath = join(dataDir, 'aliases.local.csv')
  const overrides = existsSync(aliasesPath) ? loadAliasOverrides(aliasesPath) : []
  return new TagIndex(rows, overrides, {minCount})
}
