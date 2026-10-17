// Generic family folders for Civitai base models (the "sd version" of an activation sidecar), used by
// `lora activation` to sort a folder of mixed LoRAs. Civitai names each model version ("Flux.2 Klein 9B",
// "Wan Video 2.2 T2V-A14B"), so the patterns match the start of the name. Forge's own sidecars use
// "SD1" / "SDXL", which match too. First match wins.
const BASE_MODEL_FOLDERS = [
  ['illustrious', /^(illustrious|noobai)/i],
  ['pony', /^pony/i],
  ['anima', /^anima/i],
  ['krea', /^krea/i],
  ['flux', /^flux\.?1/i],
  ['flux2', /^flux\.?2/i],
  ['sdxl', /^sdxl/i],
  ['sd15', /^sd ?1/i],
  ['sd2', /^sd ?2/i],
  ['sd3', /^sd ?3/i],
  ['zimage', /^z ?image/i],
  ['qwen', /^qwen/i],
  ['wan', /^wan/i],
  ['hunyuan', /^hunyuan/i],
  ['ltxv', /^ltxv/i],
  ['chroma', /^chroma/i],
  ['hidream', /^hidream/i],
  ['lumina', /^lumina/i],
  ['kolors', /^kolors/i],
  ['pixart', /^pixart/i],
  ['auraflow', /^auraflow/i],
]

/** The family folder for a base model, e.g. "NoobAI" → "illustrious"; null when unknown ("Other", "Unknown", unlisted). */
export function baseModelFolder(baseModel) {
  if (typeof baseModel !== 'string') return null
  const name = baseModel.trim()
  return BASE_MODEL_FOLDERS.find(([, pattern]) => pattern.test(name))?.[0] ?? null
}
