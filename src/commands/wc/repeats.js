import {Args, Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {loadConfig} from '../../lib/config.js'
import {makeLintConfig} from '../../lib/lint/index.js'
import {findRepeats, formatRepeats} from '../../lib/repeats.js'
import {parseWildcardFile} from '../../lib/wildcard-parser/index.js'
import {findYamlFiles} from '../../lib/wildcards.js'

export default class Repeats extends Command {
  static description = `Find text that repeats across wildcard entries: runs of words (prose branches such as krea:) or tags (everything else) that appear twice or more, so they can move into one shared leaf. Each repeat is reported in its longest form. Exit code 1 means repeats were found.`

  static examples = [
    '<%= config.bin %> wc repeats ./wildcards',
    '<%= config.bin %> wc repeats characters.yaml --min-words 8 --min-tags 4',
    '<%= config.bin %> wc repeats characters.yaml --any-order',
    '<%= config.bin %> wc repeats characters.yaml --path "my-lib/krea/**" --top 20',
    '<%= config.bin %> wc repeats ./wildcards --json > repeats.json',
  ]

  static args = {
    path: Args.string({
      description:
        'Wildcard YAML files or folders, checked together as one library. Default: the "wildcardsDir" folder from civit-tool.config.json.',
    }),
  }

  static flags = {
    'min-words': Flags.integer({
      default: 5,
      min: 1,
      description: 'Shortest repeat to report in prose, in words.',
    }),
    'min-tags': Flags.integer({
      default: 5,
      min: 1,
      description: 'Shortest repeat to report in tag lists, in tags.',
    }),
    'any-order': Flags.boolean({
      default: false,
      description:
        'Match tags as sets: entries sharing --min-tags or more tags count, in any order and mixed with other tags. Prose is always matched in order.',
    }),
    path: Flags.string({
      description: 'Only check entries whose key path matches this glob (* within a segment, ** across).',
    }),
    top: Flags.integer({min: 1, description: 'Show only the N biggest repeats (length × extra copies).'}),
    json: Flags.boolean({default: false, description: 'Print the repeats as JSON.'}),
  }

  static strict = false // several paths

  async run() {
    const {argv, flags} = await this.parse(Repeats)

    let repeats
    try {
      repeats = this.find(argv, flags)
    } catch (error) {
      this.error(error.message, {exit: 2})
    }

    const total = repeats.length
    if (flags.top) repeats = repeats.slice(0, flags.top)
    this.log(flags.json ? JSON.stringify(repeats, null, 2) : formatRepeats(repeats, total))
    if (total > 0) process.exitCode = 1
  }

  find(argv, flags) {
    const config = loadConfig()
    // The model branches (which keys are prose) come from the lint config.
    const {branches} = makeLintConfig(config.lint, 'civit-tool.config.json')

    const given = argv.length > 0 ? argv : config.wildcardsDir ? [config.wildcardsDir] : []
    if (given.length === 0) {
      throw new Error('Name the wildcard files or folders to check, or set "wildcardsDir" in civit-tool.config.json.')
    }

    const files = given
      .flatMap((p) => findYamlFiles(p, config.wildcardsDir))
      .map((file) =>
        parseWildcardFile(fs.readFileSync(file, 'utf8'), {path: path.relative(process.cwd(), file) || file, branches}),
      )
    return findRepeats(files, {
      minWords: flags['min-words'],
      minTags: flags['min-tags'],
      anyOrder: flags['any-order'],
      path: flags.path,
    })
  }
}
