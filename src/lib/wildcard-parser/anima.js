// Anima entries: a natural-language sentence, then a tag line.
//
//   "A knight stands in the rain. armor, rain, sword"
//                               ^ the first `.` `!` or `?` followed by whitespace, `,` or the end
//
// Only top-level text counts, so a terminator inside `{…}`, a `__ref__` or a `<lora:…>` never
// splits, and `1.2` doesn't either (no space after the dot).

/** Value offset just after the sentence terminator, or null if the entry has none. */
export function findAnimaTagLineStart(value, template) {
  for (const node of template) {
    if (node.type !== 'text') continue
    for (let k = 0; k < node.raw.length; k++) {
      const ch = node.raw[k]
      if (ch === '\\') {
        k++
        continue
      }
      if (ch !== '.' && ch !== '!' && ch !== '?') continue
      const pos = node.start + k
      const next = value[pos + 1]
      if (next === undefined || next === ',' || /\s/.test(next)) return pos + 1
    }
  }
  return null
}
