// Which LoRAs a folder of generated images used (img loras).
//
// Forge / A1111 write each LoRA twice into the "parameters" text: as `<lora:name:weight>` in the prompt (or
// `<lyco:…>`), and in the settings line as `Lora hashes: "name: hash, name: hash"`. The prompt tags give the
// weight; a name only in `Lora hashes` counts too, with an unknown weight.
//
// ComfyUI saves the graph that ran as JSON in a "prompt" text. A node with a `lora_name` input (LoraLoader,
// LoraLoaderModelOnly, …) or an input object {lora, on, strength} (rgthree's Power Lora Loader) is a LoRA; its
// name is the file name without folder and extension, as Forge writes it. Not yet checked against a real ComfyUI
// image with LoRAs.
//
// The same LoRA twice in one prompt (or two loaders of the same LoRA) is an error in the prompt: it is reported,
// and the image still counts once.

const LORA_TAG = /<(?:lora|lyco):([^:>]+)(?::([^:>]*))?(?::[^>]*)?>/gi

/** A LoRA file name as Forge writes it: no folder, no extension. */
const loraName = (file) =>
  file
    .split(/[\\/]/)
    .pop()
    .replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '')

const toWeight = (value) => {
  const n = Number(value)
  return value === undefined || value === '' || !Number.isFinite(n) ? null : n
}

/** Each `<lora:…>` in a prompt: {name, weight}; a missing weight is 1, as Forge reads it. */
function promptLoras(prompt) {
  return [...(prompt ?? '').matchAll(LORA_TAG)].map(([, name, weight]) => ({
    name: name.trim(),
    weight: weight === undefined ? 1 : toWeight(weight.trim()),
  }))
}

/** Names in `Lora hashes: "a: 1234abcd, b: 5678ef01"`. */
function hashLoras(settings) {
  const text = settings?.['Lora hashes']
  if (typeof text !== 'string') return []
  return text
    .split(',')
    .map((pair) => pair.slice(0, pair.lastIndexOf(':')).trim())
    .filter(Boolean)
    .map((name) => ({name, weight: null}))
}

/** LoRA loader nodes in a ComfyUI API "prompt" graph. */
function comfyLoras(text) {
  let graph
  try {
    graph = JSON.parse(text)
  } catch {
    return []
  }
  if (!graph || typeof graph !== 'object') return []
  const out = []
  for (const node of Object.values(graph)) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    if (typeof inputs.lora_name === 'string' && inputs.lora_name !== 'None') {
      out.push({name: loraName(inputs.lora_name), weight: toWeight(inputs.strength_model ?? inputs.strength)})
    }
    for (const value of Object.values(inputs)) {
      if (value && typeof value === 'object' && typeof value.lora === 'string' && value.on !== false) {
        out.push({name: loraName(value.lora), weight: toWeight(value.strength)})
      }
    }
  }
  return out
}

/** The same name (case-insensitive) more than once in a list: the names, as first written. */
function repeated(loras) {
  const seen = new Map()
  const twice = new Set()
  for (const {name} of loras) {
    const key = name.toLowerCase()
    if (seen.has(key)) twice.add(seen.get(key))
    else seen.set(key, name)
  }
  return [...twice]
}

/**
 * The LoRAs of one img meta entry: {loras: [{name, weight}], duplicates: [name]}. Each LoRA once (prompt first,
 * then negative prompt, then Lora hashes, then ComfyUI nodes); `duplicates` are the LoRAs written twice in one
 * prompt or loaded twice in one ComfyUI graph.
 */
export function extractLoras(entry) {
  const positive = promptLoras(entry.prompt)
  const negative = promptLoras(entry.negativePrompt)
  const comfy = typeof entry.other?.prompt === 'string' ? comfyLoras(entry.other.prompt) : []
  const duplicates = [...new Set([...repeated(positive), ...repeated(negative), ...repeated(comfy)])]

  const loras = new Map()
  for (const lora of [...positive, ...negative, ...hashLoras(entry.settings), ...comfy]) {
    const key = lora.name.toLowerCase()
    if (!loras.has(key)) loras.set(key, lora)
    else if (loras.get(key).weight === null && lora.weight !== null)
      loras.set(key, {...loras.get(key), weight: lora.weight})
  }
  return {loras: [...loras.values()], duplicates}
}

/**
 * Ranks the LoRAs of img meta entries by how many images use them.
 * Returns {ranking: [{name, images, weights: [{weight, count}]}], withLoras, duplicates: [{file, loras}]}.
 * Names are grouped case-insensitively and shown in their most common spelling; weights are sorted by count, and a
 * `null` weight means unknown (the LoRA was only in Lora hashes).
 */
export function rankLoras(entries) {
  const usage = new Map() // lowercase name → {spellings, images, weights}
  const duplicates = []
  let withLoras = 0
  for (const entry of entries) {
    const {loras, duplicates: twice} = extractLoras(entry)
    if (twice.length > 0) duplicates.push({file: entry.file, loras: twice})
    if (loras.length > 0) withLoras++
    for (const {name, weight} of loras) {
      const key = name.toLowerCase()
      if (!usage.has(key)) usage.set(key, {spellings: new Map(), images: 0, weights: new Map()})
      const u = usage.get(key)
      u.images++
      u.spellings.set(name, (u.spellings.get(name) ?? 0) + 1)
      u.weights.set(weight, (u.weights.get(weight) ?? 0) + 1)
    }
  }

  const byCount = (a, b) => b[1] - a[1]
  const ranking = [...usage.values()]
    .map((u) => ({
      name: [...u.spellings].sort(byCount)[0][0],
      images: u.images,
      weights: [...u.weights]
        .sort((a, b) => b[1] - a[1] || (a[0] ?? Infinity) - (b[0] ?? Infinity))
        .map(([weight, count]) => ({weight, count})),
    }))
    .sort((a, b) => b.images - a.images || a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}))
  return {ranking, withLoras, duplicates}
}

/** `1 ×40, 0.8 ×2`; an unknown weight is `?`. */
export const formatWeights = (weights) => weights.map(({weight, count}) => `${weight ?? '?'} ×${count}`).join(', ')
