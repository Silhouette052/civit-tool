import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import {stdin as input, stdout as output} from 'node:process'
import readline from 'node:readline/promises'

import {loadConfig} from '../../lib/config.js'
import {compileFilenamePattern, DEFAULT_FILENAME_PATTERN, imageNaming} from '../../lib/filenamePattern.js'
import {IMAGE_EXTENSIONS} from '../../lib/imageMeta.js'

// The file names follow Forge's "Filename pattern for saving images", set with img config. The default,
// [seed]_[denoising]_[model_name]_[datetime], gives 2447751738_0.6_waiANIMA_v10Base10_20260929160902.png; the model
// name may itself contain underscores.
const DEFAULT_NAMES = compileFilenamePattern(DEFAULT_FILENAME_PATTERN)

/**
 * The model in a generated image's file name, as {model}, or null when it isn't an image or doesn't follow the
 * pattern `names` was compiled from (compileFilenamePattern).
 */
export function parseImageName(filename, names = DEFAULT_NAMES) {
  if (!IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())) return null
  return names.parse(filename)
}

/**
 * Groups the direct (non-recursive) image files of a folder by the model
 * in their name. Returns the groups plus the files that were skipped.
 */
export function buildSortPlan(folderPath, names = DEFAULT_NAMES) {
  const groups = new Map()
  const skipped = []

  for (const entry of fs.readdirSync(folderPath, {withFileTypes: true})) {
    if (!entry.isFile()) continue

    const parsed = parseImageName(entry.name, names)

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
    "Sort generated images into one folder per model, read from their file names. The names follow Forge's filename pattern, [seed]_[denoising]_[model_name]_[datetime] unless img config sets yours. Only files directly in the folder are moved; model folders are created inside it."

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
    const naming = imageNaming(loadConfig())
    let names
    try {
      names = compileFilenamePattern(naming.pattern, naming)
    } catch (error) {
      this.error(`img.filenamePattern in the config: ${error.message}`, {exit: 2})
    }

    const {plan, skipped} = buildSortPlan(folderPath, names)
    const described = `${naming.pattern}${naming.addNumber ? ' (with the ascending number)' : ''}`

    if (plan.length === 0) {
      this.log(chalk.yellow(`No images named by the filename pattern ${described} found.`))
      if (skipped.length > 0) this.log(chalk.gray(`  (${skipped.length} other image(s) ignored)`))
      this.log(chalk.gray('  If Forge names your images differently, set its pattern with: civit-tool img config'))
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
      this.log(chalk.gray(`  ${skipped.length} image(s) don't match the filename pattern ${described} and stay put.`))
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
