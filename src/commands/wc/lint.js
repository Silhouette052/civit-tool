import {Args, Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {loadConfig} from '../../lib/config.js'
import {
  applyFixes,
  formatJson,
  formatText,
  lintFiles,
  loadLintConfig,
  makeLintConfig,
  parseIgnoreArg,
} from '../../lib/lint/index.js'
import {loadTagIndex} from '../../lib/tag-index/index.js'
import {parseWildcardFile} from '../../lib/wildcard-parser/index.js'
import {findYamlFiles} from '../../lib/wildcards.js'

const NO_DATA_DIR = `lint checks every tag against danbooru.csv, so it needs the folder that holds it. Set it once in civit-tool.config.json:
  {"lint": {"dataDir": "path/to/forge/extensions/a1111-sd-webui-tagcomplete/tags"}}
or pass --data-dir. Forge's Tag Autocomplete extension ships a danbooru.csv in its "tags" folder.`

export default class Lint extends Command {
  static description = `Check wildcard YAML files: tags against Danbooru (unknown, rare, aliases, escaping) and structure (braces, __references__, ranges, duplicates, LoRA base models). Exit code 1 means findings.`

  static examples = [
    '<%= config.bin %> wc lint ./wildcards',
    '<%= config.bin %> wc lint loras.yaml characters.yaml',
    '<%= config.bin %> wc lint ./wildcards --fix',
    '<%= config.bin %> wc lint ./wildcards --ignore "my-lib/custom/**:S-branch,S-dup"',
    '<%= config.bin %> wc lint ./wildcards --json > findings.json',
  ]

  static args = {
    path: Args.string({
      description:
        'Wildcard YAML files or folders, linted together as one library (references resolve across all of them). Default: the "wildcardsDir" folder from civit-tool.config.json.',
    }),
  }

  static flags = {
    config: Flags.string({
      description:
        'A JSON config file whose "lint" section to use (e.g. the config file of another project). Default: the "lint" section of civit-tool.config.json.',
    }),
    'data-dir': Flags.string({
      description:
        'Folder holding danbooru.csv (and the optional aliases.local.csv). Default: "lint.dataDir" from the config.',
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
  }

  static strict = false // several paths

  async run() {
    const {argv, flags} = await this.parse(Lint)

    let result
    try {
      result = this.lint(argv, flags)
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
    } else {
      config = makeLintConfig(civitConfig.lint, 'civit-tool.config.json')
    }

    config.ignore = [...config.ignore, ...(flags.ignore ?? []).map((arg) => parseIgnoreArg(arg))]

    const dataDir = flags['data-dir'] ?? config.dataDir ?? civitConfig.lint?.dataDir
    if (!dataDir) throw new Error(NO_DATA_DIR)
    if (!fs.existsSync(path.join(dataDir, 'danbooru.csv'))) {
      throw new Error(`No danbooru.csv in ${path.resolve(dataDir)}\n\n${NO_DATA_DIR}`)
    }

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

    return result
  }
}
