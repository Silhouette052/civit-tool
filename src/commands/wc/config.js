import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {applySettings, defaultDataDir, loadHomeConfig, loadLocalConfig} from '../../lib/config.js'
import {
  acceptedSet,
  DEFAULT_CONFIG,
  isAccepted,
  mergeAccepted,
  plainTags,
  RULE_DESCRIPTION,
  RULE_SEVERITY,
} from '../../lib/lint/index.js'
import {findSidecarActivations} from '../../lib/loraSidecar.js'
import {
  changesAsked,
  changesFromFlags,
  checkFolder,
  folderSetting,
  foldersSetting,
  formatSettings,
  listSetting,
  LOCAL,
  numberSetting,
  overrideNotes,
  runConfig,
  settingAt,
  settingFlags,
  settingsMenu,
} from '../../lib/settings.js'
import {loadTagIndex, normalizeTag} from '../../lib/tag-index/index.js'

const RULES = Object.keys(RULE_SEVERITY)

/** The wildcard settings, in the order the menu and the listing show them (the rule switches follow). */
export const WC_SETTINGS = [
  folderSetting({
    check(dir) {
      if (!fs.existsSync(path.join(dir, 'danbooru.csv'))) {
        throw new Error(`No danbooru.csv in ${dir}; lint needs the folder that holds it.`)
      }
    },
    default: defaultDataDir,
    defaultText: "civit-tool's data folder",
    flag: 'data-dir',
    help: 'The folder with the danbooru.csv (and optional aliases.local.csv) that wc lint checks tags against',
    key: 'lint.dataDir',
    label: 'Data folder',
    note: (value, cwd) =>
      fs.existsSync(path.join(path.resolve(cwd, value), 'danbooru.csv'))
        ? 'danbooru.csv found'
        : chalk.red('no danbooru.csv'),
  }),
  folderSetting({
    defaultText: 'not set',
    flag: 'wildcards-dir',
    help: 'wc lint and wc repeats check this folder when given no path; wc expand and wc sort find bare file names in it',
    key: 'wildcardsDir',
    label: 'Wildcards folder',
  }),
  foldersSetting({
    defaultText: 'not set',
    flag: 'lora-dirs',
    help: "Folders with lora activation's sidecars, for the S-base check (a LoRA under the wrong base model)",
    key: 'lint.loraDirs',
    label: 'LoRA folders',
    note: (value) => (value.length === 0 ? chalk.yellow('S-base checks nothing without them') : ''),
  }),
  numberSetting({
    default: DEFAULT_CONFIG.minCount,
    flag: 'min-count',
    help: 'R2 reports tags used on fewer Danbooru posts than this',
    key: 'lint.minCount',
    label: 'Minimum posts',
  }),
  numberSetting({
    default: DEFAULT_CONFIG.maxTagsPerEntry,
    flag: 'max-tags',
    help: 'S-budget warns about an entry that can grow past this many tags',
    key: 'lint.maxTagsPerEntry',
    label: 'Max tags per entry',
    min: 1,
  }),
  numberSetting({
    default: DEFAULT_CONFIG.maxWordsPerEntry,
    flag: 'max-words',
    help: 'S-budget warns about a prose (Krea) entry that can grow past this many words',
    key: 'lint.maxWordsPerEntry',
    label: 'Max words per entry',
    min: 1,
  }),
  listSetting({
    check(name) {
      if (name.includes('/')) throw new Error(`"${name}" is a path; use the key's name, e.g. contender2_favs.`)
    },
    flag: 'exempt-keys',
    help: 'wc lint skips the entries under keys with these names, at any level; * matches any characters',
    key: 'lint.exemptKeys',
    label: 'Exempt keys',
  }),
]

/** Rule names from repeatable, comma-separated flag values, in their own spelling (s-branch → S-branch). */
export function parseRuleList(values = []) {
  const rules = values
    .flatMap((value) => value.split(','))
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const rule = RULES.find((r) => r.toLowerCase() === name.toLowerCase())
      if (!rule) throw new Error(`Unknown rule "${name}". The rules are: ${RULES.join(', ')}`)
      return rule
    })
  return [...new Set(rules)]
}

