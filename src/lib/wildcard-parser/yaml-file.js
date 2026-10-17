// Reading and writing wildcard YAML files.
//
// The `yaml` package reads the structure. We keep its Document, so writing back keeps comments,
// key order and scalar styles (`>-` stays `>-`). Printing is canonical (2-space indent, no line
// re-wrapping), so odd existing indentation is not kept.
// The file's line ending (CRLF for the real library) is kept.

import {basename, extname} from 'node:path'
import {parseDocument, isMap, isSeq, isScalar} from 'yaml'
import {parseTemplate} from './template.js'
import {findAnimaTagLineStart} from './anima.js'
import {computeLineStarts, lineColAt, findValueStart} from './positions.js'
import {globToRegExp} from './refs.js'

/**
 * Model branches: a key whose name matches one of a branch's `keys` (globs, case-insensitive) puts
 * everything under it in that branch; the first matching branch wins. `style` says how its entries
 * are written:
 * - `tags`: Danbooru tags.
 * - `sentence`: one natural-language sentence, then a tag line (Anima).
 * - `prose`: natural language only, no tags (Krea 2).
 * `baseModels` are the Civitai base models its LoRAs may have (rule S-base). A `shared` branch is
 * for entries every model can use, so it takes no LoRAs.
 */
export const DEFAULT_BRANCHES = {
  ill: {keys: ['ill'], style: 'tags', baseModels: ['Illustrious', 'NoobAI']},
  anima: {keys: ['anima'], style: 'sentence', baseModels: ['Anima']},
  krea: {keys: ['*krea*'], style: 'prose', baseModels: ['Krea 2', 'Krea 2 Turbo']},
  simple: {keys: ['simple', 'generic'], style: 'tags', shared: true},
}

export const BRANCH_STYLES = ['tags', 'sentence', 'prose']

// A list item that starts with `{` is a YAML flow mapping, not a string: it must be quoted.
const LIST_ITEM_NOT_SCALAR = 'list item is not a plain value (an item starting with "{" must be quoted); it is skipped'

export function parseWildcardFile(source, options = {}) {
  const branches = options.branches ?? DEFAULT_BRANCHES
  const branchMatchers = Object.entries(branches).map(([branch, def]) => ({
    branch,
    patterns: def.keys.map((k) => new RegExp(globToRegExp(k).source, 'i')),
  }))
  const doc = parseDocument(source)
  const file = {
    path: options.path ?? '',
    source,
    eol: source.includes('\r\n') ? '\r\n' : '\n',
    lineStarts: computeLineStarts(source),
    doc,
    roots: [],
    keys: new Map(),
    entries: [],
    problems: [],
  }

  const problem = (kind, severity, message, keyPath, offset) => {
    file.problems.push({kind, severity, message, keyPath, ...lineColAt(file.lineStarts, offset)})
  }

  for (const err of doc.errors) problem('yaml', 'error', err.message.split('\n')[0], '', err.pos[0])
  for (const warning of doc.warnings) problem('yaml', 'warn', warning.message.split('\n')[0], '', warning.pos[0])

  const branchOf = (name, inherited) =>
    branchMatchers.find((m) => m.patterns.some((re) => re.test(name)))?.branch ?? inherited
  const styleOf = (branch) => (branch === null ? null : branches[branch].style)

  const makeKey = (name, path, branch, offset) => {
    const key = {
      name,
      path,
      branch,
      line: lineColAt(file.lineStarts, offset).line,
      children: [],
      entries: [],
      isLeaf: false,
    }
    file.keys.set(path, key)
    return key
  }

  /** A list makes its key a leaf wildcard: every scalar item is an entry. */
  const readList = (seq, key, keyOffset) => {
    key.isLeaf = true
    seq.items.forEach((item, index) => {
      if (isScalar(item)) key.entries.push(readEntry(item, key, index))
      else problem('yaml', 'warn', LIST_ITEM_NOT_SCALAR, key.path, keyOffset)
    })
  }

  /** Walk a mapping: each key becomes a KeyNode; lists become entries. */
  const walkMap = (map, parentPath, parentBranch) => {
    const nodes = []
    for (const pair of map.items) {
      const keyOffset = isScalar(pair.key) && pair.key.range ? pair.key.range[0] : 0
      const name = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
      const path = parentPath ? `${parentPath}/${name}` : name
      const key = makeKey(name, path, branchOf(name, parentBranch), keyOffset)
      nodes.push(key)

      const value = pair.value
      if (isMap(value)) {
        key.children = walkMap(value, path, key.branch)
      } else if (isSeq(value)) {
        readList(value, key, keyOffset)
      } else if (value === null || (isScalar(value) && value.value === null)) {
        problem('yaml', 'warn', 'key has no value', path, keyOffset)
      } else {
        problem('yaml', 'warn', 'key holds a single value, not a list; dynamic-prompts ignores it', path, keyOffset)
      }
    }
    return nodes
  }

  const readEntry = (node, key, index) => {
    // Plain scalars: take the source text, so `- 1` or `- yes` stay strings.
    const value = typeof node.value === 'string' ? node.value : String(node.source ?? node.value)
    const offset = node.range ? node.range[0] : 0
    const {template, problems} = parseTemplate(value)
    const entry = {
      keyPath: key.path,
      index,
      value,
      branch: key.branch,
      style: styleOf(key.branch),
      template,
      ...lineColAt(file.lineStarts, offset),
      valueStart: findValueStart(source, node, value),
      node,
    }
    const at = (valueOffset) => (entry.valueStart === null ? offset : entry.valueStart + valueOffset)
    for (const p of problems) problem('brace', 'error', p.message, key.path, at(p.offset))

    if (entry.style === 'sentence') {
      const tagLineStart = findAnimaTagLineStart(value, template)
      if (tagLineStart === null) {
        problem(
          'anima',
          'warn',
          `${entry.branch} entry has no sentence terminator (. ! ?); treated as tags only`,
          key.path,
          offset,
        )
      } else {
        entry.tagLineStart = tagLineStart
      }
    }
    file.entries.push(entry)
    return entry
  }

  if (isMap(doc.contents)) {
    file.roots = walkMap(doc.contents, '', null)
  } else if (isSeq(doc.contents)) {
    // A file that is just a list (e.g. civit-tool's loras.yaml) is one wildcard named after the
    // file, as in dynamic-prompts: `loras.yaml` → `__loras__`.
    const name = file.path ? basename(file.path, extname(file.path)) : 'root'
    const key = makeKey(name, name, branchOf(name, null), 0)
    readList(doc.contents, key, 0)
    file.roots = [key]
  } else if (doc.contents !== null) {
    problem('yaml', 'error', 'the top level of a wildcard file must be a mapping or a list', '', 0)
  }
  return file
}

/**
 * Change one entry's value in the Document (e.g. a lint fix). The parsed model (`entries`,
 * templates) is not updated; print and re-parse to get a fresh one.
 */
export function setEntryValue(entry, value) {
  entry.node.value = value
}

/** Print the file in canonical form, with the file's own line ending. */
export function printWildcardFile(file) {
  const text = file.doc.toString({indent: 2, lineWidth: 0})
  return file.eol === '\n' ? text : text.replace(/\r?\n/g, file.eol)
}
