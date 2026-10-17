// Golden file: the full lint report on a real example library. It needs the full danbooru.csv, which isn't in this repo: point
// LINT_DATA_DIR at the folder holding it, e.g.
//   LINT_DATA_DIR=path/to/tags npm test
// Skipped without it.

import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {DEFAULT_CONFIG, formatText, lintFiles} from '../lib/lint/index.js'
import {loadTagIndex} from '../lib/tag-index/index.js'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'

const FIXTURES = fileURLToPath(new URL('fixtures/lint/', import.meta.url))
const dataDir = process.env.LINT_DATA_DIR
const skip =
  dataDir && existsSync(join(dataDir, 'danbooru.csv')) ? false : 'set LINT_DATA_DIR to a folder with danbooru.csv'

test('lint report on danboru_class_prompter.yaml matches the golden file', {skip}, () => {
  // the path the golden report was made with
  const path = 'fixtures/danboru_class_prompter.yaml'
  const file = parseWildcardFile(readFileSync(join(FIXTURES, 'danboru_class_prompter.yaml'), 'utf8'), {path})
  const report = formatText(lintFiles([file], loadTagIndex({dataDir}), DEFAULT_CONFIG))
  const golden = readFileSync(join(FIXTURES, 'danboru_class_prompter.lint.txt'), 'utf8')
  assert.equal(report + '\n', golden)
})
