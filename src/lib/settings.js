// Settings that a config command (wc config, lora config) shows, saves in the home config and changes, from flags
// or its keyboard menu. Each setting is a descriptor, and its flag, checks, menu row and listing line all come from it:
//
//   key      where it lives in the config file, dotted for a section ('lint.dataDir')
//   flag     its flag in the config command, also a --reset value
//   label    its name in the menu and the listing; help: one line saying what it does
//   default  the value when nothing is set (a function when it depends on the environment)
//   kind     'input' (Enter asks for text) or 'choice' (Enter moves to the next of `options`)
//   parse(text, cwd)  the value to save for flag or menu text; throws why it can't be saved
//   show(value, cwd)  how the value reads; note(value, cwd) adds a remark, e.g. "danbooru.csv found"

import {Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {homeConfigPath, loadHomeConfig, loadLocalConfig, saveHomeSettings} from './config.js'
import {runMenu} from './terminalMenu.js'

export const LOCAL = './civit-tool.config.json'

/** The value at a dotted key ('lint.dataDir') of a config, or undefined. */
export const settingAt = (config, key) => key.split('.').reduce((value, name) => value?.[name], config)

const defaultOf = (setting) => (typeof setting.default === 'function' ? setting.default() : setting.default)

/** What to save: undefined (remove the setting) when the value is the default anyway. */
const toSave = (setting, value) => (isDeepStrictEqual(value, defaultOf(setting)) ? undefined : value)

const isEmpty = (value) => value == null || (Array.isArray(value) && value.length === 0)

/** A path as typed or pasted, without the quotes around it. */
export const unquote = (text) =>
  text
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim()

/** A folder resolved against `cwd`; throws when it doesn't exist. */
export function checkFolder(text, cwd) {
  const dir = path.resolve(cwd, unquote(text))
  if (!(fs.statSync(dir, {throwIfNoEntry: false})?.isDirectory() ?? false)) throw new Error(`No such folder: ${dir}`)
  return dir
}

/** One folder, saved absolute. `check(dir)` can refuse it, e.g. when a file it needs is missing. */
export const folderSetting = ({check, ...setting}) => ({
  kind: 'input',
  parse(text, cwd) {
    const dir = checkFolder(text, cwd)
    check?.(dir)
    return dir
  },
  show: (value, cwd) => (value == null ? 'not set' : path.resolve(cwd, value)),
  ...setting,
})

/** Several folders, typed separated by ; and saved as a list of absolute paths. */
export const foldersSetting = (setting) => ({
  default: [],
  kind: 'input',
  parse: (text, cwd) =>
    text
      .split(';')
      .map((dir) => unquote(dir))
      .filter(Boolean)
      .map((dir) => checkFolder(dir, cwd)),
  prompt: `${setting.label}, separated by ;`,
  show: (value, cwd) => (isEmpty(value) ? 'not set' : value.map((dir) => path.resolve(cwd, dir)).join('; ')),
  ...setting,
})

/** Several names, typed separated by commas and saved as a list without repeats; `check(name)` can refuse one. */
export const listSetting = ({check, ...setting}) => ({
  default: [],
  kind: 'input',
  parse(text) {
    const names = [
      ...new Set(
        text
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ]
    for (const name of names) check?.(name)
    return names
  },
  prompt: `${setting.label}, separated by commas`,
  show: (value) => (isEmpty(value) ? 'none' : value.join(', ')),
  ...setting,
})

/** A whole number of at least `min`. */
export const numberSetting = ({min = 0, ...setting}) => ({
  kind: 'input',
  parse(text) {
    const number = Number(text.trim())
    if (text.trim() === '' || !Number.isInteger(number) || number < min) {
      throw new Error(`${setting.label} must be a whole number of at least ${min}.`)
    }

    return number
  },
  show: (value) => String(value),
  ...setting,
})

/** One of a few values; Enter in the menu moves to the next one. */
export const choiceSetting = ({options, ...setting}) => ({
  enterHelp: 'Enter next choice',
  kind: 'choice',
  next: (value) => options[(options.indexOf(value) + 1) % options.length],
  options,
  parse(text) {
    const value = options.find((option) => option.toLowerCase() === text.trim().toLowerCase())
    if (value === undefined) throw new Error(`${setting.label} must be one of: ${options.join(', ')}.`)
    return value
  },
  show: (value) => value,
  ...setting,
})

/** On or off, saved as true or false; Enter in the menu switches it. */
export const switchSetting = (setting) => ({
  ...choiceSetting({options: ['on', 'off'], ...setting}),
  enterHelp: 'Enter switch on/off',
  next: (value) => !value,
  parse(text) {
    const value = text.trim().toLowerCase()
    if (value !== 'on' && value !== 'off') throw new Error(`${setting.label} must be on or off.`)
    return value === 'on'
  },
  show: (value) => (value ? 'on' : 'off'),
})

/** Free text, checked (and tidied) by `check`, which throws when the text can't be used. */
export const textSetting = ({check, ...setting}) => ({
  kind: 'input',
  parse: (text) => check(text),
  show: String,
  ...setting,
})

/** The flags of a config command: one per setting, --reset (with `resets` for anything else) and --list. */
export function settingFlags(settings, {resets = []} = {}) {
  const flags = {}
  for (const setting of settings) {
    const shown = setting.defaultText ?? setting.show(defaultOf(setting), process.cwd())
    flags[setting.flag] = Flags.string({
      description: `${setting.help}. Default: ${shown}.`,
      ...(setting.options ? {options: setting.options} : {}),
    })
  }

  flags.list = Flags.boolean({
    default: false,
    description: 'Print the settings instead of opening the menu. Without a terminal, they are always printed.',
  })
  flags.reset = Flags.string({
    description: 'Go back to the default for this setting. Repeatable.',
    multiple: true,
    options: [...settings.map((setting) => setting.flag), ...resets],
  })
  return flags
}

/** Whether any flag asks for a change, so the menu isn't opened. */
export const changesAsked = (settings, flags, others = []) =>
  [...settings.map((setting) => setting.flag), ...others, 'reset'].some((flag) => flags[flag] !== undefined)

/**
 * The home config changes the flags ask for, as {dottedKey: value} for saveHomeSettings (undefined removes a
 * setting). Throws, before anything is saved, when a value is refused or a setting is both set and reset.
 */
export function changesFromFlags(settings, flags, cwd = process.cwd()) {
  const resets = new Set(flags.reset ?? [])
  const changes = {}
  for (const setting of settings) {
    const given = flags[setting.flag] !== undefined
    if (given && resets.has(setting.flag)) {
      throw new Error(`--${setting.flag} and --reset ${setting.flag} can't be used together.`)
    }

    if (given) changes[setting.key] = toSave(setting, setting.parse(flags[setting.flag], cwd))
    else if (resets.has(setting.flag)) changes[setting.key] = undefined
  }

  return changes
}

/** Notes for the changed settings that ./civit-tool.config.json overrides, so an unused saved value is no surprise. */
export function overrideNotes(settings, changes, local = {}, cwd = process.cwd()) {
  return settings
    .filter((setting) => setting.key in changes && settingAt(local, setting.key) != null)
    .map((setting) => {
      const value = setting.show(settingAt(local, setting.key), cwd)
      return `Note: ${LOCAL} sets ${setting.label.toLowerCase()} to ${value}, which is used instead.`
    })
}

/**
 * The settings as rows, for the menu and the listing: label, value, and where it comes from (default, saved in the
 * home config, or set in ./civit-tool.config.json, which locks it). `width` lines the labels up with other rows.
 */
export function settingRows(settings, home, local, cwd = process.cwd(), width = 0) {
  const labelWidth = Math.max(width, ...settings.map((setting) => setting.label.length))
  return settings.map((setting) => {
    const localValue = settingAt(local, setting.key)
    const saved = settingAt(home, setting.key)
    const value = localValue ?? saved ?? defaultOf(setting)
    const locked = localValue != null
    const source = locked ? `set in ${LOCAL}` : saved == null ? (isEmpty(value) ? '' : 'default') : 'saved'
    const notes = [source, setting.note?.(value, cwd)].filter(Boolean)
    const remark = notes.length > 0 ? chalk.gray(`  (${notes.join('; ')})`) : ''
    const text = `${setting.label.padEnd(labelWidth)}  ${setting.show(value, cwd)}${remark}`
    return {help: setting.help, locked, saved, selectable: true, setting, text, value}
  })
}

/** The printed settings: one line per setting, then `more` lines (the rule switches), then where changes go. */
export function formatSettings(
  settings,
  home,
  local,
  {cwd = process.cwd(), homeFile = homeConfigPath(), more = []} = {},
) {
  const lines = settingRows(settings, home, local, cwd).map((row) => row.text)
  return [...lines, ...more, '', chalk.gray(`Changes are saved in ${homeFile}.`)].join('\n')
}

/**
 * The keyboard menu of a config command: its settings, then the rows `extra.rows(home, local)` adds. Enter changes
 * the setting under the cursor (`extra.enter(row)` handles the added rows, `extra.key(row, key)` their other keys,
 * and a row's `resetHelp` names its r), r puts it back to the default, and each change is saved at once in the home
 * config, with the same checks as the flags. `home` and `cwd` are for the tests.
 */
export function settingsMenu(settings, {cwd = process.cwd(), extra, home = os.homedir(), input, output} = {}) {
  const save = (changes) => saveHomeSettings(changes, home)
  const locked = (row) => ({error: `${row.setting?.label ?? row.name} is set in ${LOCAL}; change it there.`})

  const menu = {
    rows() {
      const homeConfig = loadHomeConfig(home)
      const local = loadLocalConfig(cwd)
      return [
        {selectable: false, text: chalk.gray(`Changes are saved in ${homeConfigPath(home)} as you make them.`)},
        {selectable: false, text: ''},
        ...settingRows(settings, homeConfig, local, cwd),
        ...(extra?.rows(homeConfig, local) ?? []),
      ]
    },

    keys(row) {
      const enter = row?.setting ? (row.setting.enterHelp ?? 'Enter change') : (row?.enterHelp ?? 'Enter change')
      const reset = row?.setting ? '   r default' : row?.resetHelp ? `   ${row.resetHelp}` : ''
      return [row?.help ?? '', `↑/↓ move   ${enter}${reset}   q quit`]
    },

    enter(row) {
      if (row.locked) return locked(row)
      if (!row.setting) return extra.enter(row, {cwd, home, save})
      const {setting} = row
      const saved = (value) => {
        save({[setting.key]: toSave(setting, value)})
        return {message: `Saved: ${setting.label.toLowerCase()} ${setting.show(value, cwd)}.`}
      }

      if (setting.kind === 'choice') return saved(setting.next(row.value))
      return {
        ask: {
          prompt: `${setting.prompt ?? `New ${setting.label.toLowerCase()}`} (Enter on its own keeps it): `,
          submit: (text) => (text.trim() ? saved(setting.parse(text, cwd)) : {message: `${setting.label} kept.`}),
        },
      }
    },

    key(row, key) {
      if (!row.setting) {
        return row.locked && row.resetHelp && key.name === 'r' ? locked(row) : extra?.key?.(row, key, {cwd, home, save})
      }

      if (key.name !== 'r') return
      if (row.locked) return locked(row)
      if (row.saved == null) return {message: `${row.setting.label} is already the default.`}
      save({[row.setting.key]: undefined})
      return {message: `Saved: ${row.setting.label.toLowerCase()} back to the default.`}
    },
  }

  return runMenu(menu, {input, output})
}

/**
 * A config command's run. With no change asked for and a terminal on both ends, the menu, then the settings
 * printed. Otherwise the changes the flags ask for (all checked before any is saved), a note for each one
 * ./civit-tool.config.json overrides, and the settings printed. A refused change exits with code 2.
 */
export async function runConfig(command, {asked, changes, listing, menu, notes}) {
  if (!asked && process.stdin.isTTY && process.stdout.isTTY) {
    await menu()
    command.log(listing(loadHomeConfig(), loadLocalConfig()))
    return
  }

  let wanted
  try {
    wanted = changes(loadHomeConfig())
    if (Object.keys(wanted).length > 0) command.log(`Saved in ${saveHomeSettings(wanted)}.`)
  } catch (error) {
    command.error(error.message, {exit: 2})
  }

  const local = loadLocalConfig()
  for (const note of notes(wanted, local)) command.log(chalk.yellow(note))
  if (Object.keys(wanted).length > 0) command.log('')
  command.log(listing(loadHomeConfig(), local))
}
