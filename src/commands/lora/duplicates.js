import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import {hashCacheFile, openHashCache} from '../../lib/hashCache.js'
import {namesOfLora, readLoraFolder} from '../../lib/safetensors.js'

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
 * are passed to `warn` and skipped. Returns {files: [{path, size}], folders: real paths of the folders read}.
 */
export function scanSafetensors(root, warn = () => {}) {
  const seenFolders = new Set()
  const seenFiles = new Set()
  const files = []
  const folders = []

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

    folders.push(real)

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

  return {files, folders}
}

/**
 * Groups files with identical content. Only files that share their size with another file can be
 * identical, so only those are hashed (SHA-256). A hash comes from `cache` while the file is unchanged,
 * unless `rehash`. `onHash(file, n, total, cached)` is called before each one.
 * Groups are sorted by the first file's name; files keep their scan order.
 */
export async function findDuplicates(files, {cache = openHashCache(null), onHash = () => {}, rehash = false} = {}) {
  const bySize = new Map()
  for (const file of files) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file])
  const candidates = [...bySize.values()].filter((group) => group.length > 1).flat()

  const byHash = new Map()
  let bytesHashed = 0
  let fromCache = 0
  for (const [i, file] of candidates.entries()) {
    const cached = rehash ? null : cache.lookup(file.path)
    onHash(file, i + 1, candidates.length, cached !== null)
    const hash = cached ?? (await cache.hash(file.path))
    if (cached === null) bytesHashed += file.size
    else fromCache++
    byHash.set(hash, [...(byHash.get(hash) ?? []), file])
  }

  const groups = [...byHash]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({files: group, hash, size: group[0].size}))
    .sort((a, b) => path.basename(a.files[0].path).localeCompare(path.basename(b.files[0].path)))

  return {bytesHashed, fromCache, groups, hashed: candidates.length - fromCache}
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

// the previews Forge shows on a LoRA card: name.png, name.preview.png, and the same as .jpg / .jpeg / .webp
const PREVIEW_SUFFIX = /^(?:\.preview)?\.(?:png|jpe?g|webp)$/i

/**
 * Each copy of a duplicate group with the files deleting it would remove: the copy and every file in its folder
 * named after it (sidecar .json, previews, .civitai.info…), by the rule lora activation renames and sorts LoRAs
 * with. Returns [{path, files: full paths, the copy first, config, preview}]; `config` is a `<name>.json` next to it
 * (+c), `preview` a preview image (+p). `listings` keeps each folder's listing (readLoraFolder) between calls, as
 * a models folder can hold thousands of files; drop a folder from it after deleting there.
 */
export function copiesWithFiles(paths, listings = new Map()) {
  return paths.map((file) => {
    const folder = path.dirname(file)
    const lora = path.basename(file)
    const stem = path.basename(file, path.extname(file))
    let names = [lora]
    try {
      if (!listings.has(folder)) listings.set(folder, readLoraFolder(folder))
      const {names: all, stems} = listings.get(folder)
      names = namesOfLora(lora, stems, all)
      // a linked copy isn't among the folder's files
      if (!names.includes(lora)) names.unshift(lora)
    } catch {
      // an unreadable folder: only the copy itself
    }

    const suffixes = names.map((name) => name.slice(stem.length))
    return {
      config: suffixes.some((suffix) => suffix.toLowerCase() === '.json'),
      files: names.map((name) => path.join(folder, name)),
      path: file,
      preview: suffixes.some((suffix) => PREVIEW_SUFFIX.test(suffix)),
    }
  })
}

/**
 * The files to delete when copy `keep` (an index) is kept: the other copies with their files, but never a file of
 * the kept copy, nor any other .safetensors than the copies themselves.
 */
export function filesToDelete(copies, keep) {
  // two copies with the same name in one folder (x.safetensors, x.SAFETENSORS) both claim the files named after them
  const copyPaths = new Set(copies.map((copy) => copy.path))
  const kept = new Set(copies[keep].files.filter((file) => file === copies[keep].path || !copyPaths.has(file)))
  const doomed = copies
    .filter((_, i) => i !== keep)
    .flatMap((copy) => copy.files.filter((file) => file === copy.path || !file.toLowerCase().endsWith('.safetensors')))
    .filter((file) => !kept.has(file))
  return [...new Set(doomed)]
}

