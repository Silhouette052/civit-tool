// The keyboard menu behind wc config: drawing, moving, the one-line input, scrolling, and putting the terminal back.

import assert from 'node:assert/strict'
import {test} from 'node:test'

import {runMenu, truncate, viewport} from '../lib/terminalMenu.js'
import {fakeTerminal, KEYS} from './fake-terminal.js'

test('truncate cuts to the visible width, keeping color codes and closing them', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('exactly10!', 10), 'exactly10!')
  assert.equal(truncate('a longer line', 8), 'a longe…')
  assert.equal(truncate('\u001B[32mgreen\u001B[39m text here', 8), '\u001B[32mgreen\u001B[39m t…\u001B[0m')
})

test('viewport keeps the cursor in view and moves as little as possible', () => {
  assert.deepEqual(viewport(5, 4, 10), {start: 0, end: 5})
  // 20 rows in 7 lines: 5 rows, 2 lines for the markers
  assert.deepEqual(viewport(20, 0, 7), {start: 0, end: 5})
  assert.deepEqual(viewport(20, 6, 7, 0), {start: 2, end: 7})
  assert.deepEqual(viewport(20, 4, 7, 2), {start: 2, end: 7})
  assert.deepEqual(viewport(20, 1, 7, 2), {start: 1, end: 6})
  assert.deepEqual(viewport(20, 19, 7, 0), {start: 15, end: 20})
})

/** A menu of a heading and three rows; Enter on b asks for text, on c throws. */
function sampleMenu(log) {
  return {
    rows: () => [
      {selectable: false, text: 'Heading'},
      {name: 'a', selectable: true, text: 'row a'},
      {name: 'b', selectable: true, text: 'row b'},
      {selectable: false, text: ''},
      {name: 'c', selectable: true, text: 'row c'},
    ],
    keys: (row) => `keys for ${row.name}`,
    enter(row) {
      if (row.name === 'a') return {message: 'did a'}
      if (row.name === 'c') throw new Error('c failed')
      return {ask: {prompt: 'Name: ', submit: (text) => (log.push(text), {message: `got ${text}`})}}
    },
    key: (row, key) => (key.name === 'x' ? {message: `x on ${row.name}`} : undefined),
  }
}

test('runMenu: moves past rows that cannot be chosen, acts on Enter, and asks for text', async () => {
  const log = []
  const term = fakeTerminal()
  const done = runMenu(sampleMenu(log), term)
  await term.press(KEYS.enter)
  assert.match(term.frames().at(-1), /› row a\n.*\n\nkeys for a\ndid a\n$/s)

  // down skips the blank row between b and c; down at the end stays
  await term.press(KEYS.down, KEYS.down, KEYS.down, 'x')
  assert.match(term.frames().at(-1), /› row c\n\nkeys for c\nx on c\n$/)
  await term.press(KEYS.enter)
  assert.match(term.frames().at(-1), /\nc failed\n$/)

  // the input: typed and pasted text, Backspace, Ctrl+U; Enter hands it over
  await term.press(KEYS.up, KEYS.enter, 'D:\\old', '\u0015', 'D:\\Forge', '\u007F', 'e', KEYS.enter)
  assert.deepEqual(log, ['D:\\Forge'])
  assert.match(term.frames().at(-1), /› row b\n.*keys for b\ngot D:\\Forge\n$/s)

  // Esc leaves the input without submitting (it waits for more of an escape sequence first)
  await term.press(KEYS.enter, 'abc', '\u001B')
  await new Promise((resolve) => {
    setTimeout(resolve, 600)
  })
  assert.match(term.frames().at(-1), /\nCancelled\.\n$/)
  assert.deepEqual(log, ['D:\\Forge'])

  await term.press('q')
  await done
  // the menu is cleared, raw mode is off again and the cursor is shown
  assert.deepEqual(term.raw, [true, false])
  assert.ok(term.written().endsWith('\u001B[0J\u001B[?25h'), JSON.stringify(term.written().slice(-30)))
})

test('runMenu scrolls a list taller than the terminal, with "more" markers', async () => {
  const rows = Array.from({length: 30}, (_, i) => ({selectable: true, text: `row ${i}`}))
  const term = fakeTerminal({rows: 10})
  const done = runMenu({enter: () => {}, keys: () => 'keys', rows: () => rows}, term)
  await term.press(KEYS.end)
  // 10 lines: 1 spare, the blank line and the key help leave 7, of which 2 are markers
  assert.match(term.frames().at(-1), /^ {2}↑ 25 more\n {2}row 25\n.*\n› row 29\n\n\nkeys\n$/s)
  await term.press(KEYS.home)
  assert.match(term.frames().at(-1), /^\n› row 0\n.*row 4\n {2}↓ 25 more\n/s)
  await term.press('q')
  await done
})
