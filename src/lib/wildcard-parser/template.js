// Parser for one wildcard entry: the dynamic-prompts / prompt-postprocessor template syntax.
//
//   sequence := ( text | group | ref | lora | variable )*
//   group    := '{' header option ( '|' option )* '}'
//   header   := [~@]? ( [ro]* range? '$$' ( separator '$$' )? )?
//   option   := ( number '::' )? sequence
//
// Recursive descent over the string. Escapes (`\{`, `\(`, `\@`, …) are kept in text verbatim, so
// they never act as syntax. Problems (unclosed `{`, stray `}`) are reported, and parsing goes on.

// Sticky regexes: matched at an exact position with `lastIndex`.
const HEADER = /([~@])?(?:([ro]*)(\d+(?:-\d*)?|-\d+)?\$\$(?:([^|{}]*?)\$\$)?)?/y
const WEIGHT = /(\d+(?:\.\d+)?|\.\d+)::/y
// __[params$$]name['filter'][(vars)]__ ; the name has no spaces, commas or variant syntax.
const REF = /__(?:([^\s,{}|$]*)\$\$)?([^\s,{}|'()_][^\s,{}|'()]*?)(?:'([^']*)')?(?:\(([^)]*)\))?__/y
const LORA = /<(lora|lyco):([^>]*)>/y

export function parseTemplate(value) {
  const problems = []
  let i = 0

  function parseSequence(insideGroup) {
    const nodes = []
    let textStart = i
    const flushText = () => {
      if (i > textStart) nodes.push({type: 'text', raw: value.slice(textStart, i), start: textStart, end: i})
    }

    while (i < value.length) {
      const ch = value[i]
      if (ch === '\\' && i + 1 < value.length) {
        i += 2 // escaped character: always literal text
        continue
      }
      if (insideGroup && (ch === '|' || ch === '}')) break
      if (ch === '}') {
        problems.push({message: 'unmatched "}"', offset: i})
        i++ // keep it as text
        continue
      }
      if (ch === '{') {
        flushText()
        nodes.push(parseGroup())
        textStart = i
        continue
      }
      const atomic = matchAtomic()
      if (atomic) {
        flushText()
        nodes.push(atomic)
        i = atomic.end
        textStart = i
        continue
      }
      i++
    }
    flushText()
    return nodes
  }

  /** A ref, lora or variable starting at i, or null. */
  function matchAtomic() {
    if (value.startsWith('__', i)) {
      REF.lastIndex = i
      const m = REF.exec(value)
      if (m) {
        const node = {
          type: 'ref',
          raw: m[0],
          name: m[2],
          glob: m[2].includes('*'),
          start: i,
          end: i + m[0].length,
        }
        if (m[1] !== undefined) node.params = m[1]
        if (m[3] !== undefined) node.filter = m[3]
        if (m[4] !== undefined) node.vars = m[4]
        return node
      }
    }
    if (value[i] === '<') {
      LORA.lastIndex = i
      const m = LORA.exec(value)
      if (m) {
        const [name, ...args] = m[2].split(':')
        return {type: 'lora', raw: m[0], network: m[1], name, args, start: i, end: i + m[0].length}
      }
    }
    if (value.startsWith('${', i)) {
      // Variables may contain nested braces: `${season=!{summer|winter}}`.
      let depth = 0
      for (let j = i + 1; j < value.length; j++) {
        if (value[j] === '\\') j++
        else if (value[j] === '{') depth++
        else if (value[j] === '}' && --depth === 0) {
          return {type: 'variable', raw: value.slice(i, j + 1), start: i, end: j + 1}
        }
      }
    }
    return null
  }

  function parseGroup() {
    const start = i
    i++ // '{'
    HEADER.lastIndex = i
    const h = HEADER.exec(value) // always matches (everything is optional)
    const group = {type: 'group', headerRaw: h[0], options: [], closed: false, start, end: start}
    if (h[1]) group.sampler = h[1]
    if (h[2]) group.flags = h[2]
    if (h[3] !== undefined) group.select = parseRange(h[3])
    if (h[4] !== undefined) group.separator = h[4]
    i += h[0].length

    for (;;) {
      group.options.push(parseOption())
      if (value[i] === '|') {
        i++
        continue
      }
      if (value[i] === '}') {
        i++
        group.closed = true
      } else {
        problems.push({message: 'unclosed "{"', offset: start})
      }
      break
    }
    group.end = i
    return group
  }

  function parseOption() {
    const start = i
    WEIGHT.lastIndex = i
    const w = WEIGHT.exec(value)
    const option = {prefixRaw: w ? w[0] : '', body: [], start, end: start}
    if (w) {
      option.weight = Number(w[1])
      i += w[0].length
    }
    option.body = parseSequence(true)
    option.end = i
    return option
  }

  const template = parseSequence(false)
  return {template, problems}
}

function parseRange(text) {
  const [a, b] = text.split('-')
  const range = {}
  if (!text.includes('-')) {
    range.min = range.max = Number(a)
    return range
  }
  if (a !== '') range.min = Number(a)
  if (b !== '') range.max = Number(b)
  return range
}

/** Inverse of parseTemplate: rebuilds the exact value from the AST. */
export function renderTemplate(template) {
  return template.map(renderNode).join('')
}

function renderNode(node) {
  if (node.type !== 'group') return node.raw
  const options = node.options.map((o) => o.prefixRaw + renderTemplate(o.body)).join('|')
  return '{' + node.headerRaw + options + (node.closed ? '}' : '')
}

/** All nodes of a template, depth first (groups before their options' contents). */
export function* walkTemplate(template) {
  for (const node of template) {
    yield node
    if (node.type === 'group') for (const option of node.options) yield* walkTemplate(option.body)
  }
}
