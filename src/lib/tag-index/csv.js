// Loader for danbooru.csv (the "autocomplete" format used by a1111-sd-webui-tagcomplete).
//
// File facts:
// - No header row. Each row is `tag,category,count,aliases`.
// - `aliases` is ONE field: quoted when it holds several comma-separated names,
//   e.g. `long_hair,0,4350743,"/lh,longhair"`. It may be empty: `bikini_armor,0,9673,`.
// - Tags may themselves be quoted, with `""` for a literal quote: `"don't_say_""lazy""",0,1076,…`
// - Line endings are CRLF, and the last row has no trailing newline.
// - Aliases starting with `/` (`/lh`) are autocomplete shortcuts, not real aliases.

import {readFileSync} from 'node:fs'

// Danbooru's numeric category codes. Code 2 is unused by Danbooru.
const CATEGORY_CODES = {
  0: 'general',
  1: 'artist',
  3: 'copyright',
  4: 'character',
  5: 'meta',
}

/**
 * Split one CSV line into fields (RFC 4180 quoting: `"a,b"` is one field, `""` inside
 * quotes is a literal `"`). Lines never contain embedded newlines in this file.
 */
export function parseCsvLine(line) {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"' // escaped quote
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  if (inQuotes) throw new Error('unterminated quoted field')
  fields.push(field)
  return fields
}

/** Parse the whole file. Throws with the 1-based line number on any malformed row. */
export function parseDanbooruCsv(text) {
  const rows = []
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue // tolerate a trailing newline / blank lines
    try {
      rows.push(parseRow(line))
    } catch (err) {
      throw new Error(`danbooru.csv line ${i + 1}: ${err.message}`)
    }
  }
  return rows
}

function parseRow(line) {
  const fields = parseCsvLine(line)
  if (fields.length !== 4) throw new Error(`expected 4 fields, got ${fields.length}`)
  const [tag, code, countText, aliasField] = fields

  const category = CATEGORY_CODES[code]
  if (!category) throw new Error(`unknown category code ${JSON.stringify(code)}`)
  if (!/^\d+$/.test(countText)) throw new Error(`count is not an integer: ${JSON.stringify(countText)}`)

  const names = aliasField === '' ? [] : aliasField.split(',')
  return {
    tag,
    category,
    count: Number(countText),
    aliases: names.filter((a) => !a.startsWith('/')),
    shortcuts: names.filter((a) => a.startsWith('/')),
  }
}

/** Read and parse a danbooru.csv file from disk. */
export function loadDanbooruCsv(path) {
  return parseDanbooruCsv(readFileSync(path, 'utf8'))
}