/** The answer to "Keep which one?": a copy's index, 'skip' (Enter), 'stop' (q), or null to ask again. */
export function parseKeepAnswer(answer, count) {
  const text = answer.trim().toLowerCase()
  if (text === '') return 'skip'
  if (text === 'q') return 'stop'
  const n = /^\d+$/.test(text) ? Number(text) : 0
  return n >= 1 && n <= count ? n - 1 : null
}

/** `(+c +p, also x.civitai.info)` for a copy's option line; '' when it has no other files. */
function companionNote(copy) {
  const marks = [copy.config && '+c', copy.preview && '+p'].filter(Boolean).join(' ')
  const stem = path.basename(copy.path, path.extname(copy.path))
  const others = copy.files
    .slice(1)
    .map((file) => path.basename(file))
    .filter((name) => {
      const suffix = name.slice(stem.length)
      return suffix.toLowerCase() !== '.json' && !PREVIEW_SUFFIX.test(suffix)
    })
  const also = others.length > 0 ? `also ${others.join(', ')}` : ''
  const note = [marks, also].filter(Boolean).join(', ')
  return note ? `  (${note})` : ''
}

/**
 * One question at a time on stdin; the end of input (or Ctrl+C) answers null. Piped lines are queued for the
 * questions to come (readline would drop the ones that arrive early) and echoed, as a terminal shows typed ones.
 * In a terminal, a line typed before its question is shown is dropped: it would answer a group not yet seen.
 * Once closed, the interface is never touched again (newer Node versions throw ERR_USE_AFTER_CLOSE).
 */
