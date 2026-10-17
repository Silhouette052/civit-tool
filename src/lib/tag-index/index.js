// Public API of the tag index: other modules import only from this file.
// Loads danbooru.csv + aliases.local.csv into an in-memory index with lookup().
//
// Only what lint uses: no slot taxonomy (tags_extended.csv), no suggest().

export {parseAliasOverrides, loadAliasOverrides} from './aliases-local.js'
export {parseCsvLine, parseDanbooruCsv, loadDanbooruCsv} from './csv.js'
export {boundedEditDistance} from './edit-distance.js'
export {escapeTag, normalizeTag} from './normalize.js'
export {DEFAULT_MIN_COUNT, loadTagIndex, TagIndex} from './tag-index.js'
export {TypoIndex} from './typo-index.js'
