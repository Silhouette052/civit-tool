import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import {stdin as input, stdout as output} from 'node:process'
import readline from 'node:readline/promises'

function findFiles(folderPath, {recursive}) {
  const results = []

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, {withFileTypes: true})

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        if (recursive) walk(fullPath)
      } else if (entry.isFile()) {
        results.push(fullPath)
      }
    }
  }

  walk(folderPath)

  return results
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(
    date.getMinutes(),
  )}`
}

/**
 * Builds a rename plan that renumbers every .png file in original-name
 * order to "<index>-<timestamp>.png", e.g. 0001-2026-08-20-12-33.png.
 * The timestamp is captured once and shared by the whole batch.
 */
function buildSequenceRenamePlan(files, {start, width}) {
  const timestamp = formatTimestamp(new Date())

  const pngFiles = files
    .filter((filepath) => path.extname(filepath).toLowerCase() === '.png')
    .sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, {numeric: true, sensitivity: 'base'}),
    )

  return pngFiles.map((filepath, i) => {
    const dir = path.dirname(filepath)
    const oldName = path.basename(filepath)
    const index = String(i + start).padStart(width, '0')
    const newName = `${index}-${timestamp}.png`

    return {dir, newName, newPath: path.join(dir, newName), oldName, oldPath: filepath}
  })
}

const isCaseOnlyChange = (item) => item.oldPath !== item.newPath && item.oldPath.toLowerCase() === item.newPath.toLowerCase()

/**
 * Returns the plan entries that would overwrite a file, mapped to the reason:
 * the new name already exists, or an earlier entry in the plan takes the same
 * new name. A case-only rename of the same file (a.png -> A.png) is fine.
 */
export function findRenameConflicts(plan) {
  const conflicts = new Map()
  const claimed = new Set()

  for (const item of plan) {
    const key = item.newPath.toLowerCase()

    if (claimed.has(key)) {
      conflicts.set(item, 'another file in this rename gets the same name')
    } else if (fs.existsSync(item.newPath) && !isCaseOnlyChange(item)) {
      conflicts.set(item, 'a file with this name already exists')
    }

    claimed.add(key)
  }

  return conflicts
}

export default class Rename extends Command {
  static description =
    'Bulk-rename files by replacing a substring in their filename. Defaults to collapsing "__" to "_".'

  static examples = [
    '<%= config.bin %> file rename ./loras',
    '<%= config.bin %> file rename ./loras --recurse',
    '<%= config.bin %> file rename ./loras --find "old" --replace "new" --force',
    '<%= config.bin %> file rename ./screenshots --sequence',
    '<%= config.bin %> file rename ./screenshots --sequence --width 5 --start 0',
  ]

  static args = {
    path: Args.string({description: 'Folder to scan.', default: '.'}),
  }

  static flags = {
    find: Flags.string({char: 'f', description: 'Substring to search for.', default: '__'}),
    replace: Flags.string({char: 'r', description: 'Replacement string.', default: '_'}),
    recurse: Flags.boolean({description: 'Include subfolders.', default: false}),
    force: Flags.boolean({description: 'Skip the confirmation prompt.', default: false}),
    'case-sensitive': Flags.boolean({description: 'Match case-sensitively.', default: false}),
    sequence: Flags.boolean({
      description:
        'Rename every .png file to "<index>-<timestamp>.png" (e.g. 0001-2026-08-20-12-33.png), ordered by original filename. Ignores --find/--replace.',
      default: false,
    }),
    width: Flags.integer({description: 'Digit width for the --sequence index.', default: 4}),
    start: Flags.integer({description: 'Starting index for --sequence.', default: 1}),
  }

  async run() {
    const {args, flags} = await this.parse(Rename)

    const resolvedPath = path.resolve(args.path)
    const allFiles = findFiles(resolvedPath, {recursive: flags.recurse})

    let renamePlan

    if (flags.sequence) {
      renamePlan = buildSequenceRenamePlan(allFiles, {start: flags.start, width: flags.width})

      if (renamePlan.length === 0) {
        this.log(chalk.yellow('No .png files found.'))
        return
      }
    } else {
      const pattern = escapeRegExp(flags.find)
      const matcher = new RegExp(pattern, flags['case-sensitive'] ? 'g' : 'gi')

      renamePlan = allFiles
        .filter((filepath) => {
          matcher.lastIndex = 0
          return matcher.test(path.basename(filepath))
        })
        .map((filepath) => {
          matcher.lastIndex = 0
          const dir = path.dirname(filepath)
          const oldName = path.basename(filepath)
          const newName = oldName.replace(matcher, flags.replace)

          return {dir, newName, newPath: path.join(dir, newName), oldName, oldPath: filepath}
        })

      if (renamePlan.length === 0) {
        this.log(chalk.yellow(`No files found containing "${flags.find}" in their name.`))
        return
      }
    }

    this.log('')
    this.log(chalk.cyan(`  The following ${renamePlan.length} file(s) will be renamed:`))
    this.log('')

    const dirWidth = Math.max(...renamePlan.map((r) => r.dir.length), 'Directory'.length)
    const oldWidth = Math.max(...renamePlan.map((r) => r.oldName.length), 'Old Name'.length)

    this.log(`  ${'Directory'.padEnd(dirWidth)}  ${'Old Name'.padEnd(oldWidth)}  New Name`)
    this.log(`  ${'-'.repeat(dirWidth + oldWidth + 12)}`)

    const conflicts = findRenameConflicts(renamePlan)

    for (const item of renamePlan) {
      const newName = conflicts.has(item)
        ? chalk.yellow(`${item.newName}  (skipped: ${conflicts.get(item)})`)
        : chalk.green(item.newName)
      this.log(`  ${chalk.gray(item.dir.padEnd(dirWidth))}  ${chalk.red(item.oldName.padEnd(oldWidth))}  ${newName}`)
    }

    this.log('')

    if (conflicts.size > 0) {
      this.log(
        chalk.yellow(
          `  WARNING: ${conflicts.size} file(s) would overwrite another file. They will be skipped and keep their current name.`,
        ),
      )
      this.log('')
    }

    if (conflicts.size === renamePlan.length) {
      this.log(chalk.yellow('Nothing to rename.'))
      return
    }

    if (!flags.force) {
      const rl = readline.createInterface({input, output})
      const answer = await rl.question('Proceed with rename? [y/N] ')
      rl.close()

      if (!/^y$/i.test(answer.trim())) {
        this.log(chalk.yellow('Aborted. No files were renamed.'))
        return
      }
    }

    let successCount = 0
    let errorCount = 0

    for (const item of renamePlan) {
      if (conflicts.has(item)) continue

      // checked again: the file may have appeared while the prompt was open
      if (fs.existsSync(item.newPath) && !isCaseOnlyChange(item)) {
        this.log(chalk.yellow(`  SKIPPED '${item.oldName}': '${item.newName}' already exists`))
        errorCount++
        continue
      }

      try {
        fs.renameSync(item.oldPath, item.newPath)
        this.log(chalk.green(`  Renamed: ${item.oldName}  ->  ${item.newName}`))
        successCount++
      } catch (error) {
        this.log(chalk.red(`  ERROR renaming '${item.oldName}': ${error.message}`))
        errorCount++
      }
    }

    this.log('')
    this.log(chalk.cyan(`Done. ${successCount} renamed, ${errorCount + conflicts.size} skipped or failed.`))
  }
}