export function lineReader(input = process.stdin, output = process.stdout) {
  const terminal = Boolean(input.isTTY)
  const rl = readline.createInterface({input, output})
  const lines = []
  let waiting = null
  let closed = false
  rl.on('line', (line) => {
    if (waiting) waiting(line)
    else if (!terminal) lines.push(line)
    waiting = null
  })
  rl.on('close', () => {
    closed = true
    if (waiting) waiting(null)
    waiting = null
  })

  const ask = (prompt) => {
    if (lines.length > 0) {
      const line = lines.shift()
      output.write(`${prompt}${line}\n`)
      return Promise.resolve(line)
    }

    if (closed) return Promise.resolve(null)
    rl.setPrompt(prompt)
    rl.prompt()
    return new Promise((resolve) => {
      waiting = (line) => {
        if (line !== null && !terminal) output.write(`${line}\n`)
        resolve(line)
      }
    })
  }

  const close = () => {
    if (!closed) rl.close()
  }

  return {ask, close}
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
    "Find .safetensors files with identical content (SHA-256), in a folder and all its subfolders, then ask for each group which copy to keep: the other copies are deleted with the files named after them (.json, previews…). Enter skips a group, q stops; --list only lists. Hashes are cached in civit-tool's own folder (.cache/hashes.json), so a file whose size and modify time haven't changed isn't read again."

  static examples = [
    '<%= config.bin %> lora duplicates',
    '<%= config.bin %> lora duplicates "path/to/forge/models"',
    '<%= config.bin %> lora duplicates "path/to/forge/models" --list',
    '<%= config.bin %> lora duplicates "path/to/forge/models" --rehash',
  ]

  static args = {
    path: Args.string({
      default: '.',
      description: 'Folder to scan, with all subfolders. Symlinks and junctions are followed.',
    }),
  }

  static flags = {
    list: Flags.boolean({
      default: false,
      description: "Only list the duplicates; don't ask which copy to keep, so nothing is deleted.",
    }),
    rehash: Flags.boolean({
      default: false,
      description: 'Hash every file again instead of using the cached hashes, and update the cache.',
    }),
  }

  async run() {
    const {args, flags} = await this.parse(Duplicates)
    const root = path.resolve(args.path)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) this.error(`Not a folder: ${root}`, {exit: 2})

    const started = Date.now()
    this.log(chalk.cyan(`Scanning ${root}`))
    const {files, folders} = scanSafetensors(root, (msg) => this.warn(msg))
    const cache = openHashCache(hashCacheFile(), (msg) => this.warn(msg))
    const pruned = cache.prune(
      folders,
      files.map((f) => f.path),
    )
    const {bytesHashed, fromCache, groups, hashed} = await findDuplicates(files, {
      cache,
      rehash: flags.rehash,
      onHash: (file, n, total, cached) =>
        this.log(
          chalk.gray(
            `  [${n}/${total}] ${cached ? 'cached ' : 'hashing'} ${path.relative(root, file.path)}` +
              (cached ? '' : ` (${formatBytes(file.size)})`),
          ),
        ),
    })

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
      ['Folders scanned', folders.length],
      ['.safetensors files', files.length],
      ['Hashed', `${hashed}, ${formatBytes(bytesHashed)}`],
      ['From the hash cache', fromCache],
      ['Not hashed', `${files.length - hashed - fromCache} (a size no other file has)`],
      ['Duplicate groups', groups.length],
      ['Space in extra copies', formatBytes(wasted)],
      ['Time', `${((Date.now() - started) / 1000).toFixed(1)} s`],
      ['Hash cache', cache.file + (pruned > 0 ? ` (${pruned} missing file(s) removed from it)` : '')],
    ]
    this.log(chalk.cyan('Summary'))
    for (const [label, value] of summary) this.log(`  ${`${label}:`.padEnd(23)}${value}`)

    if (groups.length > 0 && !flags.list) await this.chooseCopies(groups)
  }

  /**
   * Asks for each group which copy to keep and deletes the others with their files at once. Enter skips a
   * group; q or the end of input stops, leaving the remaining groups as they are.
   */
  async chooseCopies(groups) {
    this.log(
      `\nChoose the copy to keep in each group; the others are deleted for good, with the files named after them.`,
    )
    this.log(
      chalk.gray('+c: a .json config with the same name is next to it   +p: a preview image (.png, .preview.png…)'),
    )

    const reader = lineReader()
    const listings = new Map()
    const deleted = []
    const failed = []
    let freed = 0
    try {
      for (const [g, group] of groups.entries()) {
        const copies = copiesWithFiles(
          group.files.map((f) => f.path),
          listings,
        )
        const name = group.files.map((f) => civitaiNameOf(f.path)).find(Boolean)
        this.log(
          `\n${chalk.bold(`Duplicate ${g + 1} of ${groups.length}: ${path.basename(group.files[0].path)}`)}` +
            (name ? chalk.gray(`  (Civitai: ${name})`) : '') +
            `, ${formatBytes(group.size)} each`,
        )
        for (const [i, copy] of copies.entries()) this.log(`  ${i + 1}) ${copy.path}${companionNote(copy)}`)

        let answer = null
        while (answer === null) {
          // eslint-disable-next-line no-await-in-loop
          const line = await reader.ask(`Keep which one? [1-${copies.length}, Enter = skip, q = stop] `)
          if (line === null) {
            answer = 'stop'
            this.log('')
          } else {
            answer = parseKeepAnswer(line, copies.length)
            if (answer === null) this.log(`  Type a number from 1 to ${copies.length}, Enter to skip or q to stop.`)
          }
        }

        if (answer === 'stop') {
          this.log(`Stopped; ${groups.length - g} group(s) left as they are.`)
          break
        }

        if (answer === 'skip') {
          this.log(chalk.gray('  skipped'))
          continue
        }

        for (const file of filesToDelete(copies, answer)) {
          // that folder's listing changes, so it is read again when a later group is in it
          listings.delete(path.dirname(file))
          try {
            const {size} = fs.statSync(file)
            fs.unlinkSync(file)
            freed += size
            deleted.push(file)
            this.log(chalk.gray(`  deleted ${file}`))
          } catch (error) {
            failed.push(file)
            this.log(chalk.red(`  could not delete ${file}: ${error.message}`))
          }
        }
      }
    } finally {
      reader.close()
    }

    this.log(`\nDeleted ${deleted.length} file(s), ${formatBytes(freed)} freed.`)
    if (failed.length > 0) this.log(chalk.red(`${failed.length} file(s) could not be deleted (see above).`))

    // lora activation's loras.yaml lists the LoRAs of its folder, so it may still name a deleted copy
    const stale = [
      ...new Set(
        deleted.filter((file) => file.toLowerCase().endsWith('.safetensors')).map((file) => path.dirname(file)),
      ),
    ].filter((folder) => fs.existsSync(path.join(folder, 'loras.yaml')))
    if (stale.length > 0) {
      this.log('These folders have a loras.yaml that may still list a deleted copy; run lora activation there again:')
      for (const folder of stale) this.log(`  ${folder}`)
    }
  }
}
