// Which tags get validated ("lint the options, not the combinations"). Entries are copied
// verbatim from fixtures/danboru_class_prompter.yaml; synthetic only where the real file has no example.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  countMaxTags,
  entryPosition,
  extractEntryTags,
  extractTags,
  parseTemplate,
} from '../lib/wildcard-parser/index.js'
import {fixture, entryAtLine, tagTexts} from './wildcard-parser-helpers.js'

test('glued group (l.528): each option is checked with the text of its own tag', () => {
  const entry = entryAtLine(528)
  const tags = extractEntryTags(entry).tags
  assert.deepEqual(tags.map((t) => t.text).sort(), [
    'black hair',
    'blood on face',
    'fang',
    'gold hair',
    'hair',
    'pale skin',
    'red eyes',
    'red hair',
    'slit pupils',
    'vampire',
    'white hair',
  ])
  // Positions point at l.528: `gold hair` starts at `gold` and is glued from two pieces.
  const gold = tags.find((t) => t.text === 'gold hair')
  assert.equal(gold.glued, true)
  assert.equal(gold.spans.length, 2)
  assert.deepEqual(entryPosition(fixture, entry, gold.spans[0].start), {line: 528, col: 110})
  assert.equal(entry.value.slice(gold.spans[0].start, gold.spans[0].end), 'gold')
  assert.equal(entry.value.slice(gold.spans[1].start, gold.spans[1].end), ' hair')
  // the empty option leaves the bare noun, which is a tag of its own
  const hair = tags.find((t) => t.text === 'hair')
  assert.deepEqual(entryPosition(fixture, entry, hair.spans[0].start), {line: 528, col: 117})
})

test('groups whose options carry their own comma are checked option by option (l.396)', () => {
  const l396 =
    'knight, pauldrons, {{dark |}armor|plate_armor|full armor},{tattered cloth,|} sabaton, gauntlets, {cape,|} {breastplate,|} {ornate armor,|} {belt_buckle|}'
  assert.deepEqual(tagTexts(l396), [
    'armor',
    'belt_buckle',
    'breastplate',
    'cape',
    'dark armor',
    'full armor',
    'gauntlets',
    'knight',
    'ornate armor',
    'pauldrons',
    'plate_armor',
    'sabaton',
    'tattered cloth',
  ])
})

test('text glued before a group whose options start with a comma (l.108)', () => {
  assert.deepEqual(tagTexts('casting_spell, fire, fireball, explosion{, embers|, smoke|, glowing|}'), [
    'casting_spell',
    'embers',
    'explosion',
    'fire',
    'fireball',
    'glowing',
    'smoke',
  ])
})

test('a group glued to the text after it (l.325, l.331)', () => {
  assert.deepEqual(tagTexts('holding_staff, {mage|wooden}_staff, {crystal,|orb,|}'), [
    'crystal',
    'holding_staff',
    'mage_staff',
    'orb',
    'wooden_staff',
  ])
  assert.deepEqual(tagTexts('holding_staff, {mage_|}staff, skull, dark, {floating, glowing, glowing_eyes, }'), [
    'dark',
    'floating',
    'glowing',
    'glowing_eyes',
    'holding_staff',
    'mage_staff',
    'skull',
    'staff',
  ])
})

test('nested groups (l.329, l.403)', () => {
  // l.329 has no comma between `gem` and the group, so the model really sees `gem orb` and
  // `gem grimoire`: the glued rule exposes a missing comma in the library.
  assert.deepEqual(tagTexts('wand, ornate, gem {{orb,|grimoire, open_book,} floating|}'), [
    'floating',
    'gem',
    'gem grimoire',
    'gem orb',
    'open_book',
    'ornate',
    'wand',
  ])
  assert.deepEqual(
    tagTexts(
      'viking, chainmail, fur_collar, {armor|scale armor}, {{horned|} helmet|}, {leather gloves,|} {leather boots,|} {shoulder armor,|}, runes, tattoo, {fur cape,|} {belt_buckle,|}',
    ),
    [
      'armor',
      'belt_buckle',
      'chainmail',
      'fur cape',
      'fur_collar',
      'helmet',
      'horned helmet',
      'leather boots',
      'leather gloves',
      'runes',
      'scale armor',
      'shoulder armor',
      'tattoo',
      'viking',
    ],
  )
})

