import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILENAME = 'civit-tool.config.json'

/** Characters `activation` warns about in LoRA file names (and offers to remove). */
export const DEFAULT_WARN_CHARS = '@&'

export const homeConfigPath = (home = os.homedir()) => path.join(home, `.${CONFIG_FILENAME}`)

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
    folder: null,
    warnChars: DEFAULT_WARN_CHARS,
    wildcardsDir: null,
  }

  const home = readJsonIfExists(homeConfigPath()) || {}
  return {...defaults, ...home, ...loadLocalConfig()}
}

/** The project config (./civit-tool.config.json) alone, which overrides the home config. */
export function loadLocalConfig() {
  return readJsonIfExists(path.join(process.cwd(), CONFIG_FILENAME)) || {}
}

/**
 * Saves one setting in the home config (~/.civit-tool.config.json), keeping the others. `undefined`
 * removes it, so the default applies again. Returns the file path. Refuses to touch a file that isn't
 * valid JSON, so a hand-edited config is never lost.
 */
export function saveHomeSetting(key, value, home = os.homedir()) {
  const file = homeConfigPath(home)
  let config = readJsonIfExists(file)
  if (config === null && fs.existsSync(file)) throw new Error(`${file} is not valid JSON; fix it by hand first`)
  config ??= {}
  if (value === undefined) delete config[key]
  else config[key] = value
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return file
}