/** The rule switch changes --on, --off and --reset rules ask for. */
function ruleChanges(flags, home) {
  const resets = new Set(flags.reset ?? [])
  const on = parseRuleList(flags.on)
  const off = parseRuleList(flags.off)
  const both = on.filter((rule) => off.includes(rule))
  if (both.length > 0) throw new Error(`${both.join(', ')}: turned both --on and --off.`)
  if (on.length + off.length === 0) return resets.has('rules') ? {'lint.rules': undefined} : {}
  if (resets.has('rules')) throw new Error("--on/--off and --reset rules can't be used together.")

  // only `false` is written: a rule turned on again goes back to the default, which is on
  const rules = {...home.lint?.rules}
  for (const rule of on) delete rules[rule]
  for (const rule of off) rules[rule] = false
  return {'lint.rules': Object.keys(rules).length > 0 ? rules : undefined}
}

const ACCEPTED = 'lint.acceptedTags'

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const yes = (answer) => /^y(es)?$/i.test(answer.trim())

/** Tags from repeatable, comma-separated flag values. */
const tagList = (values = []) =>
  values
    .flatMap((value) => value.split(','))
    .map((tag) => tag.trim())
    .filter(Boolean)

/** Tags to accept, as lint reads them ((tag:1.2) is tag); refuses wildcard syntax, which is never a tag. */
function tagsToAccept(values) {
  const tags = []
  for (const piece of tagList(values)) {
    const {dropped, tags: found} = plainTags(piece)
    if (dropped.length > 0) {
      throw new Error(`Not a tag: ${piece}. Wildcard syntax ({…}, __…__, <lora:…>, \${…}) can't be accepted.`)
    }

    tags.push(...found)
  }

  return tags
}

/**
 * The activation tags of the LoRA sidecars in `dir` (and its subfolders with `recursive`) that lint would report:
 * wildcard syntax in the activation text is left out whole (plainTags), tags danbooru.csv knows as valid are left
 * out, and so are the `current` accepted ones. The danbooru.csv folder and minimum post count are the ones wc lint
 * uses with this home and local config. Returns {tags, report}, the report being one line saying what was found.
 */
export function gatherLoraTags(dir, {current = [], cwd = process.cwd(), home = {}, local = {}, recursive = false}) {
  const where = `${dir}${recursive ? ' and its subfolders' : ''}`
  const found = findSidecarActivations(dir, {recursive})
  if (found.sidecars === 0) {
    const hint = recursive ? '' : ' (subfolders not searched)'
    return {report: `No LoRA sidecars (.json with activation text) in ${where}${hint}.`, tags: []}
  }

  const value = (key) => settingAt(local, key) ?? settingAt(home, key)
  const dataDir = path.resolve(cwd, value('lint.dataDir') ?? defaultDataDir())
  const index = fs.existsSync(path.join(dataDir, 'danbooru.csv'))
    ? loadTagIndex({dataDir, minCount: value('lint.minCount') ?? DEFAULT_CONFIG.minCount})
    : null

  const accepted = acceptedSet(current)
  const read = found.texts.map(({text}) => plainTags(text))
  const constructs = read.reduce((count, {dropped}) => count + dropped.length, 0)
  const all = read.flatMap(({tags}) => tags)
  const unique = new Map(all.map((tag) => [normalizeTag(tag), tag]).reverse()) // the first spelling wins
  const tags = []
  let known = 0
  let danbooru = 0
  for (const tag of unique.values()) {
    if (isAccepted(accepted, tag)) known++
    else if (index?.lookupOne(tag).status === 'valid') danbooru++
    else tags.push(tag)
  }

  const skipped = [
    known > 0 && `${known} already accepted`,
    danbooru > 0 && `${plural(danbooru, 'tag')} danbooru.csv knows`,
    constructs > 0 && `${plural(constructs, 'piece')} of wildcard syntax`,
  ].filter(Boolean)
  const noCsv = index ? '' : ` No danbooru.csv in ${dataDir}, so Danbooru tags weren't left out.`
  // the counts come before the folder, so the menu keeps them when it cuts a long line
  const left = skipped.length > 0 ? ` (left out ${skipped.join(', ')})` : ''
  const counts = `${plural(tags.length, 'new tag')} from ${plural(found.sidecars, 'sidecar')}${left}`
  return {report: `Gathered ${counts} in ${where}.${noCsv}`, tags}
}

