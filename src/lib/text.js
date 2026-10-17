const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

/**
 * Strips HTML tags and decodes the handful of entities Civitai's
 * rich-text descriptions actually use, so downstream regex matching
 * sees plain text instead of markup.
 *
 * This matters because a label and its value are often separated by
 * inline formatting -- e.g. "<strong>Strength:</strong> 0.9" -- which
 * breaks any regex that assumes only whitespace sits between them.
 * Block-level tags (</p>, </li>, <br>, etc.) are turned into newlines
 * first so unrelated list items don't get glued into one line.
 */
export function stripHtml(html) {
  if (!html) return ''

  return String(html)
    .replaceAll(/<\/(p|li|div|tr|h[1-6])>/gi, '\n')
    .replaceAll(/<br\s*\/?>/gi, '\n')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const codePoint = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
      }

      return NAMED_ENTITIES[entity.toLowerCase()] ?? match
    })
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}
