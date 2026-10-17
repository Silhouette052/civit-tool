import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {collectImageMetadata, promptLine} from '../../lib/imageMeta.js'

const SHOWN_NAMES = 8

/** `a.png, b.png, … (+3)` */
const names = (list) =>
  list.slice(0, SHOWN_NAMES).join(', ') + (list.length > SHOWN_NAMES ? `, … (+${list.length - SHOWN_NAMES})` : '')

export default class Meta extends Command {
  static description =
    'Extract the generation metadata (prompt, negative prompt, settings) of every image in a folder to metadata.json, or only the prompts to prompts.txt. Reads Forge / A1111 PNG, JPEG and WebP files; subfolders are not read.'

  static examples = [
    '<%= config.bin %> img meta                              # metadata.json in the current folder',
    '<%= config.bin %> img meta ./outputs --prompt           # prompts.txt, one prompt per line',
    '<%= config.bin %> img meta ./outputs --stdout           # the JSON to the console',
    '<%= config.bin %> img meta ./outputs --prompt --stdout | clip',
  ]

  static args = {
    path: Args.string({
      default: '.',
      description: 'Folder with the images (not recursive).',
      ignoreStdin: true,
    }),
  }

  static flags = {
    output: Flags.string({
      char: 'o',
      description: 'File to write. Default: metadata.json (prompts.txt with --prompt) in the image folder.',
    }),
    prompt: Flags.boolean({
      default: false,
      description:
        'Only the prompts, as text: one line per image, line breaks inside a prompt become a space. Ready for "Prompts from file or textbox".',
    }),
    stdout: Flags.boolean({
      default: false,
      description: 'Print to the console instead of writing a file. Status lines go to stderr.',
    }),
  }

  async run() {
    const {args, flags} = await this.parse(Meta)
    // with --stdout only the result goes to stdout, so it can be piped
    const status = (message) => (flags.stdout ? this.logToStderr(message) : this.log(message))

    const folder = path.resolve(args.path)
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      this.error(`Folder not found: ${folder}`, {exit: 2})
    }

    const {entries, failed, missing, total} = collectImageMetadata(folder)
    const withPrompt = entries.filter((entry) => entry.prompt)
    const kept = flags.prompt ? withPrompt : entries

    status(`folder:   ${folder}`)
    status(`images:   ${total} (${entries.length} with metadata)`)
    if (missing.length > 0) {
      status(chalk.yellow(`${missing.length} image(s) had no metadata: ${names(missing)}`))
    }

    if (flags.prompt && withPrompt.length < entries.length) {
      const noPrompt = entries.filter((entry) => !entry.prompt).map((entry) => entry.file)
      status(chalk.yellow(`${noPrompt.length} image(s) had metadata but no prompt: ${names(noPrompt)}`))
    }

    for (const {error, file} of failed) this.warn(`${file}: ${error}`)

    if (kept.length === 0) {
      status(chalk.yellow(flags.prompt ? 'No prompts found; nothing written.' : 'No metadata found; nothing written.'))
      return
    }

    const text = flags.prompt
      ? kept.map((entry) => promptLine(entry.prompt)).join('\n') + '\n'
      : JSON.stringify(kept, null, 2) + '\n'

    if (flags.stdout) {
      process.stdout.write(text)
      return
    }

    const target = path.resolve(flags.output ?? path.join(folder, flags.prompt ? 'prompts.txt' : 'metadata.json'))
    const replaced = fs.existsSync(target)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, text, 'utf8')
    if (flags.prompt) status(`prompts:  ${kept.length}`)
    status(`wrote:    ${target}${replaced ? chalk.yellow('  (replaced the existing file)') : ''}`)
  }
}
