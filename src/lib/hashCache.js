// SHA-256 hashes, cached so an unchanged file is never read twice (lora duplicates, activation and url).
//
// The cache is one JSON file in civit-tool's own folder (.cache/hashes.json, git-ignored), keyed by each file's
// real path (links and junctions resolved): {"D:\\Models\\Lora\\x.safetensors": {size, mtimeMs, sha256}}. A cached
// hash is used only while the file's size and modify time are unchanged. Each new hash is saved at once, to a temp
// file that then replaces the cache, so an interrupted run keeps what it hashed and a half-written cache can't happen.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {sha256} from './hash.js'

/** .cache/hashes.json in civit-tool's own folder; CIVIT_TOOL_HASH_CACHE overrides it (the tests use that). */
export const hashCacheFile = () =>
  process.env.CIVIT_TOOL_HASH_CACHE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cache/hashes.json')

/** The cache key: the real path, so a file reached through a link or junction is the same entry. */
function keyOf(file) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

/** One line per file, so the cache stays readable. */
const serialize = (entries) =>
  `{\n${Object.entries(entries)
    .map(([key, entry]) => `  ${JSON.stringify(key)}: ${JSON.stringify(entry)}`)
    .join(',\n')}\n}\n`

/**
 * Opens the hash cache in `file`, or an in-memory one when `file` is null. A missing file is an empty cache; an
 * unreadable one is reported to `warn` and replaced on the next save. A failed save is reported once, and the
 * hashes still work for the rest of the run.
 */
export function openHashCache(file = hashCacheFile(), warn = () => {}) {
  let entries = {}
  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && typeof data === 'object' && !Array.isArray(data)) entries = data
      else warn(`The hash cache ${file} is not a JSON object; starting a new one.`)
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`Cannot read the hash cache ${file} (${error.message}); starting a new one.`)
    }
  }

  let saveFailed = false
  const save = () => {
    if (!file || saveFailed) return
    const temp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(temp, serialize(entries), 'utf8')
      fs.renameSync(temp, file)
    } catch (error) {
      saveFailed = true
      warn(`Cannot save the hash cache ${file} (${error.message}); this run's hashes won't be kept.`)
      try {
        fs.rmSync(temp, {force: true})
      } catch {
        // the temp file was never created
      }
    }
  }

  /** The cached hash of `filepath`, or null when it isn't cached or the file's size or modify time changed. */
  const lookup = (filepath) => {
    const entry = entries[keyOf(filepath)]
    if (!entry) return null
    try {
      const {mtimeMs, size} = fs.statSync(filepath)
      return entry.size === size && entry.mtimeMs === mtimeMs ? entry.sha256 : null
    } catch {
      return null
    }
  }

  /** Hashes `filepath` (always reading it), then caches and saves the hash. */
  const hash = async (filepath) => {
    // stat first: a file changed while it is read keeps the older modify time, so the next run hashes it again
    const {mtimeMs, size} = fs.statSync(filepath)
    const sha = await sha256(filepath)
    entries[keyOf(filepath)] = {size, mtimeMs, sha256: sha}
    save()
    return sha
  }

  /**
   * Removes the entries inside the scanned `folders` (real paths, subfolders included) whose file is not among
   * `files`: files that were deleted, moved or renamed. Entries elsewhere are kept. Returns how many were removed.
   */
  const prune = (folders, files) => {
    const scanned = new Set(folders)
    const found = new Set(files.map(keyOf))
    const insideScanned = (key) => {
      let dir = path.dirname(key)
      while (!scanned.has(dir)) {
        const parent = path.dirname(dir)
        if (parent === dir) return false
        dir = parent
      }
      return true
    }

    const stale = Object.keys(entries).filter((key) => !found.has(key) && insideScanned(key))
    for (const key of stale) delete entries[key]
    if (stale.length > 0) save()
    return stale.length
  }

  return {
    file,
    hash,
    lookup,
    prune,
    /** The SHA-256 of `filepath`: the cached one while the file is unchanged, else hashed now (and cached). */
    sha256: async (filepath) => lookup(filepath) ?? hash(filepath),
  }
}
