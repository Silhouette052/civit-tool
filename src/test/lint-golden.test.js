// Golden file: the full lint report on a real example library. It needs the danbooru.csv the report was made with,
// which isn't in git: it reads civit-tool's data folder, or the folder LINT_DATA_DIR points at, e.g.
//   LINT_DATA_DIR=path/to/tags npm test
// Skipped when that folder has no danbooru.csv, or another one (other tags and counts give another report).

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {defaultDataDir} from '../lib/config.js'
import {DEFAULT_CONFIG, formatText, lintFiles} from '../lib/lint/index.js'
import {loadTagIndex} from '../lib/tag-index/index.js'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'

const FIXTURES = fileURLToPath(new URL('fixtures/lint/', import.meta.url))
const dataDir = process.env.LINT_DATA_DIR || defaultDataDir()
// the Tag Autocomplete danbooru.csv of 2026-10-02 (1,658,711 bytes)
const GOLDEN_CSV_SHA256 = 'c5b33ce28ec258053610fb6b0971b9452f1f3d786bf9155a826c765051134e1e'

function skipReason() {
  const csv = join(dataDir, 'danbooru.csv')
  if (!existsSync(csv)) return 'put danbooru.csv in the data folder, or set LINT_DATA_DIR to a folder with it'
  if (createHash('sha256').update(readFileSync(csv)).digest('hex') === GOLDEN_CSV_SHA256) return false
  return `the report was made with another danbooru.csv (sha256 ${GOLDEN_CSV_SHA256.slice(0, 12)}…); set LINT_DATA_DIR to its folder`
}

const skip = skipReason()

test('lint report on danboru_class_prompter.yaml matches the golden file', {skip}, () => {
  // the path the golden report was made with
  const path = 'fixtures/danboru_class_prompter.yaml'
  const file = parseWildcardFile(readFileSync(join(FIXTURES, 'danboru_class_prompter.yaml'), 'utf8'), {path})
  const report = formatText(lintFiles([file], loadTagIndex({dataDir}), DEFAULT_CONFIG))
  const golden = readFileSync(join(FIXTURES, 'danboru_class_prompter.lint.txt'), 'utf8')
  assert.equal(report + '\n', golden)
})