/**
 * The accepted tag changes --accept, --unaccept, --accept-loras (with --recursive) and --reset accepted-tags ask
 * for, from the home config's list. The gather uses the data folder and minimum posts of `next`, the home config
 * with the other changes made, and pushes its report line to `report`.
 */
function acceptedChanges(flags, home, cwd, report, next = home) {
  const add = tagsToAccept(flags.accept)
  const remove = tagList(flags.unaccept)
  const gather = flags['accept-loras']
  const asked = add.length + remove.length > 0 || gather !== undefined
  if ((flags.reset ?? []).includes('accepted-tags')) {
    if (asked) {
      throw new Error("--accept, --unaccept or --accept-loras and --reset accepted-tags can't be used together.")
    }

    return {[ACCEPTED]: undefined}
  }

  if (!asked) return {}
  const removed = acceptedSet(remove)
  const both = add.filter((tag) => removed.has(normalizeTag(tag)))
  if (both.length > 0) throw new Error(`${both.join(', ')}: given to both --accept and --unaccept.`)

  const current = mergeAccepted(settingAt(home, ACCEPTED) ?? [], add)
  let gathered = []
  if (gather !== undefined) {
    const local = loadLocalConfig(cwd)
    const options = {current, cwd, home: next, local, recursive: flags.recursive}
    const result = gatherLoraTags(checkFolder(gather, cwd), options)
    gathered = result.tags
    report.push(result.report)
  }

  const tags = mergeAccepted(current, gathered, remove)
  return {[ACCEPTED]: tags.length > 0 ? tags : undefined}
}

/**
 * The home config changes the flags ask for, as {dottedKey: value} for saveHomeSettings (undefined removes a
 * setting). Throws, before anything is saved, on a refused value (a missing folder, a data folder without
 * danbooru.csv, a number out of range), an unknown rule, a rule turned both on and off, a tag both accepted and
 * unaccepted or not accepted at all, or a setting both set and reset. What a gather found goes to `report`.
 */
export function settingChanges(flags, home = {}, cwd = process.cwd(), report = []) {
  const changes = {...changesFromFlags(WC_SETTINGS, flags, cwd), ...ruleChanges(flags, home)}
  // a gather in the same run uses a new --data-dir or --min-count already
  return {...changes, ...acceptedChanges(flags, home, cwd, report, applySettings(home, changes))}
}

/** Notes for the changes that ./civit-tool.config.json overrides. */
function notes(changes, local, cwd = process.cwd()) {
  const all = overrideNotes(WC_SETTINGS, changes, local, cwd)
  if ('lint.rules' in changes) {
    const set = Object.keys(local.lint?.rules ?? {}).filter((rule) => RULES.includes(rule))
    if (set.length > 0) all.push(`Note: ${LOCAL} turns ${set.join(', ')} on or off, which is used instead.`)
  }

  if (ACCEPTED in changes && settingAt(local, ACCEPTED) != null) {
    all.push(`Note: ${LOCAL} sets accepted tags, which are used instead.`)
  }

  return all
}

const LABEL_WIDTH = Math.max(...WC_SETTINGS.map((setting) => setting.label.length))
const PREVIEW = 5

/** The accepted tags as a row: how many, the first few, and where they come from. The local config locks it. */
function acceptedRow(home, local) {
  const localTags = settingAt(local, ACCEPTED)
  const saved = settingAt(home, ACCEPTED)
  const tags = localTags ?? saved ?? []
  const locked = localTags != null
  const more = tags.length > PREVIEW ? ', …' : ''
  const value = tags.length === 0 ? 'none' : `${tags.length}: ${tags.slice(0, PREVIEW).join(', ')}${more}`
  const where = locked ? `set in ${LOCAL}` : saved ? 'saved' : ''
  return {
    accepted: true,
    enterHelp: 'Enter add or remove',
    help: "Tags wc lint doesn't check against Danbooru, e.g. LoRA activation tags",
    locked,
    name: 'Accepted tags',
    resetHelp: 'r clear',
    selectable: true,
    tags,
    text: `${'Accepted tags'.padEnd(LABEL_WIDTH)}  ${value}${where ? chalk.gray(`  (${where})`) : ''}`,
  }
}

