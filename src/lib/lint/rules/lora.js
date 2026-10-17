// S-base: a LoRA only works with the base model it was trained for.
//
// - Under a shared branch (`simple:`) a LoRA is always wrong: shared entries must work with every model.
// - Under any other branch (`ill:`, `anima:`, `krea:` …), the civit-tool sidecar `<lora name>.json` says
//   which base model the LoRA is for (`"sd version"`, Civitai's baseModel). It must be one of the
//   branch's `baseModels`. Without `loraDirs` configured, without a sidecar for that LoRA, or for a
//   branch without `baseModels`, this part is skipped.

import {readdirSync, readFileSync, existsSync} from 'node:fs'
import {join, basename} from 'node:path'

/** Lora name (lowercase) → `sd version` from its sidecar, for every `*.json` under the folders. */
export function loadSidecars(dirs) {
  const versions = new Map()
  for (const dir of dirs) {
    if (!existsSync(dir)) throw new Error(`loraDirs: folder not found: ${dir}`)
    for (const rel of readdirSync(dir, {recursive: true})) {
      if (!rel.endsWith('.json')) continue
      try {
        const json = JSON.parse(readFileSync(join(dir, rel), 'utf8'))
        if (typeof json['sd version'] === 'string')
          versions.set(basename(rel, '.json').toLowerCase(), json['sd version'])
      } catch {
        // not a sidecar (or not valid JSON): ignore
      }
    }
  }
  return versions
}

export function checkLoraBase(ctx, sidecars) {
  const branch = ctx.entry.branch
  if (branch === null) return // no branch: S-branch reports it
  const branches = ctx.config.branches
  const def = branches[branch]
  for (const tag of ctx.extracted.tags) {
    if (tag.kind !== 'lora' || !tag.lora) continue
    const at = tag.spans[0].start
    if (def.shared) {
      const targets = Object.keys(branches)
        .filter((b) => !branches[b].shared)
        .map((b) => b + ':')
      const where = targets.length > 1 ? `${targets.slice(0, -1).join(', ')} or ${targets.at(-1)}` : targets[0]
      ctx.report(
        'S-base',
        at,
        `${tag.text} under ${branch}: a LoRA works with one base model only; move it under ${where}`,
      )
      continue
    }
    const accepted = def.baseModels ?? []
    if (accepted.length === 0) continue
    const version = sidecars.get(basename(tag.lora.name).toLowerCase())
    if (version === undefined) continue
    if (!accepted.some((a) => a.toLowerCase() === version.toLowerCase())) {
      ctx.report(
        'S-base',
        at,
        `${tag.text} is a "${version}" LoRA, but it is under ${branch}: (accepts ${accepted.join(', ')})`,
      )
    }
  }
}
