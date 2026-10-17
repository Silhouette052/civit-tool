// Mapping offsets to 1-based line/col, for reporting.

export function computeLineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  return starts
}

/** 1-based line and column of a file offset. */
export function lineColAt(lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return {line: lo + 1, col: offset - lineStarts[lo] + 1}
}

/**
 * File offset of the value's first character when value offsets map 1:1 onto the file: a plain,
 * block or quoted scalar whose value is one line, found verbatim in the source. Otherwise null
 * (multi-line scalars or quoted ones with escapes, where folding or escapes shift characters).
 */
export function findValueStart(source, node, value) {
  if (!node.range || value.includes('\n')) return null
  const [start, end] = node.range
  if (node.type === 'PLAIN') {
    return source.startsWith(value, start) ? start : null
  }
  if (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE') {
    // Exact only when the quoted text has no escapes: then the value starts right after the quote.
    return source.startsWith(value, start + 1) && source[start + 1 + value.length] === source[start] ? start + 1 : null
  }
  if (node.type === 'BLOCK_FOLDED' || node.type === 'BLOCK_LITERAL') {
    // `>-` header line, then the content line with indentation.
    const contentLine = source.indexOf('\n', start) + 1
    if (contentLine === 0) return null
    let at = contentLine
    while (source[at] === ' ') at++
    return at + value.length <= end + 1 && source.startsWith(value, at) ? at : null
  }
  return null
}

/** 1-based line/col of a value offset of an entry (exact when possible, else the scalar's start). */
export function entryPosition(file, entry, valueOffset) {
  if (entry.valueStart === null) return {line: entry.line, col: entry.col}
  return lineColAt(file.lineStarts, entry.valueStart + valueOffset)
}
