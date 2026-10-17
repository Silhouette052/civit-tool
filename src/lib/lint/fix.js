// `--fix`: apply the safe, deterministic fixes (R3 alias → canonical, R5/R6 escaping) and print.
//
// Only findings that carry `edits` are applied. Everything else (unknown tags, glued tags, ambiguous
// aliases) needs a human. Applying twice changes nothing, because the fixed text no longer triggers
// the rules.

import {printWildcardFile, setEntryValue} from '../wildcard-parser/index.js'

export function applyFixes(file, findings) {
  const byEntry = new Map()
  let applied = 0
  for (const f of findings) {
    if (f.file !== file.path || f.entryIndex === undefined || !f.edits) continue
    byEntry.set(f.entryIndex, [...(byEntry.get(f.entryIndex) ?? []), ...f.edits])
    applied++
  }
  if (applied === 0) return {output: null, applied: 0}

  for (const [entryIndex, edits] of byEntry) {
    const entry = file.entries[entryIndex]
    setEntryValue(entry, applyEdits(entry.value, edits))
  }
  return {output: printWildcardFile(file), applied}
}

/**
 * Apply edits to a string. A replacement (R3) that covers an insertion (R5/R6 backslash) wins: the
 * canonical tag it writes is already escaped. Identical edits are applied once.
 */
export function applyEdits(value, edits) {
  const replacements = edits.filter((e) => e.end > e.start)
  const kept = edits.filter(
    (e, i) =>
      edits.findIndex((o) => o.start === e.start && o.end === e.end && o.text === e.text) === i &&
      !(e.end === e.start && replacements.some((r) => r.start <= e.start && e.start < r.end)),
  )
  kept.sort((a, b) => b.start - a.start || b.end - a.end) // right to left keeps offsets valid
  let out = value
  for (const e of kept) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
