// Output: plain text for people, JSON (`Finding[]`) for tools.

/** Strip internal fields so the JSON is exactly `Finding[]`. */
export function toFindings(issues) {
  return issues.map((i) => {
    const f = {file: i.file, line: i.line, keyPath: i.keyPath, rule: i.rule, severity: i.severity, message: i.message}
    if (i.col !== undefined) f.col = i.col
    if (i.fix) f.fix = i.fix
    return f
  })
}

export function formatJson(result) {
  return JSON.stringify(toFindings(result.findings), null, 2)
}

/**
 * One line per finding (`file:line:col  severity  rule  message`), then a summary by rule, one line
 * per ignore entry saying how much it hid, the rules that are off, and the exempt keys with how many entries
 * they skipped.
 */
export function formatText(result) {
  const lines = []
  for (const f of result.findings) {
    const pos = `${f.file}:${f.line}${f.col !== undefined ? `:${f.col}` : ''}`
    const fixable = f.fix ? '  [fixable]' : ''
    lines.push(`${pos}  ${f.severity.padEnd(5)}  ${f.rule.padEnd(8)}  ${f.message}${fixable}`)
  }

  const byRule = new Map()
  for (const f of result.findings) {
    const c = byRule.get(f.rule) ?? {error: 0, warn: 0}
    c[f.severity]++
    byRule.set(f.rule, c)
  }
  const errors = result.findings.filter((f) => f.severity === 'error').length
  const warnings = result.findings.length - errors
  const fixable = result.findings.filter((f) => f.fix).length
  lines.push('')
  lines.push(`${errors} error(s), ${warnings} warning(s), ${fixable} fixable with --fix`)
  for (const [rule, c] of [...byRule].sort()) {
    lines.push(`  ${rule.padEnd(8)} ${String(c.error + c.warn).padStart(5)}`)
  }
  for (const s of result.suppressed) {
    const rules = s.ignore.rules ? ` (${s.ignore.rules.join(',')})` : ' (all rules)'
    lines.push(`ignored ${s.count} finding(s) under ${s.ignore.path}${rules}`)
  }
  if (result.rulesOff?.length > 0) lines.push(`rules off: ${result.rulesOff.join(', ')}`)
  if (result.exempt?.entries > 0) {
    const entries = `${result.exempt.entries} ${result.exempt.entries === 1 ? 'entry' : 'entries'} not checked`
    lines.push(`exempt keys: ${result.exempt.keys.join(', ')} (${entries})`)
  }
  return lines.join('\n')
}
