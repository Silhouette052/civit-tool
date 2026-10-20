import {Config} from '@oclif/core'
import assert from 'node:assert/strict'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

// Every command lives in a group (`civit-tool <group> <command>`, like `aws s3 cp`). A new feature
// goes into one of these groups, or adds a new one here and to "oclif.topics" in package.json.
const GROUPS = ['file', 'img', 'lora', 'wc']

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const config = await Config.load(root)
// the help and autocomplete plugins add their own commands
const own = config.commands.filter((command) => command.pluginName === config.pjson.name)

test('every command sits in a known group, and every group has a description', () => {
  assert.deepEqual(own.map((command) => command.id).sort(), [
    'file:rename',
    'img:loras',
    'img:meta',
    'img:sort',
    'lora:activation',
    'lora:duplicates',
    'lora:url',
    'wc:expand',
    'wc:lint',
    'wc:repeats',
    'wc:sort',
  ])
  for (const command of own) assert.ok(GROUPS.includes(command.id.split(':')[0]), command.id)
  for (const group of GROUPS) assert.ok(config.topics.find((topic) => topic.name === group)?.description, group)
})

test('no command answers to a top-level name', () => {
  for (const command of own) {
    assert.deepEqual([...command.aliases, ...(command.hiddenAliases ?? [])], [], command.id)
  }
})
