import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {loadConfig} from '../../lib/config.js'
import {
  ExpandError,
  expandWildcard,
  fileNameFor,
  findInput,
  loadLibrary,
  normalizeWildcardPath,
} from '../../lib/wildcards.js'

const DEFAULT_MAX = 10_000

export default class Expand extends Command {
  static description =
    "Write every prompt a wildcard path can produce to a text file, one per line, like Dynamic Prompts' combinatorial mode. Duplicates are removed."

  static examples = [
    '<%= config.bin %> wc expand tshirt-gamenight.yaml "__tshirt-gamenight/wh40k/front-krea/*/matyi__"',
    '<%= config.bin %> wc expand ./wildcards/hair.yaml "hair/**" --output hair.txt',
    '<%= config.bin %> wc expand clothes.yaml "clothes/*" --max 50000',
    '<%= config.bin %> wc expand scenes.yaml "scenes/battle/*" --keep-long 10',
  ]

  static args = {
    file: Args.string({
      description:
        'Wildcard YAML file. A bare file name is also looked up in the "wildcardsDir" folder from civit-tool.config.json.',
      required: true,
    }),
    wildcard: Args.string({
      description:
        'Wildcard path, with or without the __ markers. * matches within one path segment, ** across segments. Quote it so the shell leaves the * alone.',
      required: true,
    }),
  }

  static flags = {
    'keep-long': Flags.integer({
      description:
        'Write entries with at least this many words as they are, without expanding their variants and references. A word is a piece between spaces, commas and { } | ( ) that contains a letter.',
      min: 1,
    }),
    max: Flags.integer({
      default: DEFAULT_MAX,
      description: 'Stop if the path expands to more than this many prompts.',
      min: 1,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Text file to write. Default: named after the wildcard path, in the current folder.',
    }),
  }

  async run() {
    const {args, flags} = await this.parse(Expand)
    const config = loadConfig()

    const input = findInput(args.file, config.wildcardsDir)
    if (!input) {
      const hint = config.wildcardsDir ? ` (also looked in ${path.resolve(config.wildcardsDir)})` : ''
      this.error(`Input file not found: ${path.resolve(args.file)}${hint}`, {exit: 2})
    }

    const pattern = normalizeWildcardPath(args.wildcard)
    if (!pattern) this.error('The wildcard path is empty.', {exit: 2})

    const warnings = new Set()
    const warn = (msg) => warnings.add(msg)

    let result
    try {
      const leaves = loadLibrary(input, warn)
      result = expandWildcard(leaves, pattern, {keepWords: flags['keep-long'], max: flags.max, source: input, warn})
    } catch (error) {
      if (error instanceof ExpandError) this.error(error.message, {exit: 1})
      throw error
    }

    const {kept, keys, note, prompts, total} = result
    const output = path.resolve(flags.output ?? `${fileNameFor(pattern)}.txt`)
    const replaced = fs.existsSync(output)
    fs.mkdirSync(path.dirname(output), {recursive: true})
    fs.writeFileSync(output, prompts.join('\n') + '\n', 'utf8')

    const shown = keys.slice(0, 8).join(', ') + (keys.length > 8 ? `, … (${keys.length - 8} more)` : '')
    const removed = total - prompts.length

    this.log(`input:    ${input}`)
    this.log(`path:     __${pattern}__${note ? chalk.yellow(`  (${note})`) : ''}`)
    this.log(`matched:  ${keys.length} wildcard${keys.length === 1 ? '' : 's'}: ${shown}`)
    this.log(`prompts:  ${prompts.length}${removed ? ` (${total} combinations, ${removed} duplicates removed)` : ''}`)
    if (flags['keep-long']) {
      this.log(
        `kept:     ${kept} entr${kept === 1 ? 'y' : 'ies'} with ${flags['keep-long']}+ words written as they are`,
      )
    }

    this.log(`wrote:    ${output}${replaced ? chalk.yellow('  (replaced the existing file)') : ''}`)
    for (const msg of warnings) this.warn(msg)
  }
}
