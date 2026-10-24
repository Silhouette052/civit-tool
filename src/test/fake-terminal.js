// A fake terminal for the keyboard menu tests: streams that say they are a TTY, raw mode recorded, and keys
// written as the bytes a terminal sends.

import {PassThrough} from 'node:stream'
import {setImmediate as tick} from 'node:timers/promises'

export const KEYS = {down: '\u001B[B', end: '\u001B[F', enter: '\r', home: '\u001B[H', up: '\u001B[A'}

export function fakeTerminal({columns = 100, rows = 40} = {}) {
  const input = new PassThrough()
  input.isTTY = true
  const raw = []
  input.setRawMode = (on) => {
    raw.push(on)
    return input
  }

  const output = new PassThrough()
  Object.assign(output, {columns, isTTY: true, rows})
  let written = ''
  output.on('data', (chunk) => {
    written += chunk
  })

  return {
    input,
    output,
    raw,
    /** Sends keys one at a time, each handled before the next. */
    async press(...keys) {
      for (const key of keys) {
        input.write(key)
        await tick()
      }
    },
    /** Every frame drawn so far, without color and cursor codes: each redraw starts by clearing the screen down. */
    frames: () => written.split('\u001B[0J').map((frame) => frame.replaceAll(/\u001B\[[\d;?]*[A-Za-z]/g, '')),
    written: () => written,
  }
}
