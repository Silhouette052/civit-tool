// Shared test helpers: the real example library (committed in fixtures/) and small utilities.

import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {
  parseWildcardFile,
  parseTemplate,
  extractTags,
  entryPosition,
} from '../lib/wildcard-parser/index.js'

export const FIXTURE_PATH = fileURLToPath(new URL('fixtures/lint/danboru_class_prompter.yaml', import.meta.url))
export const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, 'utf8')
export const fixture = parseWildcardFile(FIXTURE_SOURCE, {path: FIXTURE_PATH})

/** The fixture entry whose value starts on this (1-based) line of the file. */
export function entryAtLine(line) {
  const entry = fixture.entries.find((e) => entryPosition(fixture, e, 0).line === line)
  if (!entry) throw new Error(`no entry starts on line ${line}`)
  return entry
}

/** Tag texts of a single entry string, sorted (kind `tag` only unless `kinds` says otherwise). */
export function tagTexts(value, kinds = ['tag']) {
  const {template} = parseTemplate(value)
  return extractTags(value, template)
    .tags.filter((t) => kinds.includes(t.kind))
    .map((t) => t.text)
    .sort()
}
