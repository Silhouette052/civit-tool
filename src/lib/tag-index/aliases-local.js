// Loader for data/aliases.local.csv: alias overrides maintained by the user.
//
// Some aliases break generation but are missing from danbooru.csv (e.g. `tall_woman` → `tall_female`).
// Format: header `alias,tag`, then one `alias,tag` pair per line; `;` works in place of `,` when the header uses
// it (`alias;tag`). Blank lines and lines starting with `#` are ignored. Both columns may be written in any C5
// form (`tall woman` works too).

import {readFileSync} from 'node:fs'
import {normalizeTag} from './normalize.js'

export function parseAliasOverrides(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = lines[0]?.trim()
  if (header !== 'alias,tag' && header !== 'alias;tag') {
    throw new Error('aliases.local.csv line 1: expected the header "alias,tag" (or "alias;tag")')
  }

  const separator = header[5]
  const overrides = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(separator)
    if (parts.length !== 2) throw new Error(`aliases.local.csv line ${i + 1}: expected "alias${separator}tag"`)
    const alias = normalizeTag(parts[0])
    const tag = normalizeTag(parts[1])
    if (!alias || !tag) throw new Error(`aliases.local.csv line ${i + 1}: empty alias or tag`)
    if (alias === tag) throw new Error(`aliases.local.csv line ${i + 1}: alias equals its tag`)
    overrides.push({alias, tag, line: i + 1})
  }
  return overrides
}

export function loadAliasOverrides(path) {
  return parseAliasOverrides(readFileSync(path, 'utf8'))
}
