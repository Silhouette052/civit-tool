// A keyboard menu for the terminal (wc config, lora config, wc lint --calibrate): ↑/↓ move between rows, Enter acts
// on one, and a one-line input asks for text; runPicker builds a pick-several list on it. It runs on Node's keypress events in raw mode and redraws itself in place, so it needs no dependency.
// The streams are parameters, so the tests drive it with fake terminal streams.

import chalk from 'chalk'
import readline from 'node:readline'

const HIDE_CURSOR = '\u001B[?25l'
const SHOW_CURSOR = '\u001B[?25h'
const COLOR = /(\u001B\[[\d;]*m)/

/** `text` cut to `width` visible characters, ending in … when cut. Color codes don't count and are kept. */
export function truncate(text, width) {
  if ([...text.replaceAll(new RegExp(COLOR, 'g'), '')].length <= width) return text
  let out = ''
  let visible = 0
  for (const part of text.split(COLOR)) {
    if (COLOR.test(part)) {
      out += part
      continue
    }

    for (const char of part) {
      if (visible === width - 1) return `${out}…${out.includes('\u001B[') ? '\u001B[0m' : ''}`
      out += char
      visible++
    }
  }

  return out
}

/**
 * The rows to draw, {start, end}, when `count` rows may not fit in `height` lines. A window that scrolls keeps
 * two of its lines for the "more" markers, keeps the cursor in view, and moves as little as possible from `top`.
 */
export function viewport(count, cursor, height, top = 0) {
  if (count <= height) return {start: 0, end: count}
  const room = Math.max(1, height - 2)
  let start = Math.min(top, cursor)
  if (cursor >= start + room) start = cursor - room + 1
  start = Math.max(0, Math.min(start, count - room))
  return {start, end: start + room}
}

/**
 * Shows a menu until the user leaves with q, Esc or Ctrl+C, then clears it. `menu` has:
 *   rows()         the lines to draw, each {text, selectable, …}; called again after every key
 *   keys(row)      the key help shown under the menu for the row under the cursor (a line, or several)
 *   enter(row)     what Enter does on a row
 *   key(row, key)  any other key (optional)
 * enter and key return {message}, {error}, {ask: {prompt, submit(text)}}, {done: true} (which closes the menu) or
 * nothing, and submit returns {message} or {error}; an error they throw is shown as {error}. The terminal is always
 * put back (raw mode off, cursor shown).
 */
export function runMenu(menu, {input = process.stdin, output = process.stdout} = {}) {
  return new Promise((resolve, reject) => {
    const selectable = () =>
      menu
        .rows()
        .map((row, i) => (row.selectable ? i : -1))
        .filter((i) => i >= 0)
    let cursor = selectable()[0] ?? 0
    let top = 0
    let drawn = 0
    let status = null // {text, error}
    let asking = null // {prompt, submit, text}

    const clear = () => {
      if (drawn > 0) {
        readline.moveCursor(output, 0, -drawn)
        readline.cursorTo(output, 0)
        readline.clearScreenDown(output)
      }

      drawn = 0
    }

    const draw = () => {
      const rows = menu.rows()
      const footer = []
      if (asking) footer.push(`${asking.prompt}${asking.text}${chalk.inverse(' ')}`)
      const help = asking ? 'Enter save   Esc cancel   Ctrl+U clear' : menu.keys(rows[cursor])
      for (const line of [help].flat()) if (line) footer.push(chalk.gray(line))
      if (status) footer.push(status.error ? chalk.red(status.text) : chalk.green(status.text))

      // one spare line, so the terminal never scrolls the first line away
      const view = viewport(rows.length, cursor, (output.rows || Number.POSITIVE_INFINITY) - footer.length - 2, top)
      top = view.start
      const scrolls = view.end - view.start < rows.length
      const lines = []
      if (scrolls) lines.push(chalk.gray(view.start > 0 ? `  ↑ ${view.start} more` : ''))
      for (let i = view.start; i < view.end; i++) lines.push(`${i === cursor ? chalk.cyan('›') : ' '} ${rows[i].text}`)
      if (scrolls) lines.push(chalk.gray(view.end < rows.length ? `  ↓ ${rows.length - view.end} more` : ''))
      lines.push('', ...footer)

      clear()
      const width = Math.max(20, (output.columns || 80) - 1)
      output.write(lines.map((line) => truncate(line, width)).join('\n') + '\n')
      drawn = lines.length
    }

    const attempt = (action) => {
      try {
        return action()
      } catch (error) {
        return {error: error.message}
      }
    }

    // what enter or key returned: {done} closes the menu (true), anything else is shown
    const act = (result) => {
      if (!result?.done) return show(result)
      finish()
      return true
    }

    const show = (result) => {
      if (result?.ask) {
        asking = {...result.ask, text: ''}
        status = null
      } else if (result) {
        status = result.error ? {error: true, text: result.error} : {text: result.message}
      }
    }

    const move = (to) => {
      const stops = selectable()
      if (stops.length === 0) return
      if (to === 'first') cursor = stops[0]
      else if (to === 'last') cursor = stops.at(-1)
      else if (to < 0) cursor = stops.findLast((i) => i < cursor) ?? cursor
      else cursor = stops.find((i) => i > cursor) ?? cursor
    }

    const type = (sequence, key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        asking = null
        status = {text: 'Cancelled.'}
      } else if (key.name === 'return' || key.name === 'enter') {
        const {submit, text} = asking
        asking = null
        show(attempt(() => submit(text)))
      } else if (key.name === 'backspace') {
        asking.text = [...asking.text].slice(0, -1).join('')
      } else if (key.ctrl && key.name === 'u') {
        asking.text = ''
      } else if (sequence && !key.ctrl && !key.meta && !sequence.startsWith('\u001B') && sequence >= ' ') {
        asking.text += sequence
      }
    }

    const finish = (error) => {
      input.off('keypress', onKeypress)
      output.off('resize', onResize)
      process.off('exit', restore)
      clear()
      restore()
      input.pause()
      if (error) reject(error)
      else resolve()
    }

    function onKeypress(sequence, key = {}) {
      try {
        if (asking) {
          type(sequence, key)
        } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
          finish()
          return
        } else if (key.name === 'up' || key.name === 'down') {
          move(key.name === 'up' ? -1 : 1)
        } else if (key.name === 'home' || key.name === 'end') {
          move(key.name === 'home' ? 'first' : 'last')
        } else if (key.name === 'return' || key.name === 'enter') {
          if (act(attempt(() => menu.enter(menu.rows()[cursor])))) return
        } else if (menu.key) {
          if (act(attempt(() => menu.key(menu.rows()[cursor], key)))) return
        }

        draw()
      } catch (error) {
        finish(error)
      }
    }

    // a resize can rewrap what was drawn, so the frame is drawn again from the top of the screen
    function onResize() {
      readline.cursorTo(output, 0, 0)
      readline.clearScreenDown(output)
      drawn = 0
      draw()
    }

    function restore() {
      try {
        input.setRawMode?.(false)
      } catch {
        // the terminal is already gone
      }

      output.write(SHOW_CURSOR)
    }

    process.once('exit', restore)
    readline.emitKeypressEvents(input)
    input.setRawMode?.(true)
    input.on('keypress', onKeypress)
    output.on('resize', onResize)
    input.resume()
    output.write(HIDE_CURSOR)
    try {
      draw()
    } catch (error) {
      finish(error)
    }
  })
}

