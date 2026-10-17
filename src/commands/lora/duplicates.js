import {Args, Command} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {sha256} from '../../lib/hash.js'

function realPath(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Every .safetensors file under `root`, following symlinks and Windows junctions. Each physical
 * folder is scanned once, so a link back up the tree can't loop, and each physical file is listed
 * once, so a link to a file is never reported as a copy of it. Unreadable folders and broken links
 * are passed to `warn` and skipped.
 */
export function scanSafetensors(root, warn = () => {}) {
  const seenFolders = new Set()
  const seenFiles = new Set()
  const files = []

  function walk(folder) {
    const real = realPath(folder)
    if (seenFolders.has(real)) return
    seenFolders.add(real)

    let entries
    try {
      entries = fs.readdirSync(folder, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      warn(`Cannot read folder ${folder}: ${error.message}`)
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name)
      try {
        // statSync follows the link, so a linked folder or file is treated like the real one
        const stats = entry.isSymbolicLink() ? fs.statSync(fullPath) : entry
        if (stats.isDirectory()) {
          walk(fullPath)
        } else if (stats.isFile() && entry.name.toLowerCase().endsWith('.safetensors')) {
          const realFile = realPath(fullPath)
          if (seenFiles.has(realFile)) continue
          seenFiles.add(realFile)
          files.push({path: fullPath, size: fs.statSync(fullPath).size})
        }
      } catch (error) {
        warn(`Skipped ${fullPath}: ${error.message}`)
      }
    }
  }

  walk(root)

  return {files, folders: seenFolders.size}
}

/**
 * Groups files with identical content. Only files that share their size with another file can be
 * identical, so only those are hashed (SHA-256). `onHash(file, n, total)` is called before each hash.
 * Groups are sorted by the first file's name; files keep their scan order.
 */
export async function findDuplicates(files, onHash = () => {}) {
  const bySize = new Map()
  for (const file of files) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file])
  const candidates = [...bySize.values()].filter((group) => group.length > 1).flat()

  const byHash = new Map()
  let bytesHashed = 0
  for (const [i, file] of candidates.entries()) {
    onHash(file, i + 1, candidates.length)
    const hash = await sha256(file.path)
    bytesHashed += file.size
    byHash.set(hash, [...(byHash.get(hash) ?? []), file])
  }

  const groups = [...byHash]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({files: group, hash, size: group[0].size}))
    .sort((a, b) => path.basename(a.files[0].path).localeCompare(path.basename(b.files[0].path)))

  return {bytesHashed, groups, hashed: candidates.length}
}

/** The Civitai model name from an `activation` sidecar (`<name>.json` next to the file), if any. */
function civitaiNameOf(file) {
  const sidecar = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.json`)
  try {
    return JSON.parse(fs.readFileSync(sidecar, 'utf8'))['civitai model name'] || null
  } catch {
    return null
  }
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

export default class Duplicates extends Command {
  static description =
    'Find .safetensors files with identical content (SHA-256), in a folder and all its subfolders. Only lists them; nothing is deleted.'

  static examples = ['<%= config.bin %> lora duplicates', '<%= config.bin %> lora duplicates "path/to/forge/models"']

  static args = {
    path: Args.string({
      default: '.',
      description: 'Folder to scan, with all subfolders. Symlinks and junctions are followed.',
    }),
  }

  async run() {
    const {args} = await this.parse(Duplicates)
    const root = path.resolve(args.path)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) this.error(`Not a folder: ${root}`, {exit: 2})

    const started = Date.now()
    this.log(chalk.cyan(`Scanning ${root}`))
    const {files, folders} = scanSafetensors(root, (msg) => this.warn(msg))
    const {bytesHashed, groups, hashed} = await findDuplicates(files, (file, n, total) =>
      this.log(chalk.gray(`  [${n}/${total}] hashing ${path.relative(root, file.path)} (${formatBytes(file.size)})`)),
    )

    this.log('')
    if (groups.length === 0) {
      this.log(chalk.green('No identical .safetensors files found.'))
    }

    for (const group of groups) {
      const name = group.files.map((f) => civitaiNameOf(f.path)).find(Boolean)
      this.log(chalk.bold(path.basename(group.files[0].path)) + (name ? chalk.gray(`  (Civitai: ${name})`) : ''))
      this.log(`  ${group.files.length} copies, ${formatBytes(group.size)} each, SHA-256 ${group.hash}`)
      for (const file of group.files) this.log(`    ${file.path}`)
      this.log('')
    }

    const wasted = groups.reduce((sum, g) => sum + g.size * (g.files.length - 1), 0)
    const summary = [
      ['Folders scanned', folders],
      ['.safetensors files', files.length],
      ['Hashed', `${hashed}, ${formatBytes(bytesHashed)} (the others have a size no other file has)`],
      ['Duplicate groups', groups.length],
      ['Space in extra copies', formatBytes(wasted)],
      ['Time', `${((Date.now() - started) / 1000).toFixed(1)} s`],
    ]
    this.log(chalk.cyan('Summary'))
    for (const [label, value] of summary) this.log(`  ${`${label}:`.padEnd(23)}${value}`)
  }
}
