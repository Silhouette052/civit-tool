// What every rule gets: the file, the entry and its extracted tags, the config, and `report()`.

import {entryPosition} from '../wildcard-parser/index.js'

import {RULE_SEVERITY} from './types.js'

export function makeEntryContext(file, entryIndex, extracted, config, out) {
  const entry = file.entries[entryIndex]
  return {
    file,
    entry,
    entryIndex,
    extracted,
    config,
    report(rule, offset, message, fix) {
      const {line, col} = entryPosition(file, entry, offset)
      const issue = {
        file: file.path,
        line,
        col,
        keyPath: entry.keyPath,
        rule,
        severity: RULE_SEVERITY[rule],
        message,
        entryIndex,
      }
      if (fix) {
        issue.fix = {replace: fix.replace, with: fix.with}
        issue.edits = fix.edits
      }
      out.push(issue)
    },
  }
}
