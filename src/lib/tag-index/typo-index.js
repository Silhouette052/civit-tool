// Fast "which names are within edit distance k of this string?" search.
//
// Computing the edit distance against all ~78k tag and alias names takes ~35 ms per query: far too
// slow when lint sends hundreds of unknown tags. Two cheap filters remove almost every name first:
//
// 1. Length: a name within distance k has a length within ±k of the query's.
// 2. Shared bigrams: pad a name as `^name$` and take its bigrams (`^n`, `na`, …, `e$`). One edit
//    destroys at most 3 of the query's bigrams (a transposition `ab`→`ba` breaks the bigram before,
//    the pair and the one after). So a name within distance k still shares at least
//    |bigrams(query)| − 3k of the query's distinct bigrams.
//
// The bigram lists are kept per name length, so a query only counts over the lists for the
// 2k+1 lengths that can match. Only names that pass both filters get the real (bounded) distance.
// Both filters are exact: they never drop a true match, they only skip work.

import {boundedEditDistance} from './edit-distance.js'

function bigrams(name) {
  const padded = `^${name}$`
  const out = new Set()
  for (let i = 0; i < padded.length - 1; i++) out.add(padded.slice(i, i + 2))
  return out
}

export class TypoIndex {
  names
  idsByLength = new Map() // length → indexes into `names`
  idsByLengthAndBigram = new Map() // length → bigram → indexes
  shared // per-query scratch counters, reset after each query

  constructor(names) {
    this.names = names
    this.shared = new Uint16Array(names.length)
    names.forEach((name, id) => {
      push(this.idsByLength, name.length, id)
      let byBigram = this.idsByLengthAndBigram.get(name.length)
      if (!byBigram) this.idsByLengthAndBigram.set(name.length, (byBigram = new Map()))
      for (const bg of bigrams(name)) push(byBigram, bg, id)
    })
  }

  /** All names within edit distance `max` of `query`, with their distance. */
  near(query, max) {
    const queryBigrams = bigrams(query)
    const needed = queryBigrams.size - 3 * max
    const out = []
    const check = (id) => {
      const distance = boundedEditDistance(query, this.names[id], max)
      if (distance <= max) out.push({name: this.names[id], distance})
    }

    for (let len = Math.max(1, query.length - max); len <= query.length + max; len++) {
      if (needed <= 0) {
        // Query too short for the bigram filter to rule anything out: check every name of this length.
        for (const id of this.idsByLength.get(len) ?? []) check(id)
        continue
      }
      // Count shared bigrams per name, remembering which counters we touched so we can reset them.
      const byBigram = this.idsByLengthAndBigram.get(len)
      if (!byBigram) continue
      const touched = []
      for (const bg of queryBigrams) {
        for (const id of byBigram.get(bg) ?? []) {
          if (this.shared[id] === 0) touched.push(id)
          this.shared[id]++
        }
      }
      for (const id of touched) {
        if (this.shared[id] >= needed) check(id)
        this.shared[id] = 0
      }
    }
    return out
  }
}

function push(map, key, id) {
  const list = map.get(key)
  if (list) list.push(id)
  else map.set(key, [id])
}
