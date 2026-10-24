// lora config: the LoRA settings it saves, how lora activation reads them, and its keyboard menu.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {LORA_SETTINGS, loraConfigMenu} from '../commands/lora/config.js'
import {activationOptions} from '../commands/lora/activation.js'
import {homeConfigPath, loadConfig} from '../lib/config.js'
import {changesFromFlags} from '../lib/settings.js'
import {fakeTerminal, KEYS} from './fake-terminal.js'

function tempDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civit-lora-config-')))
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const changes = (flags) => changesFromFlags(LORA_SETTINGS, flags)

test('lora config flags: values are checked, and a value equal to the default removes the setting', () => {
  assert.deepEqual(changes({domain: 'civitai.com', 'sort-base': 'off', 'warn-chars': '@&@#', 'yaml-name': 'my.yaml'}), {
    domain: 'civitai.com',
    'activation.sortBaseModels': false,
    warnChars: '@&#',
    'activation.yamlName': 'my.yaml',
  })
  assert.deepEqual(changes({domain: 'civitai.red', 'sort-base': 'on', 'warn-chars': '&@', 'yaml-name': 'loras.yaml'}), {
    domain: undefined,
    'activation.sortBaseModels': undefined,
    warnChars: '&@',
    'activation.yamlName': undefined,
  })
  // "none" (or nothing) turns the name warning off
  assert.deepEqual(changes({'warn-chars': 'none'}), {warnChars: ''})
  assert.deepEqual(changes({'warn-chars': ''}), {warnChars: ''})
  assert.deepEqual(changes({reset: ['warn-chars', 'yaml-name']}), {
    warnChars: undefined,
    'activation.yamlName': undefined,
  })

  assert.throws(() => changes({'warn-chars': '@ &'}), /can't include spaces/)
  assert.throws(() => changes({'yaml-name': 'sub/loras.yaml'}), /plain file name ending in \.yaml or \.yml/)
  assert.throws(() => changes({'yaml-name': 'loras.txt'}), /plain file name ending in \.yaml or \.yml/)
  assert.throws(() => changes({'sort-base': 'maybe'}), /Base model sort must be on or off/)
  assert.throws(() => changes({domain: 'example.com'}), /Civitai site must be one of: civitai\.red, civitai\.com/)
  assert.throws(() => changes({domain: 'civitai.com', reset: ['domain']}), /together/)
})

test('activation takes a flag first, then what lora config saved, then the default', () => {
  assert.deepEqual(activationOptions({}, {}), {sortBase: true, warnChars: '@&', yamlName: 'loras.yaml'})
  const saved = {activation: {sortBaseModels: false, yamlName: 'saved.yaml'}, warnChars: ''}
  assert.deepEqual(activationOptions({}, saved), {sortBase: false, warnChars: '', yamlName: 'saved.yaml'})
  assert.deepEqual(activationOptions({'skip-sort-base': true, 'yaml-name': 'flag.yaml'}, {}), {
    sortBase: false,
    warnChars: '@&',
    yamlName: 'flag.yaml',
  })
})

test('loadConfig merges a local section into the home one, key by key', () => {
  const dir = tempDir()
  const env = {cwd: process.cwd(), HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE}
  try {
    fs.writeFileSync(
      homeConfigPath(dir),
      JSON.stringify({activation: {sortBaseModels: false, yamlName: 'home.yaml'}, lint: {rules: {R1: false}}}),
    )
    fs.mkdirSync(path.join(dir, 'work'))
    fs.writeFileSync(
      path.join(dir, 'work', 'civit-tool.config.json'),
      JSON.stringify({activation: {yamlName: 'local.yaml'}, lint: {minCount: 10, rules: {R2: false}}}),
    )
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    process.chdir(path.join(dir, 'work'))
    const config = loadConfig()
    assert.deepEqual(config.activation, {sortBaseModels: false, yamlName: 'local.yaml'})
    assert.deepEqual(config.lint, {minCount: 10, rules: {R1: false, R2: false}})
    assert.equal('folder' in config, false)
  } finally {
    process.chdir(env.cwd)
    for (const key of ['HOME', 'USERPROFILE']) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }

    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('the lora config menu: Enter cycles a choice, switches on/off, asks for text; the API key is only shown', async () => {
  const dir = tempDir()
  try {
    const home = path.join(dir, 'home')
    fs.mkdirSync(home)
    const term = fakeTerminal({columns: 200})
    const last = () => term.frames().at(-1)
    const done = loraConfigMenu({cwd: dir, home, input: term.input, output: term.output})

    assert.match(last(), /› Civitai site {5}civitai\.red {2}\(default\)\n {2}Warn characters {2}@& {2}\(default\)\n/)
    assert.match(last(), /\n {2}Civitai API key {2}(not )?set {2}\(the CIVITAI_API_TOKEN environment variable\)\n/)
    assert.match(last(), /\n↑\/↓ move {3}Enter next choice {3}r default {3}q quit\n$/)

    await term.press(KEYS.enter)
    assert.match(last(), /› Civitai site {5}civitai\.com {2}\(saved\)\n.*\nSaved: civitai site civitai\.com\.\n$/s)
    await term.press(KEYS.enter)
    assert.match(last(), /› Civitai site {5}civitai\.red {2}\(default\)\n/)

    await term.press(KEYS.down, KEYS.enter, '#@#', KEYS.enter)
    assert.match(last(), /› Warn characters {2}#@ {2}\(saved\)\n/)
    await term.press(KEYS.down, KEYS.enter)
    assert.match(last(), /› Base model sort {2}off {2}\(saved\)\n.*\nSaved: base model sort off\.\n$/s)
    // the API key row can't be chosen, so the cursor stays on the last setting
    await term.press(KEYS.down, KEYS.down, KEYS.enter, 'list.txt', KEYS.enter)
    assert.match(
      last(),
      /› LoRA list file {3}loras\.yaml {2}\(default\)\n.*\nThe LoRA list file needs a plain file name/s,
    )
    await term.press('r', 'q')
    await done

    assert.deepEqual(readJson(homeConfigPath(home)), {warnChars: '#@', activation: {sortBaseModels: false}})
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
