// Public API of the wildcard parser: other modules import only from this file.
// Parses wildcard YAML into keys, entries, template ASTs and the tags to validate, each node
// tagged with its model branch (ill/anima/krea/simple by default, see DEFAULT_BRANCHES).
//
// Shapes (value offsets index into an entry's value string, what YAML gives for one list item;
// positions.js maps them back to file line/col; spans are half-open {start, end}):
//
// WildcardFile {path, source, eol: '\n' | '\r\n', lineStarts, doc (yaml Document), roots: KeyNode[],
//               keys: Map<path, KeyNode>, entries: Entry[] (file order), problems: ParseProblem[]}
// KeyNode      {name, path, branch, line, children: KeyNode[], entries: Entry[], isLeaf}
//              A key holding a list is a leaf wildcard; branch is a branch name or null.
// Entry        {keyPath, index, value, branch, style, template, tagLineStart?, line, col, valueStart, node}
//              style: the branch's 'tags' | 'sentence' | 'prose', or null without a branch.
//              tagLineStart: for sentence entries, where the tag line starts (just after the sentence).
//              valueStart: file offset of value offset 0 when they map 1:1, else null.
//              node: the yaml Scalar, used to write fixes.
// ParseProblem {kind: 'yaml' | 'brace' | 'expand' | 'anima', severity: 'error' | 'warn', message,
//               keyPath, line, col}
//
// Template nodes. Every node keeps its raw text, so renderTemplate(parseTemplate(v)) === v.
//   text      {raw}                 escapes such as `\(` kept exactly as written
//   group     {headerRaw, sampler?, flags?, select?: {min?, max?}, separator?, options, closed}
//             `{…|…}`; headerRaw is `~`, `@`, `2$$`, `1-3$$ and $$` … (often ''); flags are
//             prompt-postprocessor's `r` / `o`; closed is false when the input ended before `}`
//   option    {prefixRaw, weight?, body: nodes[]}   prefixRaw is a weight prefix such as `3::`
//   ref       {raw, name, glob, params?, filter?, vars?}   `__path/to/key__`, possibly a glob
//   lora      {raw, network, name, args}   `<lora:name:weight>` / `<lyco:…>`
//   variable  {raw}                 `${…}`, kept opaque

export {findAnimaTagLineStart} from './anima.js'
export {computeLineStarts, entryPosition, lineColAt} from './positions.js'
export {globToRegExp, resolveRef} from './refs.js'
export {countMaxTags, countMaxWords, DEFAULT_MAX_VARIATIONS, extractEntryTags, extractTags, findEmphasis} from './tags.js'
export {parseTemplate, renderTemplate, walkTemplate} from './template.js'
export {BRANCH_STYLES, DEFAULT_BRANCHES, parseWildcardFile, printWildcardFile, setEntryValue} from './yaml-file.js'
