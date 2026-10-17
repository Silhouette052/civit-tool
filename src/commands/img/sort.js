import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import {stdin as input, stdout as output} from 'node:process'
import readline from 'node:readline/promises'

import {IMAGE_EXTENSIONS} from '../../lib/imageMeta.js'

// <seed>_<denoise>_<model>_<yyyyMMddHHmmss>.<ext>, e.g.
// 2447751738_0.6_waiANIMA_v10Base10_20260929160902.png. The model name
// may itself contain underscores, so it is everything between the
// denoise value and the trailing 14-digit date.
const IMAGE_NAME_PATTERN = /^(\d+)_(\d*\.?\d+)_(.+)_(\d{14})\.[^.]+$/

/**
 * Splits a generated image's filename into its parts, or returns null
 * when it doesn't follow the seed_denoise_model_date pattern.
 */
export function parseImageName(filename) {
  if (!IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())) return null

  const match = filename.match(IMAGE_NAME_PATTERN)
  if (!match) return null

  const [, seed, denoise, model, date] = match
  return {date, denoise: Number(denoise), model, seed}
}

/**
 * Groups the direct (non-recursive) image files of a folder by the model
 * in their name. Returns the groups plus the files that were skipped.
 */
export function buildSortPlan(folderPath) {
  const groups = new Map()
  const skipped = []

  for (const entry of fs.readdirSync(folderPath, {withFileTypes: true})) {
    if (!entry.isFile()) continue

    const parsed = parseImageName(entry.name)

    if (!parsed) {
      if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) skipped.push(entry.name)
      continue
    }

    if (!groups.has(parsed.model)) groups.set(parsed.model, [])
    groups.get(parsed.model).push(entry.name)
  }

  const plan = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
    .map(([model, files]) => {
      const targetDir = path.join(folderPath, model)
      const targetExists = fs.existsSync(targetDir)

      return {
        files: files.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'})),
        folder: model,
        isDirectory: targetExists && fs.statSync(targetDir).isDirectory(),
        targetDir,
        targetExists,
      }
    })

  return {plan, skipped}
}

export default class Sort extends Command {
  static description =
    'Sort generated images (seed_denoise_model_date.png) into one folder per model. Only files directly in the folder are moved; model folders are created inside it.'

  static examples = [
    '<%= config.bin %> img sort',
    '<%= config.bin %> img sort ./outputs',
    '<%= config.bin %> img sort ./outputs --force',
  ]

  static args = {
    path: Args.string({
      default: '.',
      description: 'Folder to sort (not recursive). Model folders are created inside it.',
      // otherwise oclif reads the path from piped stdin, swallowing the y/N answer
      ignoreStdin: true,
    }),
  }

  static flags = {
    force: Flags.boolean({description: 'Skip the confirmation prompt.', default: false}),
  }

  async run() {
    const {args, flags} = await this.parse(Sort)

    const folderPath = path.resolve(args.path)
    const {plan, skipped} = buildSortPlan(folderPath)

    if (plan.length === 0) {
      this.log(chalk.yellow('No images matching seed_denoise_model_date found.'))
      if (skipped.length > 0) this.log(chalk.gray(`  (${skipped.length} other image(s) ignored)`))
      return
    }

    const blocked = plan.filter((group) => group.targetExists && !group.isDirectory)
    const movable = plan.filter((group) => !group.targetExists || group.isDirectory)
    const totalFiles = movable.reduce((sum, group) => sum + group.files.length, 0)

    this.log('')
    this.log(chalk.cyan(`  Folder: ${folderPath}`))
    this.log(chalk.cyan(`  ${totalFiles} image(s) will be moved into ${movable.length} folder(s):`))

    for (const group of movable) {
      const status = group.targetExists ? chalk.gray('existing') : chalk.green('new')
      this.log('')
      this.log(`  ${chalk.bold(group.folder)}/  (${status}, ${group.files.length} file(s))`)
      for (const file of group.files) this.log(`    ${file}`)
    }

    for (const group of blocked) {
      this.log('')
      this.log(
        chalk.red(`  ${group.folder}: a file with this name already exists, so ${group.files.length} image(s) stay put.`),
      )
    }

    if (skipped.length > 0) {
      this.log('')
      this.log(chalk.gray(`  ${skipped.length} image(s) don't match the naming pattern and stay put.`))
    }

    this.log('')

    if (movable.length === 0) return

    if (!flags.force) {
      const rl = readline.createInterface({input, output})
      const answer = await rl.question('Proceed with moving? [y/N] ')
      rl.close()

      if (!/^y$/i.test(answer.trim())) {
        this.log(chalk.yellow('Aborted. No files were moved.'))
        return
      }
    }

    let movedCount = 0
    let createdCount = 0
    let errorCount = 0

    for (const group of movable) {
      try {
        if (!group.targetExists) {
          fs.mkdirSync(group.targetDir)
          createdCount++
        }
      } catch (error) {
        this.log(chalk.red(`  ERROR creating '${group.folder}': ${error.message}`))
        errorCount += group.files.length
        continue
      }

      for (const file of group.files) {
        const destination = path.join(group.targetDir, file)

        if (fs.existsSync(destination)) {
          this.log(chalk.red(`  SKIPPED '${file}': already exists in ${group.folder}/`))
          errorCount++
          continue
        }

        try {
          fs.renameSync(path.join(folderPath, file), destination)
          movedCount++
        } catch (error) {
          this.log(chalk.red(`  ERROR moving '${file}': ${error.message}`))
          errorCount++
        }
      }
    }

    this.log(chalk.cyan(`Done. ${movedCount} moved, ${createdCount} folder(s) created, ${errorCount} failed or skipped.`))
  }
}
