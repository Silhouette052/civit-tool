// Template syntax on entries copied verbatim from fixtures/danboru_class_prompter.yaml (line numbers
// cited), plus synthetic cases for syntax the file doesn't use yet (from the extensions' docs).

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseTemplate, renderTemplate, walkTemplate} from '../lib/wildcard-parser/index.js'

const groups = (value) => [...walkTemplate(parseTemplate(value).template)].filter((n) => n.type === 'group')

test('nested variants (l.329, l.396, l.403)', () => {
  const l329 = 'wand, ornate, gem {{orb,|grimoire, open_book,} floating|}'
  const [outer, inner] = groups(l329)
  assert.equal(outer.options.length, 2)
  assert.equal(inner.options.length, 2)
  assert.equal(renderTemplate(outer.options[0].body), '{orb,|grimoire, open_book,} floating')
  assert.equal(renderTemplate(outer.options[1].body), '') // empty option

  const l403 =
    'viking, chainmail, fur_collar, {armor|scale armor}, {{horned|} helmet|}, {leather gloves,|} {leather boots,|} {shoulder armor,|}, runes, tattoo, {fur cape,|} {belt_buckle,|}'
  assert.equal(groups(l403).length, 8)
  const l396 =
    'knight, pauldrons, {{dark |}armor|plate_armor|full armor},{tattered cloth,|} sabaton, gauntlets, {cape,|} {breastplate,|} {ornate armor,|} {belt_buckle|}'
  assert.deepEqual(parseTemplate(l396).problems, [])
})

test('weights, including an empty weighted option (l.528, l.581)', () => {
  const l528 =
    'vampire, fang, red eyes, {pale skin,|} {slit pupils,|} {blood on face,|}, {red|3::white|2::black|gold|} hair,'
  const hair = groups(l528)[3]
  assert.deepEqual(
    hair.options.map((o) => [o.weight, renderTemplate(o.body)]),
    [
      [undefined, 'red'],
      [3, 'white'],
      [2, 'black'],
      [undefined, 'gold'],
      [undefined, ''],
    ],
  )
  const l581 =
    '__danboru-character-prompter/generic/apparel/archer__, {__danboru-character-prompter/generic/meelee-weapons/medieval__|__danboru-character-prompter/generic/meelee-weapons/assassin__|3::}'
  const last = groups(l581)[0].options[2]
  assert.equal(last.weight, 3)
  assert.deepEqual(last.body, [])
})

test('references, globs and refs inside options (l.630)', () => {
  const l630 =
    'weapon, blood, blood on clothes, blood on weapon, holding weapon, {spot color|}, solo, {1girl, __danboru-character-prompter/generic/body-type/female__|1boy, __danboru-character-prompter/generic/body-type/male__}, __danboru-character-prompter/generic/races/*__, __danboru-character-prompter/generic/class-prompter/any__, exhausted, after battle, fantasy, {forest,| battlefield,| ruins,| dungeon,| hell,| heaven||||}, {glowing eyes,|}, {spot color|}'
  const refs = [...walkTemplate(parseTemplate(l630).template)].filter((n) => n.type === 'ref')
  assert.deepEqual(
    refs.map((r) => [r.name, r.glob]),
    [
      ['danboru-character-prompter/generic/body-type/female', false],
      ['danboru-character-prompter/generic/body-type/male', false],
      ['danboru-character-prompter/generic/races/*', true],
      ['danboru-character-prompter/generic/class-prompter/any', false],
    ],
  )
})

test('escapes are literal text, never syntax (l.312)', () => {
  const {template} = parseTemplate('sword, jian \\(weapon\\)')
  assert.deepEqual(template, [{type: 'text', raw: 'sword, jian \\(weapon\\)', start: 0, end: 22}])
  const escapedBrace = parseTemplate('a \\{b|c\\}')
  assert.equal(escapedBrace.template.length, 1)
  assert.deepEqual(escapedBrace.problems, [])
})

test('selection, samplers and separators (synthetic, from the extensions docs)', () => {
  const [g] = groups('{2$$chocolate|vanilla|strawberry}')
  assert.deepEqual(g.select, {min: 2, max: 2})
  assert.equal(g.options.length, 3)
  assert.deepEqual(groups('{1-2$$ and $$chocolate|vanilla}')[0].select, {min: 1, max: 2})
  assert.equal(groups('{1-2$$ and $$chocolate|vanilla}')[0].separator, ' and ')
  assert.deepEqual(groups('{-2$$a|b|c}')[0].select, {max: 2})
  assert.deepEqual(groups('{1-$$a|b|c}')[0].select, {min: 1})
  assert.equal(groups('{~red|green}')[0].sampler, '~')
  assert.equal(groups('{@red|green}')[0].sampler, '@')
  assert.equal(groups('{ro2$$a|b}')[0].flags, 'ro')
  // `r` and `o` at the start of a normal option are just text
  assert.equal(groups('{red|orange}')[0].headerRaw, '')
  for (const v of [
    '{2$$chocolate|vanilla|strawberry}',
    '{1-2$$ and $$chocolate|vanilla}',
    '{~red|green}',
    '{ro2$$a|b}',
  ]) {
    assert.equal(renderTemplate(parseTemplate(v).template), v)
  }
})

test('loras, variables and prompt-postprocessor ref extras (synthetic)', () => {
  const {template} = parseTemplate(
    "<lora:detail_tweaker:0.8>, ${season=!{summer|winter}}, __2$$colors'warm'(tone=dark)__",
  )
  const nodes = [...walkTemplate(template)]
  const lora = nodes.find((n) => n.type === 'lora')
  assert.deepEqual(lora && {name: lora.name, args: lora.args}, {name: 'detail_tweaker', args: ['0.8']})
  assert.ok(nodes.some((n) => n.type === 'variable' && n.raw === '${season=!{summer|winter}}'))
  const ref = nodes.find((n) => n.type === 'ref')
  assert.deepEqual([ref.params, ref.name, ref.filter, ref.vars], ['2', 'colors', 'warm', 'tone=dark'])
})

test('unbalanced braces are reported with their offset, and parsing goes on', () => {
  // l.528 with the closing `}` of the hair group deleted
  const broken =
    'vampire, fang, red eyes, {pale skin,|} {slit pupils,|} {blood on face,|}, {red|3::white|2::black|gold| hair,'
  const {template, problems} = parseTemplate(broken)
  assert.deepEqual(problems, [{message: 'unclosed "{"', offset: broken.indexOf('{red')}])
  assert.equal(renderTemplate(template), broken)

  const stray = 'vampire, fang}, red eyes'
  assert.deepEqual(parseTemplate(stray).problems, [{message: 'unmatched "}"', offset: 13}])
  assert.equal(renderTemplate(parseTemplate(stray).template), stray)
})

test('things that look like refs but are not stay text', () => {
  for (const v of ['^_^', '>_<', 'a __ b', '__not closed']) {
    assert.ok(
      parseTemplate(v).template.every((n) => n.type === 'text'),
      v,
    )
  }
})
