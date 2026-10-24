import {Command} from '@oclif/core'
import chalk from 'chalk'

import {compileFilenamePattern, DEFAULT_FILENAME_PATTERN, exampleName, imageNaming} from '../../lib/filenamePattern.js'
import {
  changesAsked,
  changesFromFlags,
  formatSettings,
  overrideNotes,
  runConfig,
  settingAt,
  settingFlags,
  settingsMenu,
  switchSetting,
  textSetting,
  unquote,
} from '../../lib/settings.js'

/** The image settings: how Forge names the images, so img sort can read the model out of the names. */
export const IMG_SETTINGS = [
  textSetting({
    check(text) {
      const pattern = unquote(text)
      compileFilenamePattern(pattern) // refuses a pattern img sort can't use
      return pattern
    },
    default: DEFAULT_FILENAME_PATTERN,
    flag: 'pattern',
    help: "Forge's Settings → Saving images/grids → Filename pattern for saving images; it needs [model_name]",
    key: 'img.filenamePattern',
    label: 'Filename pattern',
    prompt: "Forge's filename pattern, e.g. [seed]_[denoising]_[model_name]_[datetime]",
  }),
  switchSetting({
    default: false,
    flag: 'add-number',
    help: "Forge's option, in the same place, to add an ascending number to file names (00042-…)",
    key: 'img.addNumber',
    label: 'Ascending number',
  }),
]

/** A file name Forge would save with the settings in use, to compare with your own images. */
function exampleLine(home, local) {
  const value = (key) => settingAt(local, key) ?? settingAt(home, key)
  const naming = imageNaming({img: {addNumber: value('img.addNumber'), filenamePattern: value('img.filenamePattern')}})
  const width = Math.max(...IMG_SETTINGS.map((setting) => setting.label.length))
  return `${'Example'.padEnd(width)}  ${exampleName(naming.pattern, naming)}${chalk.gray('  (what img sort looks for)')}`
}

/** The settings as img config prints them. */
export const formatImgSettings = (home = {}, local = {}, options = {}) =>
  formatSettings(IMG_SETTINGS, home, local, {...options, more: ['', exampleLine(home, local)]})

/** The img config menu. `home` and `cwd` are for the tests. */
export function imgConfigMenu(options = {}) {
  return settingsMenu(IMG_SETTINGS, {
    ...options,
    extra: {
      rows: (home, local) => [
        {selectable: false, text: ''},
        {selectable: false, text: exampleLine(home, local)},
      ],
    },
  })
}

export default class Config extends Command {
  static description = `Show or change how Forge names your images, so img sort can find the model name in them: the "Filename pattern for saving images" and whether Forge adds an ascending number (both under Settings → Saving images/grids). With no flags, in a terminal, it opens a menu: ↑/↓ to move, Enter to change a setting, r for its default, q to leave. Otherwise, or with --list, it prints the settings with an example file name. Changes are saved in ~/.civit-tool.config.json; a ./civit-tool.config.json in the current folder still overrides them.`

  static examples = [
    '<%= config.bin %> img config',
    '<%= config.bin %> img config --list',
    '<%= config.bin %> img config --pattern "[seed]_[denoising]_[model_name]_[datetime]"',
    '<%= config.bin %> img config --pattern "[model_name]-[seed]" --add-number on',
    '<%= config.bin %> img config --reset pattern --reset add-number',
  ]

  static flags = settingFlags(IMG_SETTINGS)

  async run() {
    const {flags} = await this.parse(Config)
    await runConfig(this, {
      asked: flags.list || changesAsked(IMG_SETTINGS, flags),
      changes: () => changesFromFlags(IMG_SETTINGS, flags),
      listing: (home, local) => formatImgSettings(home, local),
      menu: () => imgConfigMenu(),
      notes: (changes, local) => overrideNotes(IMG_SETTINGS, changes, local),
    })
  }
}
