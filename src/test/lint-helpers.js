// A small TagIndex built from real danbooru.csv rows (copied verbatim, 2026-10-02), so the rule
// tests run without the gitignored full CSV. Plus a helper to lint a YAML string.

import {TagIndex, parseDanbooruCsv, parseAliasOverrides} from '../lib/tag-index/index.js'
import {parseWildcardFile} from '../lib/wildcard-parser/index.js'
import {lintFiles, DEFAULT_CONFIG} from '../lib/lint/index.js'

const REAL_ROWS = [
  '1girl,0,6008644,"1girls,sole_female"',
  'long_hair,0,4350743,"/lh,longhair"',
  'blonde_hair,0,1537942,"blond,blonde,/blondeh,blondehair,blond_hair,gold_hair,yellow_hair"',
  'black_hair,0,1504581,"/blackh,black-hair,blackhair,dark_hair"',
  'thighhighs,0,1166845,"naked_thighhighs,nude_thighhighs,stocking,stockings,/t,thighhgihs,thighhigh,thigh_highs,thighhighs_only,thighhigs,thighighs"',
  'white_hair,0,703094,whitehair',
  'red_hair,0,520146,"/redh,redhair,red_head,redhead"',
  'horns,0,461941,',
  'sword,0,274858,swords',
  'star_(symbol),0,237573,',
  'armor,0,210293,armour',
  'high_heels,0,199327,"heels,highheels"',
  'red_ribbon,0,180869,',
  'chain,0,103750,chains',
  'helmet,0,78520,',
  'single_thighhigh,0,57134,"one_thighhigh,thighhigh"',
  '@_@,0,35040,"al_bhed_eyes,spiral_eyes,swirly_eyes"',
  'waving,0,26502,wave',
  'bow_(weapon),0,24109,bow_and_arrow',
  'arrow_(projectile),0,19398,arrows',
  'bikini_armor,0,9673,',
  'waves,0,7382,',
  'club_(weapon),0,3780,club',
  'tall_female,0,3516,',
  'j@ck,1,473,',
  'zwei_(rwby),4,95,',
].join('\n')

// The committed data/aliases.local.csv
const REAL_ALIASES_LOCAL = 'alias,tag\narmored_bikini,bikini_armor\ntall_woman,tall_female\n'

export const index = new TagIndex(parseDanbooruCsv(REAL_ROWS), parseAliasOverrides(REAL_ALIASES_LOCAL))

/** Lint one or more YAML strings as one library (file names test-0.yaml, test-1.yaml, …). */
export function lintYaml(sources, config = {}, tagIndex = index) {
  const full = {...DEFAULT_CONFIG, ...config}
  const files = (Array.isArray(sources) ? sources : [sources]).map((s, i) =>
    parseWildcardFile(s, {path: `test-${i}.yaml`, branches: full.branches}),
  )
  return lintFiles(files, tagIndex, full)
}

/** [rule, message] pairs, the compact form most tests compare. */
export function brief(result) {
  return result.findings.map((f) => [f.rule, f.message])
}

export function rules(result) {
  return result.findings.map((f) => f.rule)
}

export function only(result, rule) {
  return result.findings.filter((f) => f.rule === rule)
}
