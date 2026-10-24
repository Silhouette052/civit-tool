import {Args, Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {defaultDataDir, loadConfig, loadHomeConfig, loadLocalConfig, saveHomeSettings} from '../../lib/config.js'
import {formatUnknownTags, loraTagIndex, placesOf, rowText, tagWidth, unknownTags} from '../../lib/lint/calibrate.js'
import {
  applyFixes,
  formatJson,
  formatText,
  lintFiles,
  loadLintConfig,
  makeLintConfig,
  mergeAccepted,
  parseIgnoreArg,
  validateAcceptedTags,
} from '../../lib/lint/index.js'
import {checkFolder} from '../../lib/settings.js'
import {loadTagIndex} from '../../lib/tag-index/index.js'
import {runPicker} from '../../lib/terminalMenu.js'
import {parseWildcardFile} from '../../lib/wildcard-parser/index.js'
import {findYamlFiles} from '../../lib/wildcards.js'

function noDanbooruCsv(dir) {
  const folder = path.resolve(dir)
  const where = folder === path.resolve(defaultDataDir()) ? `civit-tool's data folder, ${folder}` : folder
  return `No danbooru.csv in ${where}. lint checks every tag against it: copy danbooru.csv there from Forge's Tag Autocomplete extension (extensions/a1111-sd-webui-tagcomplete/tags), or point lint at the folder that holds it with: civit-tool wc config --data-dir <folder>`
}

export default class Lint extends Command {
  static description = `Check wildcard YAML files: tags against Danbooru (unknown, rare, aliases, escaping) and structure (braces, __references__, ranges, duplicates, LoRA base models). Exit code 1 means findings. Turn rules on or off, set the danbooru.csv folder, skip keys, or accept tags that aren't Danbooru tags (such as LoRA activation tags, gathered from their sidecars) with wc config. --calibrate lists the unknown tags and lets you pick which to accept.`

  static examples = [
    '<%= config.bin %> wc lint ./wildcards',
    '<%= config.bin %> wc lint loras.yaml characters.yaml',
    '<%= config.bin %> wc lint ./wildcards --fix',
    '<%= config.bin %> wc lint ./wildcards --ignore "my-lib/custom/**:S-branch,S-dup"',
    '<%= config.bin %> wc lint ./wildcards --json > findings.json',
    '<%= config.bin %> wc lint ./wildcards --calibrate --loras "D:/Forge/models/Lora" --recursive',
  ]

  static args = {
    path: Args.string({
      description:
        'Wildcard YAML files or folders, linted together as one library (references resolve across all of them). Default: the "wildcardsDir" folder from civit-tool.config.json.',
    }),
  }

  static flags = {
    // no default: --loras depends on it, and oclif counts a default as given
    calibrate: Flags.boolean({
      description:
        "List the unknown tags (R1) and pick, in a terminal, which ones to accept: lint then doesn't check them against Danbooru. Tags of a LoRA in --loras (or lint.loraDirs) are picked already. Without a terminal, the list is printed.",
      exclusive: ['fix', 'json'],
    }),
    config: Flags.string({
      description:
        'A JSON config file whose "lint" section to use (e.g. the config file of another project). Default: the "lint" section of civit-tool.config.json. Its accepted tags are used as well.',
    }),
    'data-dir': Flags.string({
      description:
        'Folder holding danbooru.csv (and the optional aliases.local.csv). Default: "lint.dataDir" from the config (set it with wc config --data-dir), else civit-tool\'s data folder.',
    }),
    fix: Flags.boolean({
      default: false,
      description: 'Apply the safe fixes (aliases to canonical tags, escaping) in place, then report what is left.',
    }),
    ignore: Flags.string({
      description: 'Skip findings under a key-path glob, for some rules or all: <path-glob>[:RULE,RULE…]. Repeatable.',
      multiple: true,
    }),
    json: Flags.boolean({default: false, description: 'Print the findings as JSON.'}),
    loras: Flags.string({
      dependsOn: ['calibrate'],
      description:
        'With --calibrate: a folder of LoRAs whose sidecars mark the unknown tags that are activation tags. Default: the lint.loraDirs folders.',
    }),
    recursive: Flags.boolean({
      dependsOn: ['loras'],
      description: 'With --loras: read the sidecars in its subfolders too.',
    }),
  }

  static strict = false // several paths

  async run() {
    const {argv, flags} = await this.parse(Lint)
    if (flags.calibrate) return this.calibrate(argv, flags)

    let result
    try {
      ;({result} = this.lint(argv, flags))
    } catch (error) {
      // missing files, a malformed danbooru.csv or config, an unknown rule in --ignore: exit 2, like wl
      this.error(error.message, {exit: 2})
    }

    this.log(flags.json ? formatJson(result) : formatText(result))
    // not this.exit(): it ends the process before a large report has been written to a pipe
    if (result.findings.length > 0) process.exitCode = 1
  }

  lint(argv, flags) {
    const civitConfig = loadConfig()
    let config
    if (flags.config) {
      const configPath = path.resolve(flags.config)
      if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`)
      config = loadLintConfig(configPath)
      // accepted tags are the user's LoRAs, whichever project's config is used: civit-tool's own list applies too
      const own = civitConfig.lint?.acceptedTags ?? []
      validateAcceptedTags(own, 'civit-tool.config.json')
      config.acceptedTags = mergeAccepted(config.acceptedTags, own)
    } else {
      config = makeLintConfig(civitConfig.lint, 'civit-tool.config.json')
    }

    config.ignore = [...config.ignore, ...(flags.ignore ?? []).map((arg) => parseIgnoreArg(arg))]

    const dataDir = flags['data-dir'] ?? config.dataDir ?? civitConfig.lint?.dataDir ?? defaultDataDir()
    if (!fs.existsSync(path.join(dataDir, 'danbooru.csv'))) throw new Error(noDanbooruCsv(dataDir))

    const given = argv.length > 0 ? argv : civitConfig.wildcardsDir ? [civitConfig.wildcardsDir] : []
    if (given.length === 0) {
      throw new Error('Name the wildcard files or folders to lint, or set "wildcardsDir" in civit-tool.config.json.')
    }

    const paths = given.flatMap((p) => findYamlFiles(p, civitConfig.wildcardsDir))
    const index = loadTagIndex({dataDir, minCount: config.minCount})
    const read = (file) =>
      parseWildcardFile(fs.readFileSync(file, 'utf8'), {
        path: path.relative(process.cwd(), file) || file,
        branches: config.branches,
      })
    const lint = () =>
      lintFiles(
        paths.map((file) => read(file)),
        index,
        config,
      )

    let result = lint()
    if (flags.fix) {
      for (const file of paths) {
        const parsed = read(file)
        const {applied, output} = applyFixes(parsed, result.findings)
        if (output !== null) {
          fs.writeFileSync(file, output)
          this.logToStderr(`fixed ${applied} finding(s) in ${parsed.path}`)
        }
      }

      result = lint() // report what is left
    }

    return {config, result}
  }

  /**
   * --calibrate: the unknown tags (R1) as a list to pick from, the activation tags of the LoRAs in --loras (or
   * lint.loraDirs) picked already; the picked ones are saved as accepted tags, and lint runs again. Without a
   * terminal the list is printed and nothing is saved.
   */
  async calibrate(argv, flags) {
    let rows
    try {
      const {config, result} = this.lint(argv, {...flags, fix: false})
      if (config.rules?.R1 === false) {
        this.log('R1 (unknown tag) is off, so no tag is reported unknown.')
        return
      }

      const given = flags.loras === undefined ? null : checkFolder(flags.loras, process.cwd())
      const dirs = given ? [given] : config.loraDirs
      rows = unknownTags(result.findings, loraTagIndex(dirs, {recursive: given ? flags.recursive : true}))
    } catch (error) {
      this.error(error.message, {exit: 2})
    }

    if (rows.length === 0) {
      this.log('No unknown tags.')
      return
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this.log(formatUnknownTags(rows))
      return
    }

    if (loadLocalConfig().lint?.acceptedTags != null) {
      const where = './civit-tool.config.json sets lint.acceptedTags, which is used instead of the saved ones'
      this.error(`${where}; add the tags there.`, {exit: 2})
    }

    const width = tagWidth(rows)
    const items = rows.map((row) => ({
      help: `Used in ${placesOf(row)}`,
      selected: row.loras.length > 0,
      text: rowText(row, width),
    }))
    const count = `${rows.length} unknown ${rows.length === 1 ? 'tag' : 'tags'} (R1)`
    const heading = `${count}: pick the ones to accept. LoRA activation tags are picked already.`
    const picked = await runPicker(items, {heading})
    if (picked === null || picked.length === 0) {
      this.log('Nothing accepted.')
      return
    }

    const tags = picked.map((i) => rows[i].tag)
    const saved = loadHomeConfig().lint?.acceptedTags ?? []
    const file = saveHomeSettings({'lint.acceptedTags': mergeAccepted(saved, tags)})
    this.log(`Accepted ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}: ${tags.join(', ')}. Saved in ${file}.\n`)

    const {result} = this.lint(argv, {...flags, fix: false}) // what is left
    this.log(formatText(result))
    if (result.findings.length > 0) process.exitCode = 1
  }
}
