import {Command} from '@oclif/core'
import chalk from 'chalk'

import {CIVITAI_DOMAINS} from '../../lib/civitaiClient.js'
import {DEFAULT_WARN_CHARS, DEFAULT_YAML_NAME} from '../../lib/config.js'
import {
  changesAsked,
  changesFromFlags,
  choiceSetting,
  formatSettings,
  overrideNotes,
  runConfig,
  settingFlags,
  settingsMenu,
  switchSetting,
  textSetting,
  unquote,
} from '../../lib/settings.js'

/** The LoRA settings, in the order the menu and the listing show them. */
export const LORA_SETTINGS = [
  choiceSetting({
    default: CIVITAI_DOMAINS[0],
    flag: 'domain',
    help: 'lora activation and lora url look LoRAs up on this site first, then on the other one',
    key: 'domain',
    label: 'Civitai site',
    options: CIVITAI_DOMAINS,
  }),
  textSetting({
    check(text) {
      const chars = text.trim()
      if (chars.toLowerCase() === 'none') return ''
      if (/\s/.test(chars)) throw new Error("Warn characters can't include spaces.")
      return [...new Set(chars)].join('')
    },
    default: DEFAULT_WARN_CHARS,
    flag: 'warn-chars',
    help: 'lora activation warns about LoRA names with these characters and offers to remove them; "none" turns it off',
    key: 'warnChars',
    label: 'Warn characters',
    prompt: 'New warn characters, e.g. @&# ("none" for no warning)',
    show: (value) => (value === '' ? 'none' : value),
  }),
  switchSetting({
    default: true,
    flag: 'sort-base',
    help: 'lora activation offers to sort a folder of mixed LoRAs into one folder per base model',
    key: 'activation.sortBaseModels',
    label: 'Base model sort',
  }),
  textSetting({
    check(text) {
      const name = unquote(text)
      if (!/^[^/\\]+\.ya?ml$/i.test(name)) {
        throw new Error('The LoRA list file needs a plain file name ending in .yaml or .yml, e.g. my-loras.yaml.')
      }

      return name
    },
    default: DEFAULT_YAML_NAME,
    flag: 'yaml-name',
    help: 'The wildcard list of LoRAs that lora activation writes next to them',
    key: 'activation.yamlName',
    label: 'LoRA list file',
  }),
]

/** The Civitai API key is an environment variable, never saved here; the menu and listing say whether it's set. */
function apiKeyLine() {
  const width = Math.max(...LORA_SETTINGS.map((setting) => setting.label.length))
  const state = process.env.CIVITAI_API_TOKEN ? 'set' : 'not set'
  return `${'Civitai API key'.padEnd(width)}  ${state}${chalk.gray('  (the CIVITAI_API_TOKEN environment variable)')}`
}

/** The settings as lora config prints them. */
export const formatLoraSettings = (home = {}, local = {}, options = {}) =>
  formatSettings(LORA_SETTINGS, home, local, {...options, more: ['', apiKeyLine()]})

/** The lora config menu. `home` and `cwd` are for the tests. */
export function loraConfigMenu(options = {}) {
  return settingsMenu(LORA_SETTINGS, {
    ...options,
    extra: {
      rows: () => [
        {selectable: false, text: ''},
        {selectable: false, text: apiKeyLine()},
      ],
    },
  })
}

export default class Config extends Command {
  static description = `Show or change the LoRA settings: the Civitai site to look LoRAs up on first, the characters lora activation warns about in LoRA names, its base model sort offer, and the name of its LoRA list file. With no flags, in a terminal, it opens a menu: ↑/↓ to move, Enter to change a setting, r for its default, q to leave. Otherwise, or with --list, it prints the settings. Changes are saved in ~/.civit-tool.config.json; a ./civit-tool.config.json in the current folder still overrides them.`

  static examples = [
    '<%= config.bin %> lora config',
    '<%= config.bin %> lora config --list',
    '<%= config.bin %> lora config --domain civitai.com',
    '<%= config.bin %> lora config --warn-chars "@&#"',
    '<%= config.bin %> lora config --sort-base off --yaml-name my-loras.yaml',
    '<%= config.bin %> lora config --reset warn-chars',
  ]

  static flags = settingFlags(LORA_SETTINGS)

  async run() {
    const {flags} = await this.parse(Config)
    await runConfig(this, {
      asked: flags.list || changesAsked(LORA_SETTINGS, flags),
      changes: () => changesFromFlags(LORA_SETTINGS, flags),
      listing: (home, local) => formatLoraSettings(home, local),
      menu: () => loraConfigMenu(),
      notes: (changes, local) => overrideNotes(LORA_SETTINGS, changes, local),
    })
  }
}