/** The menu row that gathers LoRA activation tags; locked with the accepted tags. */
const gatherRow = (accepted) => ({
  enterHelp: 'Enter choose a folder',
  gather: true,
  help: 'Accepts the activation tags of the LoRA sidecars in a folder, leaving out tags Danbooru knows',
  locked: accepted.locked,
  name: 'Accepted tags',
  selectable: true,
  text: 'Gather LoRA tags…',
})

/** Enter on the accepted tags row: tags to add, and -tag to remove. */
function askTags({cwd, home, save}) {
  return {
    ask: {
      prompt: 'Tags to accept, separated by commas; -tag removes one (Enter on its own keeps them): ',
      submit(text) {
        const tags = tagList([text])
        if (tags.length === 0) return {message: 'Accepted tags kept.'}
        const remove = tags.filter((tag) => tag.startsWith('-')).map((tag) => tag.slice(1).trim())
        const add = tags.filter((tag) => !tag.startsWith('-'))
        const changes = settingChanges({accept: add, unaccept: remove.filter(Boolean)}, loadHomeConfig(home), cwd)
        save(changes)
        const done = [add.length > 0 && `${add.length} accepted`, remove.length > 0 && `${remove.length} removed`]
        const total = changes[ACCEPTED]?.length ?? 0
        return {message: `Saved: ${done.filter(Boolean).join(', ')} (${total} in all).`}
      },
    },
  }
}

/** Enter on the gather row: the folder (checked at once), then whether to search its subfolders. */
function askGather({cwd, home, save}) {
  return {
    ask: {
      prompt: 'Folder with the LoRA sidecars (Enter on its own cancels): ',
      submit(text) {
        if (!text.trim()) return {message: 'Nothing gathered.'}
        const dir = checkFolder(text, cwd)
        return {
          ask: {
            prompt: 'Include subfolders? (y/N): ',
            submit(answer) {
              const report = []
              const flags = {'accept-loras': dir, recursive: yes(answer)}
              save(settingChanges(flags, loadHomeConfig(home), cwd, report))
              return {message: report.join(' ')}
            },
          },
        }
      },
    },
  }
}

/** r on the accepted tags row clears them all, once confirmed. */
function askClear(row, save) {
  if (row.tags.length === 0) return {message: 'There are no accepted tags to clear.'}
  return {
    ask: {
      prompt: `Clear all ${plural(row.tags.length, 'accepted tag')}? (y/N): `,
      submit(answer) {
        if (!yes(answer)) return {message: 'Accepted tags kept.'}
        save({[ACCEPTED]: undefined})
        return {message: 'Saved: accepted tags cleared.'}
      },
    },
  }
}

/** Every lint rule as a row, on or off; a rule the local config sets is locked. */
function ruleRows(home, local) {
  const width = Math.max(...RULES.map((rule) => rule.length))
  return RULES.map((rule) => {
    const locked = local.lint?.rules?.[rule] !== undefined
    const on = (local.lint?.rules?.[rule] ?? home.lint?.rules?.[rule]) !== false
    const state = on ? chalk.green('on ') : chalk.yellow('off')
    const where = locked ? chalk.gray(`  (set in ${LOCAL})`) : ''
    return {
      enterHelp: 'Enter switch on/off',
      help: "A rule that is off isn't reported, and its fixes aren't applied",
      locked,
      name: rule,
      on,
      rule,
      selectable: true,
      text: `${state}  ${rule.padEnd(width)}  ${RULE_SEVERITY[rule].padEnd(5)}  ${RULE_DESCRIPTION[rule]}${where}`,
    }
  })
}

const RULES_HEADING = 'Lint rules (all on by default)'

/** The settings as wc config prints them: one line per setting, the accepted tags, then every rule on or off. */
export function formatWcSettings(home = {}, local = {}, options = {}) {
  const rules = ruleRows(home, local).map((row) => row.text)
  const more = [acceptedRow(home, local).text, '', RULES_HEADING, ...rules]
  return formatSettings(WC_SETTINGS, home, local, {...options, more})
}

/**
 * The wc config menu: the settings, the accepted tags and a row to gather them from LoRA sidecars, then every lint
 * rule. Enter changes a setting, the accepted tags or a rule, r puts a setting back to its default (or clears the
 * accepted tags, once confirmed), and each change is saved at once. `home` and `cwd` are for the tests.
 */
