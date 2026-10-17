// Bounded edit distance, used to suggest corrections for misspelled tags.

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition), but gives up early:
 * returns `max + 1` as soon as the distance is known to exceed `max`. That early exit is what
 * makes scanning thousands of candidate tags per unknown tag affordable.
 */
export function boundedEditDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  // Three rolling rows: two rows back (for transpositions), previous, current.
  let prev2 = new Array(b.length + 1).fill(0)
  let prev = Array.from({length: b.length + 1}, (_, j) => j)
  let cur = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1)
      cur[j] = d
      if (d < rowMin) rowMin = d
    }
    if (rowMin > max) return max + 1 // every path through this row is already too long
    // Rotate the rows; the oldest one is reused as the next `cur`.
    const oldest = prev2
    prev2 = prev
    prev = cur
    cur = oldest
  }
  return Math.min(prev[b.length], max + 1)
}