test('several glued groups in one tag expand into every variation', () => {
  assert.deepEqual(tagTexts('{long|short} {red|white} hair,'), [
    'long red hair',
    'long white hair',
    'short red hair',
    'short white hair',
  ])
})

test('more than 256 variations: reported, then checked option by option (synthetic)', () => {
  // four copies of the l.528 group glued to one noun: 5^4 = 625 variations
  const value =
    '{red|3::white|2::black|gold|} {red|3::white|2::black|gold|} {red|3::white|2::black|gold|} {red|3::white|2::black|gold|} hair'
  const {template} = parseTemplate(value)
  const result = extractTags(value, template)
  assert.deepEqual(result.overflows, [{offset: 0, count: 625}])
  const texts = new Set(result.tags.map((t) => t.text))
  assert.deepEqual([...texts].sort(), ['black', 'gold', 'hair', 'red', 'white'])
  // within the cap the same value is expanded fully
  assert.equal(extractTags(value, template, {maxVariations: 1000}).overflows.length, 0)
})

test('emphasis (l.679): the inner text is checked, the weight is kept', () => {
  const tags = extractEntryTags(entryAtLine(679)).tags
  const scar = tags.find((t) => t.text === 'scar_on_face')
  assert.equal(scar.emphasis, 1.15)
  assert.equal(tags.find((t) => t.text === 'messy_hair').emphasis, 1.1)
  assert.ok(!tags.some((t) => t.text.includes('(') || t.text.includes(':')))
})

test('emphasis spanning commas and groups (synthetic)', () => {
  const value = '(red_ribbon, {hair_bow|bow}:1.2), long_hair'
  const {template} = parseTemplate(value)
  const tags = extractTags(value, template).tags
  assert.deepEqual(
    tags.map((t) => [t.text, t.emphasis]),
    [
      ['red_ribbon', 1.2],
      ['hair_bow', 1.2],
      ['bow', 1.2],
      ['long_hair', undefined],
    ], // source order,
  )
})

test('an unescaped bow_(weapon) is kept as written (l.694); R5 is lint’s job', () => {
  const tags = extractEntryTags(entryAtLine(694)).tags
  assert.ok(tags.some((t) => t.text === 'bow_(weapon)'))
})

test('escaped parentheses stay in the tag text (l.312)', () => {
  assert.deepEqual(tagTexts('sword, jian \\(weapon\\)'), ['jian \\(weapon\\)', 'sword'])
})

test('references and empty options (l.581, l.630)', () => {
  const l581 = extractEntryTags(entryAtLine(581)).tags
  assert.deepEqual(
    l581.map((t) => [t.kind, t.ref?.name]),
    [
      ['ref', 'danboru-character-prompter/generic/apparel/archer'],
      ['ref', 'danboru-character-prompter/generic/meelee-weapons/medieval'],
      ['ref', 'danboru-character-prompter/generic/meelee-weapons/assassin'],
    ],
  )
  // l.630 ends in `{forest,| battlefield,| …| heaven||||}`: four empty options, no empty tags
  const l630 = extractEntryTags(entryAtLine(630)).tags
  assert.ok(l630.every((t) => t.text.trim() !== ''))
  assert.ok(l630.some((t) => t.text === 'heaven'))
})

test('empty options never produce empty tags anywhere in the real file', () => {
  for (const entry of fixture.entries) {
    for (const tag of extractEntryTags(entry).tags)
      assert.notEqual(tag.text.trim(), '', `${entry.keyPath}[${entry.index}]`)
  }
})

test('a ref glued to text is dynamic, a lora is pulled out of its tag (synthetic)', () => {
  const value = '__colors__ hair, <lora:detail_tweaker:0.8> long_hair'
  const {template} = parseTemplate(value)
  assert.deepEqual(
    extractTags(value, template).tags.map((t) => [t.kind, t.text]),
    [
      ['dynamic', '__colors__ hair'],
      ['lora', '<lora:detail_tweaker:0.8>'],
      ['tag', 'long_hair'],
    ],
  )
})

test('countMaxTags: the largest single expansion (real l.528 and l.630)', () => {
  // vampire, fang, red eyes + up to 3 optional + one `… hair`
  assert.equal(countMaxTags(entryAtLine(528)), 7)
  // refs count 1 each by default; lint passes a resolver that follows them
  // 14 plain tags (weapon, blood, …, one of each optional group) + 3 refs × 10
  assert.equal(countMaxTags(entryAtLine(630), {refTags: () => 10}), 44)
})
