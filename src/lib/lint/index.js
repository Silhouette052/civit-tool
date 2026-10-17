// Public API of lint: civit-tool imports only from this file.
// Rules R1–R6 and S-*, findings (`Finding`), safe auto-fixes, text/JSON output.
//
// The CLI part is src/commands/wc/lint.js.

export {RULE_SEVERITY} from './types.js'
export {DEFAULT_CONFIG, loadLintConfig, makeLintConfig, parseIgnoreArg} from './config.js'
export {lintFiles, applyIgnores} from './lint.js'
export {applyFixes, applyEdits} from './fix.js'
export {formatText, formatJson, toFindings} from './format.js'
export {inUserForm} from './rules/tags.js'
