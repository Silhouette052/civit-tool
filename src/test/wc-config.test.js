// wc config: the settings it saves (data folder, wildcards folder, lint rule switches, accepted tags), and how wc lint
// uses them.

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {configMenu, formatWcSettings, parseRuleList, settingChanges} from '../commands/wc/config.js'
import {homeConfigPath, saveHomeSettings} from '../lib/config.js'
import {applyFixes, formatText, lintFiles, makeLintConfig} from '../lib/lint/index.js'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'
import {fakeTerminal, KEYS} from './fake-terminal.js'
import {index, lintYaml, rules} from './lint-helpers.js'
import {REAL_CSV_ROWS} from './tag-index-fixture-rows.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')

function tempDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civit-wc-config-')))
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// an oclif error as one line: it wraps the message and starts each line with " ›"
const unwrap = (stderr) => stderr.replace(/ *\n ›\s+/g, ' ')

/** LoRA sidecars: two in `dir`, one in its anima subfolder. */
function writeSidecars(dir) {
  fs.mkdirSync(path.join(dir, 'anima'), {recursive: true})
  const write = (name, activation) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify({'activation text': activation, 'sd version': 'Anima'}))
  write('A.json', 'EdoEraAnime, long hair')
  write('B.json', 'b')
  write(path.join('anima', 'C.json'), 'cv4n14-style, EdoEraAnime, {2::pualdrons, gauntlets|1::bare arms}, {__x/y__|}')
}

/** Runs `body` with civit-tool's default data folder at `dir`, then puts it back. */
async function withDataDir(dir, body) {
  const saved = process.env.CIVIT_TOOL_DATA_DIR
  process.env.CIVIT_TOOL_DATA_DIR = dir
  try {
    await body()
  } finally {
    if (saved === undefined) delete process.env.CIVIT_TOOL_DATA_DIR
    else process.env.CIVIT_TOOL_DATA_DIR = saved
  }
}

test('saveHomeSettings sets values inside a section, and drops a section that ends up empty', () => {
  const home = tempDir()
  try {
    fs.writeFileSync(homeConfigPath(home), JSON.stringify({domain: 'civitai.red', lint: {loraDirs: ['L']}}))
    saveHomeSettings({'lint.dataDir': '/tags', 'lint.rules': {'S-branch': false}, wildcardsDir: '/wc'}, home)
    assert.deepEqual(readJson(homeConfigPath(home)), {
      domain: 'civitai.red',
      lint: {loraDirs: ['L'], dataDir: '/tags', rules: {'S-branch': false}},
      wildcardsDir: '/wc',
    })

    saveHomeSettings({'lint.dataDir': undefined, 'lint.rules': undefined, wildcardsDir: undefined}, home)
    assert.deepEqual(readJson(homeConfigPath(home)), {domain: 'civitai.red', lint: {loraDirs: ['L']}})
    saveHomeSettings({'lint.loraDirs': undefined}, home)
    assert.deepEqual(readJson(homeConfigPath(home)), {domain: 'civitai.red'})
  } finally {
    fs.rmSync(home, {force: true, recursive: true})
  }
})