/**
 * A list to pick several rows from: Space selects the row under the cursor, a selects every row (or none when all
 * are), Enter accepts, q, Esc or Ctrl+C cancels. `items` are {text, help?, selected?}; `heading` goes above them.
 * Resolves to the indexes picked, in order, or null when cancelled.
 */
export async function runPicker(items, {heading, input, output} = {}) {
  const chosen = new Set(items.flatMap((item, i) => (item.selected ? [i] : [])))
  const top = heading ? [heading, ''].map((text) => ({selectable: false, text})) : []
  let accepted = false
  const menu = {
    rows: () => [
      ...top,
      ...items.map((item, i) => ({
        help: item.help,
        i,
        selectable: true,
        text: `${chosen.has(i) ? '[x]' : '[ ]'} ${item.text}`,
      })),
    ],
    keys: (row) => [row?.help ?? '', `↑/↓ move   Space select   a all/none   Enter accept ${chosen.size}   q cancel`],
    enter() {
      accepted = true
      return {done: true}
    },
    key(row, key) {
      if (key.name === 'space') {
        if (chosen.has(row.i)) chosen.delete(row.i)
        else chosen.add(row.i)
      } else if (key.name === 'a') {
        if (chosen.size === items.length) chosen.clear()
        else for (const i of items.keys()) chosen.add(i)
      }
    },
  }

  await runMenu(menu, {input, output})
  return accepted ? [...chosen].sort((a, b) => a - b) : null
}
