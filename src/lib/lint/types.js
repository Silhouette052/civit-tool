// Lint rules and their severity.
//
// A Finding (the --json output) is {file, line, col?, keyPath, rule, severity, message, fix?}, where
// `fix` is {replace, with} and only set for safe deterministic fixes. Internally a finding is an
// Issue: a Finding plus `entryIndex` (into WildcardFile.entries) and `edits`, the value-offset
// changes {start, end, text} that `--fix` applies.

export const RULE_SEVERITY = {
  R1: 'error', // unknown tag
  R2: 'error', // tag below the minimum post count
  R3: 'error', // alias: use the canonical tag
  R4: 'error', // bare colour word without a noun
  R5: 'error', // unescaped ( or ) outside (text:number) emphasis
  R6: 'error', // unescaped @
  'S-yaml': 'error', // YAML structure problems. YAML warnings (e.g. a non-list value) are reported as warn
  'S-brace': 'error', // unbalanced { }
  'S-ref': 'error', // unresolved __reference__ or unmatched __ marker
  'S-range': 'error', // impossible multi-select range {N-M$$…}
  'S-dup': 'warn', // repeated entry in a leaf, or a tag repeated in one entry
  'S-budget': 'warn', // an entry can expand to more tags (prose: words) than allowed
  'S-base': 'error', // LoRA base model doesn't match its branch
  'S-branch': 'warn', // content without a branch key (ill:, anima:, …) above it
  'S-expand': 'error', // too many variations to check combined
  'S-anima': 'warn', // sentence-style entry (anima:) without a sentence terminator
  'P-tags': 'warn', // prose entry (krea:) that looks like Danbooru tags
  'P-neg': 'warn', // negation in a prose entry ("no helmet")
}
