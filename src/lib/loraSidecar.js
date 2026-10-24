// A LoRA's JSON sidecar (`<lora name>.json`, written by lora activation or by Forge itself) and the activation
// tags in it. lora activation puts them in its prompts, and wc config gathers them as tags lint accepts.

import fs from 'node:fs'
import path from 'node:path'

/** Fields that hold the activation tags, first found wins: Forge's and lora activation's, then other tools'. */
const TRIGGER_FIELDS = ['activation text', 'activationText', 'trainedWords', 'triggerWords']

/** Trigger words from a string or a list of strings, split on commas, trimmed, empty ones dropped. */
export function normalizeTriggers(value) {
  if (!value) return []
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)
}

const triggerField = (json) => TRIGGER_FIELDS.map((field) => json[field]).find((v) => v != null)

/** A sidecar's activation tags, split on commas (lora activation's prompts). */
export const sidecarTriggers = (json) => normalizeTriggers(triggerField(json))

/** A sidecar's activation text as one prompt string, a list joined with commas; '' when there is none. */
export function sidecarActivationText(json) {
  const value = triggerField(json)
  if (value == null) return ''
  return Array.isArray(value) ? value.map(String).join(', ') : String(value)
}

/**
 * The activation text of every sidecar in `dir` (and its subfolders with `recursive`): {sidecars, texts}, where a
 * sidecar is a JSON object with one of the trigger fields, even an empty one, and texts are [{file, text}] in the
 * order found, empty ones left out. Other JSON files and invalid JSON are skipped. The text is returned whole,
 * not split on commas, since it can hold wildcard syntax such as {2::a, b|c}.
 */
export function findSidecarActivations(dir, {recursive = false} = {}) {
  const names = fs.readdirSync(dir, {recursive}).filter((name) => name.toLowerCase().endsWith('.json'))
  let sidecars = 0
  const texts = []
  for (const name of names.sort()) {
    const file = path.join(dir, name)
    let json
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // a folder named *.json, or not JSON
    }

    if (json === null || typeof json !== 'object' || !TRIGGER_FIELDS.some((field) => field in json)) continue
    sidecars++
    const text = sidecarActivationText(json).trim()
    if (text) texts.push({file, text})
  }

  return {sidecars, texts}
}
