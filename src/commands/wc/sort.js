import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import {stdin as input, stdout as output} from 'node:process'
import readline from 'node:readline/promises'

import {loadConfig} from '../../lib/config.js'
import {ExpandError, findInput, normalizeWildcardPath, sortWildcardKeys} from '../../lib/wildcards.js'

const PREVIEW_LINES = 20
const PREVIEW_KEYS = 8

/** `a, b, c, … (+12)` */
const names = (keys) =>
  keys.slice(0, PREVIEW_KEYS).join(', ') + (keys.length > PREVIEW_KEYS ? `, … (+${keys.length - PREVIEW_KEYS})` : '')

export default class WcSort extends Command {
  static description =
    'Sort the keys of a wildcard YAML file by name under a path. "own/" sorts the keys directly under own; "own/*" also sorts every level below. List entries keep their order, and comments move with their keys.'

  static examples = [
    '<%= config.bin %> wc sort own.yaml "__own/__"            # only the keys directly under own',
    '<%= config.bin %> wc sort own.yaml "__own/*__"           # own and every level below it',
    '<%= config.bin %> wc sort own.yaml "own/{style|action}/" # the keys of style and action',
    '<%= config.bin %> wc sort own.yaml "*" --force           # the whole file, without asking',
    '<%= config.bin %> wc sort own.yaml "own/*" --output sorted.yaml',
  ]

  static args = {
    file: Args.string({
      description:
        'Wildcard YAML file. A bare file name is also looked up in the "wildcardsDir" folder from civit-tool.config.json.',
      required: true,
    }),
    path: Args.string({
      description:
        'Path, with or without the __ markers. Ending in "/" (or no ending): sort that level only. Ending in "/*" or "/**": that level and every level below. The part before may use * ** and {a|b} as in expand.',
      required: true,
    }),
  }

  static flags = {
    force: Flags.boolean({default: false, description: 'Rewrite without asking.'}),
    output: Flags.string({
      char: 'o',
      description: 'Write the sorted file here instead of rewriting the input (no question asked).',
    }),
  }

  async run() {
    const {args, flags} = await this.parse(WcSort)
    const config = loadConfig()

    const file = findInput(args.file, config.wildcardsDir)
    if (!file) {
      const hint = config.wildcardsDir ? ` (also looked in ${path.resolve(config.wildcardsDir)})` : ''
      this.error(`Input file not found: ${path.resolve(args.file)}${hint}`, {exit: 2})
    }

    const pattern = normalizeWildcardPath(args.path)
    if (!pattern) this.error('The path is empty. Use "*" for the whole file.', {exit: 2})

    let result
    try {
      result = sortWildcardKeys(fs.readFileSync(file, 'utf8'), pattern, {source: file})
    } catch (error) {
      if (error instanceof ExpandError) this.error(error.message, {exit: 1})
      throw error
    }

    const {changed, keys, note, reformatted, text} = result
    this.log(`input:    ${file}`)
    this.log(`path:     __${pattern}__${note ? chalk.yellow(`  (${note})`) : ''}`)
    this.log(`matched:  ${keys.map((key) => key || '(top level)').join(', ')}`)

    if (changed.length === 0) {
      this.log('Already in order; nothing to change.')
      return
    }

    this.log(`\n${changed.length} level(s) will be reordered:`)
    for (const {after, before, path: where} of changed.slice(0, PREVIEW_LINES)) {
      this.log(`  ${where || '(top level)'}: ${names(before)} -> ${chalk.green(names(after))}`)
    }

    if (changed.length > PREVIEW_LINES) this.log(`  … ${changed.length - PREVIEW_LINES} more`)
    if (reformatted) {
      this.log(
        chalk.yellow(
          '\nThe file is also reformatted: 2-space indent, folded >- text on one line, and a comment after "key:" on its own line. Values, comments and quoting are kept.',
        ),
      )
    }

    const target = path.resolve(flags.output ?? file)
    if (!flags.output && !flags.force) {
      const rl = readline.createInterface({input, output})
      const answer = await rl.question(`\nRewrite ${path.basename(file)}? [y/N] `)
      rl.close()
      if (!/^y$/i.test(answer.trim())) {
        this.log('Cancelled; the file is unchanged.')
        return
      }
    }

    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, text, 'utf8')
    this.log(`wrote:    ${target}`)
  }
}