export function configMenu(options = {}) {
  return settingsMenu(WC_SETTINGS, {
    ...options,
    extra: {
      enter(row, context) {
        if (row.accepted) return askTags(context)
        if (row.gather) return askGather(context)
        const {cwd, home, save} = context
        save(settingChanges({[row.on ? 'off' : 'on']: [row.rule]}, loadHomeConfig(home), cwd))
        return {message: `Saved: ${row.rule} ${row.on ? 'off' : 'on'}.`}
      },
      key(row, key, {save}) {
        if (key.name === 'r' && row.accepted) return askClear(row, save)
      },
      rows(home, local) {
        const accepted = acceptedRow(home, local)
        return [
          accepted,
          gatherRow(accepted),
          {selectable: false, text: ''},
          {selectable: false, text: RULES_HEADING},
          ...ruleRows(home, local),
        ]
      },
    },
  })
}

export default class Config extends Command {
  static description = `Show or change the wildcard settings: the danbooru.csv folder for wc lint, the default wildcards folder, the LoRA folders for the S-base check, lint's limits, the keys whose entries lint skips, the tags lint accepts without checking them against Danbooru (such as LoRA activation tags, which it can gather from the LoRA sidecars in a folder), and which lint rules are on. With no flags, in a terminal, it opens a menu: ↑/↓ to move, Enter to change a setting or switch a rule, r for a setting's default, q to leave. Otherwise, or with --list, it prints the settings. Changes are saved in ~/.civit-tool.config.json; a ./civit-tool.config.json in the current folder still overrides them.`

  static examples = [
    '<%= config.bin %> wc config',
    '<%= config.bin %> wc config --list',
    '<%= config.bin %> wc config --data-dir "D:/Forge/extensions/a1111-sd-webui-tagcomplete/tags"',
    '<%= config.bin %> wc config --wildcards-dir "D:/Forge/extensions/sd-dynamic-prompts/wildcards"',
    '<%= config.bin %> wc config --lora-dirs "D:/Forge/models/Lora/illustrious;D:/Forge/models/Lora/anima"',
    '<%= config.bin %> wc config --min-count 100 --max-tags 50',
    '<%= config.bin %> wc config --exempt-keys "contender2_favs,*_favs"',
    '<%= config.bin %> wc config --off S-branch,P-neg',
    '<%= config.bin %> wc config --on S-branch',
    '<%= config.bin %> wc config --accept-loras "D:/Forge/models/Lora" --recursive',
    '<%= config.bin %> wc config --accept cv4n14-style,EdoEraAnime --unaccept medieval',
    '<%= config.bin %> wc config --reset data-dir --reset rules',
  ]

  static flags = {
    ...settingFlags(WC_SETTINGS, {resets: ['rules', 'accepted-tags']}),
    accept: Flags.string({
      description:
        "Accept tags: wc lint doesn't check them against Danbooru, e.g. a LoRA's activation tags. Comma-separated, repeatable.",
      multiple: true,
    }),
    'accept-loras': Flags.string({
      description:
        'Accept the activation tags of the LoRA sidecars (.json) in this folder, leaving out tags danbooru.csv already knows.',
    }),
    recursive: Flags.boolean({
      dependsOn: ['accept-loras'],
      description: 'With --accept-loras: search its subfolders too.',
    }),
    unaccept: Flags.string({
      description: 'Remove accepted tags. Comma-separated, repeatable.',
      multiple: true,
    }),
    off: Flags.string({
      description: 'Turn lint rules off, e.g. S-branch,P-neg. Repeatable.',
      multiple: true,
    }),
    on: Flags.string({
      description: 'Turn lint rules back on. Repeatable.',
      multiple: true,
    }),
  }

  async run() {
    const {flags} = await this.parse(Config)
    await runConfig(this, {
      asked: flags.list || changesAsked(WC_SETTINGS, flags, ['on', 'off', 'accept', 'unaccept', 'accept-loras']),
      changes: (home) => {
        const report = []
        const changes = settingChanges(flags, home, process.cwd(), report)
        for (const line of report) this.log(line)
        return changes
      },
      listing: (home, local) => formatWcSettings(home, local),
      menu: () => configMenu(),
      notes: (changes, local) => notes(changes, local),
    })
  }
}
