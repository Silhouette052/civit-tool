import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const CONFIG_FILENAME = 'civit-tool.config.json'

/** Characters `activation` warns about in LoRA file names (and offers to remove). */
export const DEFAULT_WARN_CHARS = '@&'

/** The wildcard list `activation` writes next to the LoRAs. */
export const DEFAULT_YAML_NAME = 'loras.yaml'

export const homeConfigPath = (home = os.homedir()) => path.join(home, `.${CONFIG_FILENAME}`)

/**
 * Where `wc lint` looks for danbooru.csv when no folder is set: the data folder in civit-tool's own folder.
 * CIVIT_TOOL_DATA_DIR overrides it (the tests use that).
 */
export const defaultDataDir = () =>
  process.env.CIVIT_TOOL_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data')

function readJsonIfExists(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Loads config with precedence: ./civit-tool.config.json > ~/.civit-tool.config.json > defaults.
 * CLI flags (handled per-command) always win over any of this.
 */
export function loadConfig() {
  const defaults = {
    domain: 'civitai.red',
    warnChars: DEFAULT_WARN_CHARS,
    wildcardsDir: null,
  }

  const home = loadHomeConfig()
  const local = loadLocalConfig()
  const config = {...defaults, ...home, ...local}
  // sections (lint, activation) are merged key by key, and lint's rule switches rule by rule, so a local section
  // doesn't hide what the home file sets
  const isSection = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  for (const key of Object.keys(local)) {
    if (isSection(home[key]) && isSection(local[key])) config[key] = {...home[key], ...local[key]}
  }

  if (isSection(home.lint?.rules) && isSection(local.lint?.rules)) {
    config.lint.rules = {...home.lint.rules, ...local.lint.rules}
  }

  return config
}

/** The home config (~/.civit-tool.config.json) alone. */
export function loadHomeConfig(home = os.homedir()) {
  return readJsonIfExists(homeConfigPath(home)) || {}
}

/** The project config (./civit-tool.config.json) alone, which overrides the home config. */
export function loadLocalConfig(cwd = process.cwd()) {
  return readJsonIfExists(path.join(cwd, CONFIG_FILENAME)) || {}
}

/**
 * Saves one setting in the home config (~/.civit-tool.config.json), keeping the others. `undefined`
 * removes it, so the default applies again. Returns the file path. Refuses to touch a file that isn't
 * valid JSON, so a hand-edited config is never lost.
 */
export function saveHomeSetting(key, value, home = os.homedir()) {
  return saveHomeSettings({[key]: value}, home)
}

/**
 * Saves several settings in the home config at once, as saveHomeSetting does one. A dotted key such as
 * `lint.dataDir` sets a value inside a section; removing the last value of a section removes the section.
 */
export function saveHomeSettings(changes, home = os.homedir()) {
  const file = homeConfigPath(home)
  const config = readJsonIfExists(file)
  if (config === null && fs.existsSync(file)) throw new Error(`${file} is not valid JSON; fix it by hand first`)
  fs.writeFileSync(file, JSON.stringify(applySettings(config ?? {}, changes), null, 2) + '\n', 'utf8')
  return file
}

/** A copy of `config` with `changes` made, the way saveHomeSettings saves them. */
export function applySettings(config, changes) {
  const out = structuredClone(config)
  for (const [key, value] of Object.entries(changes)) {
    const [section, name] = key.includes('.') ? key.split('.', 2) : [null, key]
    if (section === null) {
      if (value === undefined) delete out[key]
      else out[key] = value
      continue
    }

    const parent = typeof out[section] === 'object' && out[section] !== null ? out[section] : {}
    if (value === undefined) delete parent[name]
    else parent[name] = value
    if (Object.keys(parent).length > 0) out[section] = parent
    else delete out[section]
  }

  return out
}
