import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {collectImageMetadata} from '../../lib/imageMeta.js'
import {formatWeights, rankLoras} from '../../lib/loraUsage.js'

const SHOWN_NAMES = 8

/** `a.png, b.png, … (+3)` */
const names = (list) =>
  list.slice(0, SHOWN_NAMES).join(', ') + (list.length > SHOWN_NAMES ? `, … (+${list.length - SHOWN_NAMES})` : '')

export default class Loras extends Command {
  static description =
    'Rank the LoRAs used by the images in a folder, by how many images use each, with the weights they were used at. Reads the metadata of Forge / A1111 PNG, JPEG and WebP files (and LoRA loader nodes of ComfyUI images). A LoRA written twice in one prompt is reported as an error (exit code 1).'

  static examples = [
    '<%= config.bin %> img loras                       # the current folder',
    '<%= config.bin %> img loras ./outputs -r          # with subfolders, e.g. the ones img sort makes',
    '<%= config.bin %> img loras ./outputs --top 10',
    '<%= config.bin %> img loras ./outputs --json > loras.json',
  ]

  static args = {
    path: Args.string({default: '.', description: 'Folder with the images.', ignoreStdin: true}),
  }

  static flags = {
    recursive: Flags.boolean({char: 'r', default: false, description: 'Also read the images in subfolders.'}),
    top: Flags.integer({min: 1, description: 'Show only the N most used LoRAs.'}),
    json: Flags.boolean({
      default: false,
      description: 'Print the ranking as JSON. Status lines and warnings go to stderr.',
    }),
  }

  async run() {
    const {args, flags} = await this.parse(Loras)
    // with --json only the JSON goes to stdout, so it can be piped
    const status = (message) => (flags.json ? this.logToStderr(message) : this.log(message))

    const folder = path.resolve(args.path)
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      this.error(`Folder not found: ${folder}`, {exit: 2})
    }

    const {entries, failed, missing, total} = collectImageMetadata(folder, {recursive: flags.recursive})
    const {ranking, withLoras, duplicates} = rankLoras(entries)
    const shown = flags.top ? ranking.slice(0, flags.top) : ranking
    const share = (images) => (entries.length === 0 ? 0 : Math.round((images / entries.length) * 100))

    status(`folder:  ${folder}${flags.recursive ? ' (with subfolders)' : ''}`)
    status(`images:  ${total} (${entries.length} with metadata, ${withLoras} with LoRAs)`)
    if (missing.length > 0) status(chalk.yellow(`${missing.length} image(s) had no metadata: ${names(missing)}`))
    for (const {error, file} of failed) this.warn(`${file}: ${error}`)

    if (flags.json) {
      const json = {
        folder,
        images: total,
        withMetadata: entries.length,
        withLoras,
        ranking: shown.map(({images, name, weights}, i) => ({
          rank: i + 1,
          name,
          images,
          share: share(images),
          weights,
        })),
        duplicates,
      }
      this.log(JSON.stringify(json, null, 2))
    } else if (ranking.length === 0) {
      status(chalk.yellow('No LoRAs found.'))
    } else {
      this.log('')
      this.log(formatTable(shown, share))
      if (shown.length < ranking.length) this.log(`\n${shown.length} of ${ranking.length} LoRAs shown (--top).`)
    }

    if (duplicates.length > 0) {
      this.logToStderr(
        chalk.red(`\nerror: the same LoRA more than once in one prompt (${duplicates.length} image(s)):`),
      )
      for (const {file, loras} of duplicates) this.logToStderr(chalk.red(`  ${file}: ${loras.join(', ')}`))
      process.exitCode = 1
    }
  }
}

function formatTable(ranking, share) {
  const rows = ranking.map((lora, i) => [
    String(i + 1),
    String(lora.images),
    `${share(lora.images)}%`,
    formatWeights(lora.weights),
    lora.name,
  ])
  const head = ['#', 'images', 'share', 'weights', 'LoRA']
  const width = head.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c].length)))
  // numbers right-aligned, weights and names left-aligned; the name is last, so it isn't padded
  const line = (cells) =>
    cells.map((cell, c) => (c < 3 ? cell.padStart(width[c]) : c === 4 ? cell : cell.padEnd(width[c]))).join('  ')
  return [line(head), ...rows.map(line)].join('\n')
}
