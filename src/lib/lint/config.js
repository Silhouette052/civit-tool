// Lint configuration: defaults, plus a `lint` section (all keys optional). In civit-tool it comes from
// civit-tool.config.json, or from another JSON file given with --config:
//
// {
//   "lint": {
//     "dataDir": "path/to/forge/extensions/a1111-sd-webui-tagcomplete/tags",
//     "minCount": 80,
//     "maxTagsPerEntry": 40,
//     "maxWordsPerEntry": 150,
//     "loraDirs": ["path/to/forge/models/Lora"],
//     "branches": {"ill": {"baseModels": ["Illustrious", "NoobAI", "Pony"]}, "flux": {"keys": ["flux"], "style": "prose"}},
//     "ignore": [{"path": "danboru-character-prompter/custom/**", "rules": ["S-branch"]}],
//     "rules": {"S-branch": false},
//     "acceptedTags": ["EdoEraAnime"],
//     "exemptKeys": ["contender2_favs", "*_favs"]
//   }
// }
//
// `dataDir` (civit-tool only) is the folder holding danbooru.csv and the optional aliases.local.csv.
// `rules` turns rules off (false) or on (true); every rule is on by default. `civit-tool wc config` sets it.
// `acceptedTags` are tags that aren't checked against Danbooru, e.g. LoRA activation tags (see accepted.js).
// `exemptKeys` are key names, at any level (`*` matches within the name): the entries under them aren't linted.
// `branches` is merged into DEFAULT_BRANCHES one branch at a time: a known name changes only the fields
// given, a new name adds a branch (it needs `keys` and `style`), and `null` removes one.

import {existsSync, readFileSync} from 'node:fs'
import {BRANCH_STYLES, DEFAULT_BRANCHES, DEFAULT_MAX_VARIATIONS, globToRegExp} from '../wildcard-parser/index.js'
import {DEFAULT_MIN_COUNT} from '../tag-index/index.js'

import {validateAcceptedTags} from './accepted.js'
import {RULE_SEVERITY} from './types.js'

export const DEFAULT_CONFIG = {
  minCount: DEFAULT_MIN_COUNT,
  maxVariations: DEFAULT_MAX_VARIATIONS,
  maxTagsPerEntry: 40,
  maxWordsPerEntry: 150,
  branches: DEFAULT_BRANCHES,
  loraDirs: [],
  ignore: [],
  rules: {},
  acceptedTags: [],
  exemptKeys: [],
}

/** A `lint` config section over the defaults. `where` names the source in error messages. */
export function makeLintConfig(section = {}, where = 'config') {
  if ('baseModels' in section) {
    throw new Error(`${where}: lint.baseModels is now set per branch: lint.branches.<name>.baseModels`)
  }
  const config = {...DEFAULT_CONFIG, ...section, branches: mergeBranches(section.branches ?? {}, where)}
  for (const entry of config.ignore) validateRules(entry.rules ?? [], where)
  validateRuleSwitches(config.rules, where)
  validateAcceptedTags(config.acceptedTags, where)
  validateExemptKeys(config.exemptKeys, where)
  return config
}

function validateExemptKeys(names, where) {
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || name.trim() === '')) {
    throw new Error(`${where}: lint.exemptKeys must be a list of key names, e.g. ["contender2_favs"]`)
  }

  const path = names.find((name) => name.includes('/'))
  if (path) throw new Error(`${where}: lint.exemptKeys: "${path}" is a path; use the key's name, e.g. contender2_favs`)
}

/**
 * Whether a key path is exempt: one of its keys matches a name of `exemptKeys` (`*` matches within the name), so
 * the key and everything below it are skipped.
 */
export function makeExempt(names = []) {
  const patterns = names.map((name) => globToRegExp(name.trim()))
  if (patterns.length === 0) return () => false
  return (keyPath) => keyPath.split('/').some((key) => patterns.some((re) => re.test(key)))
}

/** The rules a config turns off, in RULE_SEVERITY order. */
export const rulesOff = (config) => Object.keys(RULE_SEVERITY).filter((rule) => config.rules?.[rule] === false)

function validateRuleSwitches(rules, where) {
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    throw new Error(`${where}: lint.rules must be an object such as {"S-branch": false}`)
  }
  validateRules(Object.keys(rules), `${where}: lint.rules`)
  for (const [rule, on] of Object.entries(rules)) {
    if (typeof on !== 'boolean') throw new Error(`${where}: lint.rules.${rule} must be true or false`)
  }
}

function mergeBranches(overrides, where) {
  const branches = {...DEFAULT_BRANCHES}
  for (const [name, def] of Object.entries(overrides)) {
    if (def === null) {
      delete branches[name]
      continue
    }
    const merged = {...branches[name], ...def}
    if (!Array.isArray(merged.keys) || merged.keys.length === 0) {
      throw new Error(`${where}: lint.branches.${name} needs "keys", a list of key names`)
    }
    if (!BRANCH_STYLES.includes(merged.style)) {
      throw new Error(`${where}: lint.branches.${name}.style must be one of ${BRANCH_STYLES.join(', ')}`)
    }
    branches[name] = merged
  }
  return branches
}

/** Read the `lint` section of a config file over the defaults. A missing file means defaults. */
export function loadLintConfig(path) {
  if (!existsSync(path)) return {...DEFAULT_CONFIG}
  return makeLintConfig(JSON.parse(readFileSync(path, 'utf8')).lint, path)
}

/** Parse a CLI `--ignore` value: `<path-glob>[:RULE,RULE…]`. */
export function parseIgnoreArg(arg) {
  // The glob itself never contains `:`, so the last `:` (if any) starts the rule list.
  const colon = arg.lastIndexOf(':')
  if (colon === -1) return {path: arg}
  const rules = arg
    .slice(colon + 1)
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  validateRules(rules, '--ignore')
  return {path: arg.slice(0, colon), rules}
}

function validateRules(rules, where) {
  for (const rule of rules) {
    if (!(rule in RULE_SEVERITY)) throw new Error(`${where}: unknown rule "${rule}"`)
  }
}
