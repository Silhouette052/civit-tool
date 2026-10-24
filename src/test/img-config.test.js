// img config: Forge's filename pattern and ascending number, saved for img sort, with an example file name.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {formatImgSettings, IMG_SETTINGS, imgConfigMenu} from '../commands/img/config.js'
import {homeConfigPath} from '../lib/config.js'
import {changesFromFlags} from '../lib/settings.js'
import {fakeTerminal, KEYS} from './fake-terminal.js'

const changes = (flags) => changesFromFlags(IMG_SETTINGS, flags)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('img config flags: the pattern is checked, and a value equal to the default removes the setting', () => {
  assert.deepEqual(changes({'add-number': 'on', pattern: '"[model_name]-[seed]"'}), {
    'img.addNumber': true,
    'img.filenamePattern': '[model_name]-[seed]',
  })
  assert.deepEqual(changes({'add-number': 'off', pattern: '[seed]_[denoising]_[model_name]_[datetime]'}), {
    'img.addNumber': undefined,
    'img.filenamePattern': undefined,
  })
  assert.deepEqual(changes({reset: ['pattern', 'add-number']}), {
    'img.addNumber': undefined,
    'img.filenamePattern': undefined,
  })
  assert.throws(() => changes({pattern: '[seed]_[datetime]'}), /needs \[model_name\]/)
  assert.throws(() => changes({'add-number': 'maybe'}), /Ascending number must be on or off/)
})

test('the listing ends with an example name for the settings in use, the local config first', () => {
  const listing = formatImgSettings({img: {addNumber: true}}, {img: {filenamePattern: '[model_name]-[seed]'}})
  assert.match(listing, /^Filename pattern {2}\[model_name\]-\[seed\] {2}\(set in \.\/civit-tool\.config\.json\)\n/)
  assert.match(listing, /\nAscending number {2}on {2}\(saved\)\n/)
  assert.match(listing, /\nExample {11}00042-waiANIMA_v10Base10-2447751738\.png {2}\(what img sort looks for\)\n/)
  assert.match(formatImgSettings(), /\nExample {11}2447751738_0\.6_waiANIMA_v10Base10_20260929160902\.png /)
})

test('the img config menu: the example follows each change; a pattern without [model_name] is refused', async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civit-img-config-')))
  try {
    const term = fakeTerminal({columns: 200})
    const last = () => term.frames().at(-1)
    const done = imgConfigMenu({cwd: home, home, input: term.input, output: term.output})

    assert.match(last(), /› Filename pattern {2}\[seed\]_\[denoising\]_\[model_name\]_\[datetime\] {2}\(default\)\n/)
    await term.press(KEYS.enter, '[seed]_[datetime]', KEYS.enter)
    assert.match(last(), /\nThe filename pattern needs \[model_name\]: img sort makes one folder per model\.\n$/)
    await term.press(KEYS.enter, '[model_name]-[seed]', KEYS.enter, KEYS.down, KEYS.enter)
    assert.match(
      last(),
      /\n› Ascending number {2}on {2}\(saved\)\n.*\n {2}Example {11}00042-waiANIMA_v10Base10-2447751738\.png/s,
    )
    await term.press('q')
    await done

    assert.deepEqual(readJson(homeConfigPath(home)), {img: {addNumber: true, filenamePattern: '[model_name]-[seed]'}})
  } finally {
    fs.rmSync(home, {force: true, recursive: true})
  }
})
