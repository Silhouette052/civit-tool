// Resolving `__wildcard__` references against the key tree.
//
// Where the two extensions differ, the stricter rule wins:
// - Only leaf keys (keys holding a list) are wildcards.
// - Matching is case-sensitive.
// - `*` matches within one path segment and `**` across segments (dynamic-prompts docs, checked
//   2026-10-02: "The `*` does not cross directory separators; `**` crosses them").

export function globToRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (ch === '*') {
      source += '[^/]*'
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** Leaf keys matching a reference name or glob, in file order. Empty = unresolved. */
export function resolveRef(files, pattern) {
  const re = globToRegExp(pattern)
  const out = []
  for (const file of Array.isArray(files) ? files : [files]) {
    for (const key of file.keys.values()) {
      if (key.isLeaf && re.test(key.path)) out.push(key)
    }
  }
  return out
}