test('settingChanges: folders are checked and saved absolute, rules switch, and bad requests save nothing', () => {
  const dir = tempDir()
  try {
    const tags = path.join(dir, 'tags')
    fs.mkdirSync(tags)
    fs.mkdirSync(path.join(dir, 'empty'))
    fs.writeFileSync(path.join(tags, 'danbooru.csv'), REAL_CSV_ROWS)

    assert.deepEqual(settingChanges({'data-dir': 'tags', 'wildcards-dir': 'empty'}, {}, dir), {
      'lint.dataDir': tags,
      wildcardsDir: path.join(dir, 'empty'),
    })
    assert.deepEqual(settingChanges({reset: ['data-dir', 'wildcards-dir', 'rules']}), {
      'lint.dataDir': undefined,
      wildcardsDir: undefined,
      'lint.rules': undefined,
    })

    // --on removes a switch (on is the default), --off writes false; names match in any case
    const home = {lint: {rules: {R2: false, 'S-branch': false}}}
    assert.deepEqual(settingChanges({on: ['s-branch'], off: ['P-neg,S-dup']}, home), {
      'lint.rules': {R2: false, 'P-neg': false, 'S-dup': false},
    })
    assert.deepEqual(settingChanges({on: ['R2,S-branch']}, home), {'lint.rules': undefined})
    assert.deepEqual(parseRuleList(['r1, R1', 'p-tags']), ['R1', 'P-tags'])

    // exempt keys: names separated by commas, without repeats; a path is refused, and nothing removes the setting
    assert.deepEqual(settingChanges({'exempt-keys': 'contender2_favs, *_favs,contender2_favs'}), {
      'lint.exemptKeys': ['contender2_favs', '*_favs'],
    })
    assert.deepEqual(settingChanges({'exempt-keys': ' '}), {'lint.exemptKeys': undefined})
    assert.throws(() => settingChanges({'exempt-keys': 'lib/contender2_favs'}), /"lib\/contender2_favs" is a path/)

    assert.throws(() => settingChanges({'data-dir': 'missing'}, {}, dir), /No such folder: .*missing/)
    assert.throws(() => settingChanges({'data-dir': 'empty'}, {}, dir), /No danbooru\.csv in .*empty/)
    assert.throws(() => settingChanges({'wildcards-dir': 'tags', reset: ['wildcards-dir']}, {}, dir), /together/)
    assert.throws(() => settingChanges({off: ['R9']}), /Unknown rule "R9"\. The rules are: R1, R2/)
    assert.throws(() => settingChanges({on: ['R1'], off: ['r1']}), /R1: turned both --on and --off/)
    assert.throws(() => settingChanges({off: ['R1'], reset: ['rules']}), /together/)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('settingChanges: accepted tags are added, removed and reset, and gathered from LoRA sidecars', async () => {
  const dir = tempDir()
  const empty = path.join(dir, 'empty')
  try {
    const tags = path.join(dir, 'tags')
    const loras = path.join(dir, 'loras')
    for (const folder of [tags, empty, loras]) fs.mkdirSync(folder)
    fs.writeFileSync(path.join(tags, 'danbooru.csv'), REAL_CSV_ROWS)
    writeSidecars(loras)
    const accepted = (flags, home = {}) => settingChanges(flags, home, dir)['lint.acceptedTags']

    assert.deepEqual(accepted({accept: ['b,EdoEraAnime', ' a ']}), ['a', 'b', 'EdoEraAnime'])
    assert.deepEqual(accepted({accept: ['(cv4n14-style:1.2)']}), ['cv4n14-style']) // as lint reads it
    assert.throws(
      () => settingChanges({accept: ['ok', '{2::a|b}']}),
      /^Error: Not a tag: \{2::a\|b\}\. Wildcard syntax/,
    )
    assert.throws(() => settingChanges({accept: ['__own/clothes__']}), /Not a tag: __own\/clothes__\./)
    const home = {lint: {acceptedTags: ['a', 'b']}}
    assert.deepEqual(accepted({unaccept: ['A']}, home), ['b'])
    assert.equal(accepted({unaccept: ['a,b']}, home), undefined) // an empty list removes the setting
    assert.deepEqual(settingChanges({reset: ['accepted-tags']}), {'lint.acceptedTags': undefined})
    assert.throws(() => settingChanges({accept: ['x'], unaccept: ['X']}), /^Error: x: given to both --accept and/)
    assert.throws(() => settingChanges({unaccept: ['zzz']}, home), /Not an accepted tag: zzz\./)
    assert.throws(() => settingChanges({accept: ['x'], reset: ['accepted-tags']}), /together/)
    assert.throws(() => settingChanges({'accept-loras': 'missing'}, {}, dir), /No such folder: .*missing/)

    await withDataDir(empty, () => {
      // the gather leaves out tags danbooru.csv knows and accepted ones; a --data-dir given with it is used at once
      const report = []
      const flags = {'accept-loras': 'loras', 'data-dir': 'tags', recursive: true}
      assert.deepEqual(settingChanges(flags, home, dir, report)['lint.acceptedTags'], [
        'a',
        'b',
        'cv4n14-style',
        'EdoEraAnime',
      ])
      assert.deepEqual(report, [
        `Gathered 2 new tags from 3 sidecars (left out 1 already accepted, 1 tag danbooru.csv knows, 2 pieces of wildcard syntax) in ${loras} and its subfolders.`,
      ])

      // without danbooru.csv nothing is left out; without recursive, subfolders aren't searched
      const plain = []
      assert.deepEqual(accepted({'accept-loras': loras}), ['b', 'EdoEraAnime', 'long hair'])
      settingChanges({'accept-loras': loras}, {}, dir, plain)
      assert.deepEqual(plain, [
        `Gathered 3 new tags from 2 sidecars in ${loras}. No danbooru.csv in ${empty}, so Danbooru tags weren't left out.`,
      ])

      const none = []
      assert.deepEqual(settingChanges({'accept-loras': tags}, home, dir, none), {'lint.acceptedTags': ['a', 'b']})
      assert.deepEqual(none, [`No LoRA sidecars (.json with activation text) in ${tags} (subfolders not searched).`])
    })
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('the listing shows the accepted tags: how many, the first five, and where they come from', () => {
  const line = (home, local) =>
    formatWcSettings(home, local)
      .split('\n')
      .find((text) => text.startsWith('Accepted tags'))
  assert.equal(line({}, {}), 'Accepted tags        none')
  assert.equal(
    line({lint: {acceptedTags: ['a', 'b', 'c', 'd', 'e', 'f']}}, {}),
    'Accepted tags        6: a, b, c, d, e, …  (saved)',
  )
  assert.equal(
    line({lint: {acceptedTags: ['a']}}, {lint: {acceptedTags: ['x', 'y']}}),
    'Accepted tags        2: x, y  (set in ./civit-tool.config.json)',
  )
})

test('makeLintConfig accepts rule switches only as {RULE: true|false}', () => {
  assert.deepEqual(makeLintConfig({rules: {'S-branch': false, R1: true}}).rules, {'S-branch': false, R1: true})
  assert.throws(() => makeLintConfig({rules: ['S-branch']}, 'cfg.json'), /cfg\.json: lint\.rules must be an object/)
  assert.throws(() => makeLintConfig({rules: {R9: false}}, 'cfg.json'), /cfg\.json: lint\.rules: unknown rule "R9"/)
  assert.throws(() => makeLintConfig({rules: {R1: 'off'}}, 'cfg.json'), /lint\.rules\.R1 must be true or false/)
})

test('a rule that is off reports nothing, fixes nothing, and is named under the report', () => {
  const source = 'simple:\n  - chains, j@ck\n'
  assert.deepEqual(rules(lintYaml(source)), ['R3', 'R6'])

  // R3 off: its finding is gone, and an ignore over it doesn't count it as hidden
  const config = makeLintConfig({rules: {R3: false}, ignore: [{path: '**', rules: ['R3']}]})
  const file = parseWildcardFile(source, {path: 'lib.yaml'})
  const result = lintFiles([file], index, config)
  assert.deepEqual(rules(result), ['R6'])
  assert.deepEqual(result.rulesOff, ['R3'])
  assert.deepEqual(
    result.suppressed.map((s) => s.count),
    [0],
  )
  assert.match(formatText(result), /\nrules off: R3$/)

  // --fix works from the findings, so the alias stays and only the @ is escaped
  assert.equal(applyFixes(file, result.findings).output, 'simple:\n  - chains, j\\@ck\n')
})

// each CLI start is slow on some disks, so this keeps to four runs
test("wc config saves to the home config and wc lint uses it; the default data folder is civit-tool's", () => {
  const dir = tempDir()
  try {
    const home = path.join(dir, 'home')
    const work = path.join(dir, 'work')
    const emptyData = path.join(dir, 'empty-data')
    const tags = path.join(dir, 'tags')
    const loras = path.join(dir, 'loras')
    for (const folder of [home, work, emptyData, tags, loras]) fs.mkdirSync(folder)
    fs.writeFileSync(path.join(tags, 'danbooru.csv'), REAL_CSV_ROWS)
    writeSidecars(loras)
    // no branch key above it (S-branch), an alias (R3), a LoRA's activation tag and an unknown tag (R1)
    fs.writeFileSync(path.join(work, 'lib.yaml'), 'characters:\n  - chains, long_hair, EdoEraAnime, mystery_tag\n')
    // the local config turns R2 off, on top of what wc config saves
    fs.writeFileSync(path.join(work, 'civit-tool.config.json'), JSON.stringify({lint: {rules: {R2: false}}}))
    const run = (...args) =>
      spawnSync(process.execPath, [BIN, 'wc', ...args], {
        cwd: work,
        encoding: 'utf8',
        env: {...process.env, CIVIT_TOOL_DATA_DIR: emptyData, FORCE_COLOR: '0', HOME: home, USERPROFILE: home},
      })

    // nothing set yet: lint looks in the default data folder and says how to fill it
    const missing = run('lint', 'lib.yaml')
    assert.equal(missing.status, 2, missing.stdout)
    assert.match(unwrap(missing.stderr), /No danbooru\.csv in civit-tool's data folder, .*empty-data\. /)
    assert.match(unwrap(missing.stderr), /with: civit-tool wc config --data-dir <folder>/)

    const set = run(
      'config',
      ...['--data-dir', tags, '--off', 'S-branch,P-neg', '--on', 'R2', '--max-tags', '50'],
      ...['--accept-loras', loras, '--recursive'],
    )
    assert.equal(set.status, 0, set.stderr)
    assert.match(
      set.stdout,
      new RegExp(
        `^Gathered 3 new tags from 3 sidecars \\(left out 1 tag danbooru\\.csv knows, 2 pieces of wildcard syntax\\) in ${escape(loras)} and its subfolders\\.\\nSaved in ${escape(homeConfigPath(home))}\\.`,
      ),
    )
    assert.match(set.stdout, /Note: \.\/civit-tool\.config\.json turns R2 on or off, which is used instead\./)
    assert.match(set.stdout, new RegExp(`\\nData folder {10}${escape(tags)}  \\(saved; danbooru\\.csv found\\)\\n`))
    assert.match(
      set.stdout,
      /\nWildcards folder {5}not set\nLoRA folders {9}not set {2}\(S-base checks nothing without them\)\n/,
    )
    assert.match(set.stdout, /\nMinimum posts {8}80 {2}\(default\)\nMax tags per entry {3}50 {2}\(saved\)\n/)
    assert.match(set.stdout, /\nAccepted tags {8}3: b, cv4n14-style, EdoEraAnime {2}\(saved\)\n/)
    assert.match(set.stdout, /\noff {2}R2 .*minCount {2}\(set in \.\/civit-tool\.config\.json\)\n/)
    assert.match(set.stdout, /\non {3}R1 /)
    assert.match(set.stdout, /\noff {2}S-branch {2}warn {3}tags with no branch key/)
    assert.deepEqual(readJson(homeConfigPath(home)), {
      lint: {
        acceptedTags: ['b', 'cv4n14-style', 'EdoEraAnime'],
        dataDir: tags,
        maxTagsPerEntry: 50,
        rules: {'S-branch': false, 'P-neg': false},
      },
    })

    const lint = run('lint', 'lib.yaml')
    assert.equal(lint.status, 1, lint.stderr)
    assert.match(lint.stdout, /R3 +"chains" is an alias of chain/)
    assert.match(lint.stdout, /R1 +unknown tag "mystery_tag"/)
    assert.doesNotMatch(lint.stdout, /EdoEraAnime|S-branch {2}/)
    assert.match(lint.stdout, /\nrules off: R2, S-branch, P-neg\n/)

    const resets = ['data-dir', 'rules', 'max-tags', 'accepted-tags'].flatMap((name) => ['--reset', name])
    const reset = run('config', ...resets)
    assert.equal(reset.status, 0, reset.stderr)
    assert.deepEqual(readJson(homeConfigPath(home)), {})
    assert.match(reset.stdout, /empty-data {2}\(default; no danbooru\.csv\)\n/)
    assert.match(reset.stdout, /\non {3}S-branch /)
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('the wc config menu switches rules, changes folders and refuses what the local config sets', async () => {
  const dir = tempDir()
  const dataDir = process.env.CIVIT_TOOL_DATA_DIR
  process.env.CIVIT_TOOL_DATA_DIR = dir // the default data folder, without a danbooru.csv
  try {
    const home = path.join(dir, 'home')
    const work = path.join(dir, 'work')
    const wildcards = path.join(dir, 'my wildcards')
    for (const folder of [home, work, wildcards]) fs.mkdirSync(folder)
    fs.writeFileSync(path.join(work, 'civit-tool.config.json'), JSON.stringify({lint: {rules: {R1: false}}}))
    const term = fakeTerminal({columns: 200})
    const last = () => term.frames().at(-1)
    const done = configMenu({cwd: work, home, input: term.input, output: term.output})

    assert.match(last(), new RegExp(`Changes are saved in ${escape(homeConfigPath(home))} as you make them`))
    assert.match(last(), /› Data folder {10}.*\(default; no danbooru\.csv\)\n {2}Wildcards folder {5}not set\n/)
    assert.match(last(), /\n {2}off {2}R1 .*\(set in \.\/civit-tool\.config\.json\)\n/)
    // under the menu: what the row under the cursor does, then the keys
    assert.match(last(), /\nThe folder with the danbooru\.csv .*\n↑\/↓ move {3}Enter change {3}r default {3}q quit\n$/)

    // a folder: Enter asks, a pasted path in quotes is saved absolute; a missing one is refused
    await term.press(KEYS.down, KEYS.enter, '"../my wildcards"', KEYS.enter)
    assert.match(
      last(),
      new RegExp(
        `› Wildcards folder {5}${escape(wildcards)}  \\(saved\\)\\n.*\\nSaved: wildcards folder ${escape(wildcards)}\\.\\n$`,
        's',
      ),
    )
    await term.press(KEYS.home, KEYS.enter, 'missing', KEYS.enter)
    assert.match(last(), /\nNo such folder: .*missing\n$/)
    await term.press('r')
    assert.match(last(), /\nData folder is already the default\.\n$/)

    // several folders, separated by ; (quotes are fine)
    await term.press(KEYS.down, KEYS.down, KEYS.enter, `"${wildcards}" ; ${work}`, KEYS.enter)
    assert.match(last(), new RegExp(`› LoRA folders {9}${escape(wildcards)}; ${escape(work)}  \\(saved\\)\\n`))

    // a number: anything but a whole number is refused
    await term.press(KEYS.down, KEYS.enter, '12.5', KEYS.enter)
    assert.match(last(), /\nMinimum posts must be a whole number of at least 0\.\n$/)
    await term.press(KEYS.enter, '100', KEYS.enter)
    assert.match(last(), /› Minimum posts {8}100 {2}\(saved\)\n.*\nSaved: minimum posts 100\.\n$/s)

    // rules: Enter switches and saves at once; R1 is set locally, so it is refused
    await term.press(KEYS.end, KEYS.enter, KEYS.up, KEYS.enter, KEYS.enter)
    assert.match(last(), /\n› on {3}P-tags .*\n {2}off {2}P-neg .*Saved: P-tags on\.\n$/s)
    await term.press(KEYS.home, ...Array(9).fill(KEYS.down), KEYS.enter)
    assert.match(last(), /› off {2}R1 .*\nR1 is set in \.\/civit-tool\.config\.json; change it there\.\n$/s)
    assert.deepEqual(readJson(homeConfigPath(home)), {
      wildcardsDir: wildcards,
      lint: {loraDirs: [wildcards, work], minCount: 100, rules: {'P-neg': false}},
    })

    // r on a saved folder goes back to the default
    await term.press(KEYS.home, KEYS.down, 'r', 'q')
    await done
    assert.deepEqual(readJson(homeConfigPath(home)), {
      lint: {loraDirs: [wildcards, work], minCount: 100, rules: {'P-neg': false}},
    })
  } finally {
    if (dataDir === undefined) delete process.env.CIVIT_TOOL_DATA_DIR
    else process.env.CIVIT_TOOL_DATA_DIR = dataDir
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test('the wc config menu adds, removes and clears accepted tags, and gathers them from LoRA sidecars', async () => {
  const dir = tempDir()
  try {
    const home = path.join(dir, 'home')
    const work = path.join(dir, 'work')
    const tags = path.join(dir, 'tags')
    const loras = path.join(dir, 'loras')
    for (const folder of [home, work, tags, loras]) fs.mkdirSync(folder)
    fs.writeFileSync(path.join(tags, 'danbooru.csv'), REAL_CSV_ROWS)
    writeSidecars(loras)

    await withDataDir(tags, async () => {
      const term = fakeTerminal({columns: 200})
      const last = () => term.frames().at(-1)
      const done = configMenu({cwd: work, home, input: term.input, output: term.output})

      await term.press(...Array(7).fill(KEYS.down))
      assert.match(last(), /\n› Accepted tags {8}none\n {2}Gather LoRA tags…\n {2}\n {2}Lint rules/)
      assert.match(
        last(),
        /\nTags wc lint doesn't check against Danbooru, e\.g\. LoRA activation tags\n↑\/↓ move {3}Enter add or remove {3}r clear {3}q quit\n$/,
      )

      // Enter asks for tags to accept; -tag removes one
      await term.press(KEYS.enter, 'my-tag, b', KEYS.enter)
      assert.match(last(), /› Accepted tags {8}2: b, my-tag {2}\(saved\)\n.*\nSaved: 2 accepted \(2 in all\)\.\n$/s)
      await term.press(KEYS.enter, 'third, -b', KEYS.enter)
      assert.match(last(), /› Accepted tags {8}2: my-tag, third .*\nSaved: 1 accepted, 1 removed \(2 in all\)\.\n$/s)
      await term.press(KEYS.enter, '-nope', KEYS.enter)
      assert.match(last(), /\nNot an accepted tag: nope\.\n$/)

      // r clears them all, once confirmed
      await term.press('r')
      assert.match(last(), /\nClear all 2 accepted tags\? \(y\/N\): /)
      await term.press('n', KEYS.enter)
      assert.match(last(), /\nAccepted tags kept\.\n$/)
      await term.press('r', 'y', KEYS.enter)
      assert.match(last(), /› Accepted tags {8}none\n.*\nSaved: accepted tags cleared\.\n$/s)

      // the gather asks for the folder (checked at once), then whether to search its subfolders
      await term.press(KEYS.down, KEYS.enter, 'missing', KEYS.enter)
      assert.match(last(), /\nNo such folder: .*missing\n$/)
      await term.press(KEYS.enter, `"${loras}"`, KEYS.enter)
      assert.match(last(), /\nInclude subfolders\? \(y\/N\): /)
      await term.press(KEYS.enter)
      assert.match(
        last(),
        new RegExp(
          `\\nGathered 2 new tags from 2 sidecars \\(left out 1 tag danbooru\\.csv knows\\) in ${escape(loras)}\\.\\n$`,
        ),
      )
      await term.press(KEYS.enter, loras, KEYS.enter, 'y', KEYS.enter)
      assert.match(
        last(),
        new RegExp(
          `\\nGathered 1 new tag from 3 sidecars \\(left out 2 already accepted, 1 tag danbooru\\.csv knows, 2 pieces of wildcard syntax\\) in ${escape(loras)} and its subfolders\\.\\n$`,
        ),
      )
      await term.press(KEYS.enter, KEYS.enter)
      assert.match(last(), /\nNothing gathered\.\n$/)
      const saved = {lint: {acceptedTags: ['b', 'cv4n14-style', 'EdoEraAnime']}}
      assert.deepEqual(readJson(homeConfigPath(home)), saved)

      // accepted tags the local config sets lock both rows
      fs.writeFileSync(path.join(work, 'civit-tool.config.json'), JSON.stringify({lint: {acceptedTags: ['x']}}))
      await term.press(KEYS.enter)
      assert.match(
        last(),
        /› Gather LoRA tags…\n.*\nAccepted tags is set in \.\/civit-tool\.config\.json; change it there\.\n$/s,
      )
      await term.press(KEYS.up, 'r')
      assert.match(
        last(),
        /› Accepted tags {8}1: x {2}\(set in \.\/civit-tool\.config\.json\)\n.*\nAccepted tags is set in /s,
      )
      await term.press('q')
      await done
      assert.deepEqual(readJson(homeConfigPath(home)), saved)
    })
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }
})
