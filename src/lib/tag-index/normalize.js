// Tag text normalisation (constraint C5).
//
// Wildcard files write tags in several equivalent ways:
//   `arrow_\(projectile\)`, `arrow (projectile)`, `Arrow_(Projectile)`
// For matching, all of them become the CSV form `arrow_(projectile)`:
// unescape `\(` `\)` `\@`, lowercase, and turn whitespace runs into `_`.
// For output, `escapeTag` adds the escapes that A1111/Forge and prompt-postprocessor need.

/** Normalised (matching) form: lowercase, underscores, no escapes. */
export function normalizeTag(input) {
  return input
    .trim()
    .replace(/\\([()@])/g, '$1') // `\(` → `(`, `\)` → `)`, `\@` → `@`
    .toLowerCase()
    .replace(/\s+/g, '_')
}

/**
 * Escaped (output) form of a normalised tag. Bare `(` `)` would be read as emphasis by A1111/Forge,
 * and a bare `@` breaks prompt-postprocessor.
 */
export function escapeTag(tag) {
  return tag.replace(/[()@]/g, '\\$&')
}
