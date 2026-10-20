import {Args, Command, Flags} from '@oclif/core'
import path from 'node:path'

import {
  apiBaseFor,
  buildModelUrl,
  domainOrder,
  fetchModelById,
  fetchModelVersionByHash,
  fetchModelVersionById,
  withDomainFallback,
} from '../../lib/civitaiClient.js'
import {loadConfig} from '../../lib/config.js'
import {openHashCache} from '../../lib/hashCache.js'
import {findSafetensorFiles, getCivitaiIdsFromMetadata, readSafetensorMetadata} from '../../lib/safetensors.js'

/**
 * The Civitai page of a LoRA: {creator, domain, modelId, modelName, versionId}, or null when none of
 * `domains` knows it. Each domain is tried in turn; the file is hashed once, and only when it has no
 * embedded ID. The hash comes from `cache` while the file is unchanged.
 */
async function resolveCivitaiInfo(filepath, domains, cache) {
  let metadata = {}

  try {
    metadata = readSafetensorMetadata(filepath)
  } catch {
    // fall through to hash lookup below
  }

  const ids = getCivitaiIdsFromMetadata(metadata)
  const hash = ids?.modelId || ids?.modelVersionId ? null : await cache.sha256(filepath)

  try {
    const {domain, value} = await withDomainFallback(domains, async (domain) => {
      const apiBase = apiBaseFor(domain)
      let modelId = ids?.modelId ?? null
      let versionId = ids?.modelVersionId ?? null

      if (hash !== null) {
        const version = await fetchModelVersionByHash(hash, {apiBase})
        if (!version?.modelId) throw new Error('no model for this hash')
        modelId = version.modelId
        versionId = version.id ?? null
      } else if (!modelId) {
        const version = await fetchModelVersionById(versionId, {apiBase})
        if (!version?.modelId) throw new Error('no model for this version')
        modelId = version.modelId
      }

      const model = await fetchModelById(modelId, {apiBase})
      return {creator: model.creator ?? null, modelId, modelName: model.name ?? null, versionId}
    })

    return {...value, domain}
  } catch {
    return null
  }
}

export default class Url extends Command {
  static description = 'Look up the Civitai page for every .safetensors file in a folder.'

  static examples = [
    '<%= config.bin %> lora url ./loras',
    '<%= config.bin %> lora url ./loras --group-by-author',
    '<%= config.bin %> lora url ./loras --no-recursive --domain civitai.com',
  ]

  static args = {
    path: Args.string({description: 'Folder to scan.', required: true}),
  }

  static flags = {
    domain: Flags.string({
      description:
        'Civitai domain to look LoRAs up on first (default civitai.red). A LoRA it doesn\'t know is looked up on the other one; each link points to the domain that had it.',
    }),
    'group-by-author': Flags.boolean({default: false, description: 'Group results by Civitai username.'}),
    recursive: Flags.boolean({allowNo: true, default: true, description: 'Scan subfolders.'}),
  }

  async run() {
    const {args, flags} = await this.parse(Url)
    const config = loadConfig()
    // civitai.red first by default; a LoRA it doesn't know is looked up on civitai.com
    const domains = domainOrder(flags.domain ?? config.domain)

    const folderPath = path.resolve(args.path)
    const files = findSafetensorFiles(folderPath, {recursive: flags.recursive})

    if (files.length === 0) {
      this.log('No .safetensors files found.')
      return
    }

    this.log(`Found ${files.length} file(s). Looking up Civitai URLs...\n`)

    const results = []
    const cache = openHashCache(undefined, (message) => this.warn(message))

    for (const filepath of files) {
      const relativePath = path.relative(folderPath, filepath)
      process.stdout.write(`Scanning: ${relativePath} ... `)

      // eslint-disable-next-line no-await-in-loop
      const info = await resolveCivitaiInfo(filepath, domains, cache)

      if (info) {
        const url = buildModelUrl({displayDomain: info.domain, modelId: info.modelId, versionId: info.versionId})
        const username = info.creator?.username ?? 'Unknown author'
        this.log(`${username} | ${info.modelName ?? 'Unknown model'}`)
        results.push({modelName: info.modelName ?? 'Unknown model', relativePath, url, username})
      } else {
        this.log('Not found')
        results.push({modelName: 'Not found', relativePath, url: 'Not found', username: 'Not found'})
      }
    }

    if (flags['group-by-author']) {
      this.printGroupedByAuthor(results)
    } else {
      this.printFlatSummary(results)
    }
  }

  printFlatSummary(results) {
    this.log(`\n${'='.repeat(80)}`)
    this.log('RESULTS SUMMARY')
    this.log('='.repeat(80))

    const maxNameLen = Math.max(...results.map((r) => r.relativePath.length))

    for (const {relativePath, url} of results) {
      this.log(`${relativePath.padEnd(maxNameLen + 2)} --> ${url}`)
    }
  }

  printGroupedByAuthor(results) {
    const grouped = new Map()

    for (const result of results) {
      if (!grouped.has(result.username)) grouped.set(result.username, [])
      grouped.get(result.username).push(result)
    }

    const sortedGroups = [...grouped.entries()].sort(([a], [b]) =>
      a.localeCompare(b, undefined, {sensitivity: 'base'}),
    )

    this.log(`\n${'='.repeat(100)}`)
    this.log('RESULTS GROUPED BY AUTHOR')
    this.log('='.repeat(100))

    for (const [author, files] of sortedGroups) {
      this.log(`\n${author}`)
      this.log('-'.repeat(author.length))

      for (const result of files) {
        this.log(`  ${result.relativePath}`)
        this.log(`    Model: ${result.modelName}`)
        this.log(`    URL:   ${result.url}`)
      }
    }

    this.log(`\n${'='.repeat(100)}`)
    this.log('SUMMARY')
    this.log('='.repeat(100))
    this.log(`Files scanned: ${results.length}`)

    for (const [author, files] of sortedGroups) {
      this.log(`  ${author}: ${files.length}`)
    }
  }
}
