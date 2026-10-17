// Lint a set of wildcard files (one library: references resolve across all of them).

import {extractEntryTags, globToRegExp} from '../wildcard-parser/index.js'
import {makeEntryContext} from './context.js'
import {checkTags} from './rules/tags.js'
import {checkEscaping} from './rules/escaping.js'
import {
  checkExpand,
  checkRefs,
  checkRanges,
  checkDuplicateTags,
  checkBudget,
  makeRefBudgets,
} from './rules/structure.js'
import {checkLoraBase, loadSidecars} from './rules/lora.js'
import {checkNegations, checkProseTags} from './rules/prose.js'

import {RULE_SEVERITY} from './types.js'

const PROBLEM_RULE = {
  yaml: 'S-yaml',
  brace: 'S-brace',
  expand: 'S-expand',
  anima: 'S-anima',
}

export function lintFiles(files, index, config) {
  const all = []
  const sidecars = loadSidecars(config.loraDirs)
  const refBudgets = makeRefBudgets(files, config.maxVariations)

  for (const file of files) {
    // Problems found while parsing
    for (const p of file.problems) {
      all.push({
        file: file.path,
        line: p.line,
        col: p.col,
        keyPath: p.keyPath,
        rule: PROBLEM_RULE[p.kind],
        severity: p.severity,
        message: p.message,
      })
    }

    // Per entry
    file.entries.forEach((entry, entryIndex) => {
      const extracted = extractEntryTags(entry, {maxVariations: config.maxVariations})
      const ctx = makeEntryContext(file, entryIndex, extracted, config, all)
      // Prose is natural language: no Danbooru checks, and repeating a phrase is how it adds emphasis.
      const prose = entry.style === 'prose'
      if (!prose) checkTags(ctx, index)
      checkEscaping(ctx)
      checkExpand(ctx)
      checkRefs(ctx, files)
      checkRanges(ctx)
      if (!prose) checkDuplicateTags(ctx)
      checkBudget(ctx, refBudgets)
      checkLoraBase(ctx, sidecars)
      if (prose) {
        checkProseTags(ctx)
        checkNegations(ctx)
      }
    })

    // Per leaf
    for (const key of file.keys.values()) {
      if (!key.isLeaf) continue
      checkDuplicateEntries(file, key, all)
      checkBranch(file, key, config, all)
    }
  }

  return applyIgnores(sortFindings(all), config.ignore)
}

/** S-dup (leaf level): the same entry twice in one list. */
function checkDuplicateEntries(file, key, out) {
  const seen = new Set()
  for (const entry of key.entries) {
    const normalised = entry.value.trim().replace(/\s+/g, ' ')
    if (seen.has(normalised)) {
      out.push(
        issue(
          file,
          key,
          entry.line,
          entry.col,
          'S-dup',
          `entry "${normalised}" is repeated in this list (deliberate weighting? add an ignore)`,
        ),
      )
    }
    seen.add(normalised)
  }
}

/**
 * S-branch: a leaf with real content (tags, LoRAs, sentences) but no branch key (ill:, anima:, …) above it.
 * Leaves holding only `__refs__` are fine: they inherit the branch of what they reference.
 */
function checkBranch(file, key, config, out) {
  if (key.branch !== null) return
  const hasContent = key.entries.some((e) =>
    extractEntryTags(e, {maxVariations: config.maxVariations}).tags.some((t) => t.kind === 'tag' || t.kind === 'lora'),
  )
  if (hasContent) {
    out.push(
      issue(
        file,
        key,
        key.line,
        undefined,
        'S-branch',
        `tags here have no ${Object.keys(config.branches).join(':/')}: ancestor, so the base model is unknown; checked as tags only`,
      ),
    )
  }
}

function issue(file, key, line, col, rule, message) {
  const out = {file: file.path, line, keyPath: key.path, rule, severity: RULE_SEVERITY[rule], message}
  if (col !== undefined) out.col = col
  return out
}

function sortFindings(findings) {
  return findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || (a.col ?? 0) - (b.col ?? 0) || a.rule.localeCompare(b.rule),
  )
}

/** Drop findings matched by an ignore entry, counting them per entry. */
export function applyIgnores(findings, ignore) {
  const matchers = ignore.map((entry) => ({entry, re: globToRegExp(entry.path), count: 0}))
  const kept = findings.filter((f) => {
    const m = matchers.find((m) => m.re.test(f.keyPath) && (!m.entry.rules || m.entry.rules.includes(f.rule)))
    if (m) m.count++
    return !m
  })
  return {findings: kept, suppressed: matchers.map((m) => ({ignore: m.entry, count: m.count}))}
}
