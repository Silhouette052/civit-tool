# civit-tool

A command-line helper for Forge and A1111 users. It fills in your LoRAs' trigger words and weights from Civitai, checks and expands Dynamic Prompts wildcard files, and sorts and reads your generated images.

Commands are grouped by what they work on, like `aws s3 cp`: `civit-tool <group> <command>`. `civit-tool <group>` alone lists that group's commands, and every command takes `--help`.

| Command | What it does |
|---|---|
| **`lora`**: LoRA files | |
| [`lora activation`](#civit-tool-lora-activation-path) | trigger words and preferred weight from Civitai into a JSON sidecar per LoRA, plus a `loras.yaml` wildcard file and an X/Y/Z plot values line; offers to fix problem names and to sort a mixed folder by base model |
| [`lora url`](#civit-tool-lora-url-path) | the Civitai page and creator of every LoRA in a folder |
| [`lora duplicates`](#civit-tool-lora-duplicates-path) | finds identical `.safetensors` files, then asks which copy to keep |
| [`lora config`](#civit-tool-lora-config) | the LoRA settings: Civitai site, warn characters, base model sort offer, LoRA list file |
| **`wc`**: wildcard YAML files | |
| [`wc expand`](#civit-tool-wc-expand-file-wildcard) | every prompt a wildcard path can produce, written to a text file |
| [`wc sort`](#civit-tool-wc-sort-file-path) | sorts the keys of a wildcard YAML file by name under a path |
| [`wc lint`](#civit-tool-wc-lint-path) | checks tags against Danbooru, plus escaping, structure and LoRA base models; prose rules for Krea 2 |
| [`wc repeats`](#civit-tool-wc-repeats-path) | finds repeated phrases and tag runs that could move into a shared leaf |
| [`wc config`](#civit-tool-wc-config) | the wildcard settings: the `danbooru.csv` folder, the wildcards folder, lint's rules and limits, exempt keys, and accepted tags such as LoRA activation tags |
| **`img`**: generated images | |
| [`img sort`](#civit-tool-img-sort-path) | sorts generated images into one folder per model |
| [`img meta`](#civit-tool-img-meta-path) | the generation metadata of a folder's images as JSON, or just the prompts |
| [`img loras`](#civit-tool-img-loras-path) | ranks the LoRAs a folder of images used, with their weights |
| [`img config`](#civit-tool-img-config) | Forge's filename pattern and ascending number, so `img sort` can read your file names |
| **`file`**: bulk file operations | |
| [`file rename`](#civit-tool-file-rename-path) | renames files by find/replace, or numbers them in sequence |

## Install

You need [Node.js](https://nodejs.org) 18.17 or newer. Put this folder somewhere permanent, then run in it:

```bash
npm install
npm link
```

`civit-tool` is now a command you can run from any folder. `npm link` points at this folder, so moving or deleting it breaks the command. To uninstall, run `npm unlink -g civit-tool` and delete the folder.

## Autocomplete

```bash
civit-tool autocomplete
```

This prints the install command for your shell (bash, zsh, or PowerShell). Run the one it gives you, restart your shell, and `civit-tool <TAB>` will complete groups, commands and flags. After an update that adds or moves commands, run `civit-tool autocomplete --refresh-cache`.

**PowerShell note:** the generated PowerShell completion script uses PowerShell 7+ syntax (`?:`, `??`). It will throw parse errors on every startup if installed into Windows PowerShell 5.1's profile (the default `powershell.exe`). Install it from a **pwsh** (PowerShell 7) session instead — it has its own separate `$PROFILE`, so this won't touch or break your 5.1 profile.

## Config

Every setting is optional. Each group's `config` command shows and changes its settings without editing JSON: [`lora config`](#civit-tool-lora-config), [`wc config`](#civit-tool-wc-config) and [`img config`](#civit-tool-img-config). They save to `~/.civit-tool.config.json` in your home folder. A `civit-tool.config.json` in the current folder overrides it, merged key by key within each section (`activation`, `lint`, `img`). `civit-tool.config.json.example` shows the layout:

```json
{
  "domain": "civitai.red",
  "wildcardsDir": "path/to/forge/extensions/sd-dynamic-prompts/wildcards"
}
```

| Key | Set with | What it is |
|---|---|---|
| `domain` | `lora config` | the Civitai site LoRAs are looked up on first; default `civitai.red` (see below) |
| `warnChars` | `lora config` | the characters `lora activation` warns about in LoRA names |
| `activation` | `lora config` | `sortBaseModels` and `yamlName`, for `lora activation` |
| `wildcardsDir` | `wc config` | where `wc expand`, `wc sort` and `wc lint` look for a bare file name, and what `wc lint` checks when given no path |
| `lint` | `wc config` | `wc lint`'s settings, described under [`wc lint`](#civit-tool-wc-lint-path) |
| `img` | `img config` | `filenamePattern` and `addNumber`, for `img sort` |

**Civitai domains:** civitai.red and civitai.com serve the same API, but a LoRA can be visible on one and not the other. `lora url` and `lora activation` look each LoRA up on `domain` first, and on the other domain when the first doesn't know it (any error: 404, refused, network). Links, in `lora url`'s output and in the sidecar's `"civitai url"`, point to the domain that had the LoRA, and the sidecar's `"civitai lookup"` names it. `--domain` overrides the setting for one run; `--domain civitai.com` tries civitai.com first.

## API token (optional)

```bash
export CIVITAI_API_TOKEN=xxxxxxxx     # macOS/Linux
setx CIVITAI_API_TOKEN xxxxxxxx       # Windows
```

Used automatically by `lora url` and `lora activation` if set.

## lora

`.safetensors` LoRA files, their JSON sidecars and Civitai lookups.

### `civit-tool lora activation PATH`

For every `.safetensors` in a folder (top-level only): uses the JSON sidecar if one exists, otherwise resolves trigger words + weight from Civitai and creates it. Always (re)writes `loras.yaml` (or the name set with [`lora config`](#civit-tool-lora-config)) from every sidecar found.

```bash
civit-tool lora activation ./loras
civit-tool lora activation ./loras --yaml-name my-wildcards.yaml   # this run; lora config saves a default
civit-tool lora activation ./loras --refresh   # re-resolve + overwrite every sidecar, even existing ones
civit-tool lora activation ./loras --xyz       # print only the X/Y/Z plot values line
civit-tool lora activation ./loras --fix-names # rename problem names without asking
civit-tool lora activation ./loras --skip-sort-base     # don't offer the base model sort this run
```

**Problem names:** before anything else, `lora activation` lists every LoRA whose name has `__` or a character from the warn list, and asks whether to rename it:

- `__`: Dynamic Prompts reads it as the start of a wildcard reference, so a `<lora:my__style:1>` tag can be misread in wildcard files. Each run of underscores becomes one `_` (`my__style` → `my_style`).
- **Warn characters** (default `@` and `&`): they are removed from the name, then doubled underscores and spaces are tidied (`Rock & Roll` → `Rock Roll`, `Iter@L1nes` → `IterL1nes`). A name made only of them can't be renamed and is just reported.
- The list is a setting: `civit-tool lora config --warn-chars "@&#"` (or its menu) replaces it for every run, and `none` turns the warning off. A `warnChars` in the project's `./civit-tool.config.json` wins over the saved one.

Files with the same name are renamed along with the LoRA: the JSON sidecar, `.preview.png`, `.civitai.info` and so on. A LoRA whose new name is already taken is left alone, as in `file rename`. Answering no keeps the names and carries on. `--fix-names` renames without asking. Wildcard files that use the old names need updating by hand.

**Sorting by base model:** when the folder holds LoRAs for more than one base model, `lora activation` offers to move each into a folder named after its model family. It runs after the sidecars are written and reads their `"sd version"`. The families are generic, not the exact checkpoint: `illustrious` (Illustrious and NoobAI), `pony` (every Pony version), `anima`, `krea`, `flux` (Flux.1), `flux2`, `sdxl`, `sd15`, `sd2`, `sd3`, `zimage`, `qwen`, `wan`, `hunyuan`, `ltxv`, `chroma`, `hidream`, `lumina`, `kolors`, `pixart`, `auraflow` (`src/lib/baseModels.js`).

- **Preview first:** every family folder (new or existing) with the LoRAs going there, the Civitai base model in brackets when it differs from the folder name (`[NoobAI]`), then `Sort N LoRA(s) into base model folders? [y/N]`.
- **One family only:** nothing is offered.
- **Moved with the LoRA:** every file named after it, as for the name fixes. `loras.yaml` stays.
- **Left where they are, with a WARNING:** LoRAs without a sidecar (the Civitai lookup failed) and those whose base model is `Other`, `Unknown` or not in the list.
- **Nothing is overwritten:** a LoRA whose file already exists in the target folder stays, marked `can't move`.
- **`--skip-sort-base`** skips the step for one run; `civit-tool lora config --sort-base off` turns the offer off for good. With `--xyz` the preview and the question go to stderr.
- `<lora:…>` tags keep working, since Forge finds LoRAs in subfolders by name. `loras.yaml` lists the moved LoRAs too; but `lora activation` reads only the folder's top level, so a later run on the same folder no longer sees them.

The last line of the output is every LoRA's prompt (the `loras.yaml` lines) in double quotes, separated by commas, ready to paste as the X values of an X/Y/Z plot with X type **Prompt S/R**:

```
"<lora:CastlevaniaTV-ANIMA:1>, cv4n14-style,","<lora:Dawnmap Anima:1>, medieval,","<lora:IterL1nesV2:1>, @iterl1nes,"
```

`--xyz` prints only that line, so it can be copied or piped (`civit-tool lora activation ./loras --xyz | clip` on Windows). The sidecars and `loras.yaml` are still created or updated as usual; problems go to stderr.

**Where the preferred weight comes from**, in priority order:

1. **Civitai "Usage Tips" settings** (`settings.strength` / `minStrength` / `maxStrength`). These are only exposed by Civitai's internal tRPC API, which is unofficial and may change, so any failure there silently falls through to the next step. If the author only set min/max, the midpoint is used.
   - Exception: a bare `strength: 1` with no min/max is usually just the upload form's default. If the description text has a hint, that hint wins, and the console prints a `NOTE` line.
2. **Free text** in the model-*version* description, then the full *model* description, then the version's `notes`, read as plain text without their HTML. Phrasings like "Strength: 0.8", "recommended to be 0.4~0.6", "use at 0.7 strength", "I recommend starting in the 0.8 - 1 range", "weight between [0.8,1]" and "I prefer 0.9" are recognised. Values above 2 are ignored, as are numbers next to CFG, steps or version names.
3. **A hardcoded default of `1`**, with a `WARNING` line in the console.

Ranges always resolve to their **midpoint**: 0.4~0.6 → 0.5. Each sidecar records:
- `"preferred weight source"`: where the weight came from, such as `civitai settings (usage tips)`, `model description` or `default (not found)`
- `"preferred weight min"` / `"preferred weight max"`, when a range is known

Use `--refresh` to recompute this for LoRAs that already have a JSON sidecar. Refresh replaces only Civitai-derived fields and keeps your non-empty `notes`, `negative text` and `activation text`.

**`notes` link to the model's Civitai page,** e.g. `https://civitai.red/models/3017367/ashley-wood` (on the domain that had the LoRA; the name part is the slug Civitai makes from the model name), so the link shows in the LoRA card's **Edit metadata** dialog. A new sidecar gets it as its notes. `--refresh` adds it on its own line after your notes, unless they link to that model already; sidecars that aren't refreshed are left as they are.

**The sidecar is also read by `wc lint`**. Its rule `S-base` checks that a `<lora:…>` sits under the right model branch (`ill:`, `anima:`, `krea:`, …). It relies on exactly this:

| What | Contract |
|---|---|
| File name | `<lora name>.json`, the `.safetensors` name without its extension. It must match the name inside `<lora:NAME:weight>`, case-insensitively. |
| `"sd version"` | A string: Civitai's `baseModel` (`Illustrious`, `NoobAI`, `Anima`, `Krea 2`, …). `Unknown` is written when Civitai has none, and S-base then reports a mismatch. |
| Location | Any folder listed in the `lint.loraDirs` config, searched recursively |

### `civit-tool lora url PATH`

Looks up the Civitai page for every `.safetensors` file in a folder (recursive by default).

```bash
civit-tool lora url ./loras
civit-tool lora url ./loras --group-by-author
civit-tool lora url ./loras --no-recursive --domain civitai.com   # try civitai.com first
```

### `civit-tool lora duplicates [PATH]`

Finds `.safetensors` files with identical content anywhere under a folder, e.g. the same LoRA downloaded twice under different names. Then it asks, one group at a time, which copy to keep, and deletes the others. `--list` only lists them.

```bash
civit-tool lora duplicates                      # the current folder and all subfolders
civit-tool lora duplicates "path/to/forge/models"
civit-tool lora duplicates "path/to/forge/models" --list     # only list, delete nothing
civit-tool lora duplicates "path/to/forge/models" --rehash   # ignore the hash cache, read every file again
```

After the summary, each group is shown with its copies numbered:

```
Duplicate 1 of 3: EdoEraAnimeAnima.safetensors  (Civitai: Edo Era Anime), 87.71 MB each
  1) path/to/forge/models/Lora/EdoEraAnimeAnima.safetensors  (+c +p)
  2) path/to/forge/models/Lora/new/edo_era_v2.safetensors
  3) path/to/forge/models/Lora/old/EdoEraAnimeAnima.safetensors  (+c, also EdoEraAnimeAnima.civitai.info)
Keep which one? [1-3, Enter = skip, q = stop]
```

- **`+c`:** a `.json` with the same name is next to the copy (a `lora activation` sidecar). **`+p`:** a preview image Forge shows on the LoRA card: `name.png`, `name.preview.png`, or the same as `.jpg` / `.jpeg` / `.webp`. Other files named after the copy are listed after `also`.
- **A number** keeps that copy and deletes the others right away, each with every file named after it (its `.json`, previews, `.civitai.info`…; the same rule `lora activation` renames and sorts LoRAs by). The kept copy's files are never touched. Deleting is permanent (not the Recycle Bin); the kept copy has the same content.
- **Enter** skips the group, **q** (or Ctrl+C, or the end of piped input) stops and leaves the remaining groups alone. Anything else asks again. In a terminal, anything typed before a group is shown is ignored, so it can't answer a group you haven't seen.
- A file that can't be deleted (e.g. open in Forge) is reported and the rest go on. At the end: how many files were deleted and the space freed, and the folders whose `loras.yaml` may still list a deleted copy, so you can run `lora activation` there again.

- **Identical** means the same SHA-256 hash, so a file name doesn't matter.
- **Fast:** only files whose size matches another file's are read and hashed. A file with a size no other file has can't have a copy, so it's skipped.
- **Hash cache:** each hash is kept in `.cache/hashes.json` in civit-tool's own folder (the `npm link`ed checkout; git-ignored), keyed by the file's real path, with its size and modify time. While both are unchanged the file isn't read again, so a second run only hashes new or changed files. `lora activation` and `lora url` use the same cache. Each new hash is saved at once, so a run you stop keeps what it hashed. Entries of files the scan no longer finds in the scanned folder are removed; entries for other folders are kept. `--rehash` ignores the cached hashes, hashes every file again and updates the cache.
- **Links:** symlinks and Windows junctions are followed. A folder is scanned once, so a link back up the tree can't loop, and a link to a file isn't counted as a copy of it.
- **Names:** when a copy has a `lora activation` sidecar, its Civitai model name is shown.
- **Summary:** how many files were scanned, hashed and taken from the cache, the duplicate groups, the space the extra copies take, and the cache file.
- **Piped answers** work too (`printf '2\n\nq\n' | civit-tool lora duplicates …`), and are echoed after each question.

### `civit-tool lora config`

Shows and changes the LoRA settings without editing JSON. Run with no flags in a terminal, it opens the same kind of menu as [`wc config`](#civit-tool-wc-config):

```
  Changes are saved in C:\Users\you\.civit-tool.config.json as you make them.

› Civitai site     civitai.red  (default)
  Warn characters  @&  (default)
  Base model sort  on  (default)
  LoRA list file   loras.yaml  (default)

  Civitai API key  not set  (the CIVITAI_API_TOKEN environment variable)

lora activation and lora url look LoRAs up on this site first, then on the other one
↑/↓ move   Enter next choice   r default   q quit
```

| Setting | Flag | Saved as | What it does |
|---|---|---|---|
| Civitai site | `--domain civitai.com` | `domain` | the site `lora activation` and `lora url` try first; Enter switches between the two |
| Warn characters | `--warn-chars "@&#"` | `warnChars` | the characters `lora activation` warns about in LoRA names and offers to remove; `none` turns it off |
| Base model sort | `--sort-base off` | `activation.sortBaseModels` | whether `lora activation` offers to sort a folder of mixed LoRAs by base model; Enter switches it |
| LoRA list file | `--yaml-name my-loras.yaml` | `activation.yamlName` | the wildcard list `lora activation` writes (and `lora duplicates` checks); a plain file name ending in `.yaml` or `.yml` |

- Keys, saving, `--list`, `--reset <flag>` and `./civit-tool.config.json` work as in `wc config`. A flag of `lora activation` or `lora url` (`--domain`, `--yaml-name`, `--skip-sort-base`) still wins for one run.
- The Civitai API key is only shown, set or not: it stays an environment variable (see [API token](#api-token-optional)) and is never saved in the config file.

## wc

Wildcard YAML files for Dynamic Prompts: expanding, checking, finding repeats in and editing them.

### `civit-tool wc expand FILE WILDCARD`

Writes every prompt a wildcard path can produce to a text file, one per line, for batch runs. It works like sd-dynamic-prompts' combinatorial mode, and duplicates are removed.

```bash
civit-tool wc expand shirts.yaml "__shirts/fantasy/front-krea/*/knight__"
civit-tool wc expand ./wildcards/hair.yaml "hair/**" --output hair.txt
civit-tool wc expand clothes.yaml "clothes/*" --max 50000
civit-tool wc expand scenes.yaml "scenes/battle/*" --keep-long 10
```

- **FILE** is a wildcard YAML file. A bare file name is also looked up in the `wildcardsDir` folder from the config.
- **WILDCARD** is the path, with or without the `__` markers. Quote it so the shell leaves the `*` alone.
  - `*` matches within one path segment and `**` across segments; a glob uses every matching wildcard.
  - `{a|b}` picks only the listed siblings: `"__chars/{elf|orc}/*__"` uses `chars/elf/*` and `chars/orc/*` but not `chars/dwarf/*`. Alternatives may contain `/` and globs, and can be nested.
  - When the path matches nothing, it is retried as `**/path`, then ignoring upper/lower case.
- **Output** defaults to a file named after the path in the current folder, e.g. `shirts_fantasy_front-krea_all_knight.txt`.
- **`--max`** (default 10000): the combinations are counted first, and nothing is written when there are more than this.
- **`--keep-long N`**: an entry with at least N words is written exactly as it is, instead of every combination of it. Its `{…}` variants and `__references__` stay in the line, so Dynamic Prompts picks from them at render time. Shorter entries still expand, and a long entry referenced from a short one stays unexpanded inside each combination. A word is a piece between spaces, commas and `{ } | ( )` that contains a letter, so `star (sky), {2$$knight|samurai}` has 4. A kept entry counts as one prompt toward `--max`. Use it when a few big scene entries would otherwise explode into hundreds of thousands of lines.

**What it expands:**
- `{a|b}` variants, nested, including empty options `{|a}`. Weights (`{2::a|b}`) and sampler marks (`~`, `@`) are ignored, since every option is used anyway.
- `{2$$a|b|c}` and `{1-2$$ and $$a|b}`: every ordered pick without repeats, joined with `,` or the given separator. `{2$$__ref__}` picks from that wildcard's entries.
- Prompt-postprocessor's `__2-3$$name__`, where an `r` flag allows repeats.
- `__path__` references, globs included. A reference that matches nothing is retried as `__**/path__`, as the extension does.
- Escapes such as `\(` and `\{` are kept verbatim.

**Kept as text, with a warning:** `${variables}`, `<ppp:…>` commands, and prompt-postprocessor's `'filter'` and `(var=value)` reference extras.

**Errors** (exit code 1): a path that matches nothing (with "did you mean" suggestions), an unclosed `{`, a reference cycle, or more than `--max` prompts.

### `civit-tool wc sort FILE PATH`

Sorts the keys of a wildcard YAML file by name, under a path. List entries keep their order; only keys move, and the comments above a key move with it.

```bash
civit-tool wc sort own.yaml "__own/__"              # only the keys directly under own
civit-tool wc sort own.yaml "__own/*__"             # own and every level below it
civit-tool wc sort own.yaml "own/{style|action}/"   # the keys of style and of action
civit-tool wc sort own.yaml "*" --force             # the whole file, without asking
civit-tool wc sort own.yaml "own/*" --output sorted.yaml
```

- **FILE** works as in `wc expand`: a bare file name is also looked up in `wildcardsDir`.
- **PATH**, with or without the `__` markers. Its last segment sets the depth:
  - `own/` or `own`: the keys directly under own.
  - `own/*` or `own/**`: own's keys and those of every map below it, level by level.
  - `*` alone: the whole file.
- **The part before the last segment** may use `*`, `**` and `{a|b}` as in `wc expand`, to sort several maps at once. `own/*/*` sorts every child of own and everything below them, but not own's own keys. A path that matches nothing is retried as `**/path`, then ignoring upper/lower case.
- **Order:** case-insensitive, with numbers by value (`v2` before `v10`).
- **Preview:** it lists every level whose order changes and asks before rewriting the file. `--force` skips the question, and `--output` writes the sorted copy elsewhere and leaves the input as it is.
- **Formatting:** the file is printed like `wc lint --fix` prints it, so comments, quoting and CRLF line endings are kept. Some layout is normalised: 2-space indent, folded `>-` text on one line, and a comment after `key:` on its own line. The preview says when this happens.
- **Errors** (exit code 1): a path that matches nothing, or one that points at a list.

### `civit-tool wc lint [PATH...]`

Checks wildcard YAML files and reports each problem with its file, line and column. Several files or folders are checked together as one library, so `__references__` resolve across all of them. Tag branches are checked against Danbooru; prose branches (Krea 2) get prose rules instead (see [Model branches](#model-branches)).

```bash
civit-tool wc lint ./wildcards                     # every .yaml/.yml under the folder
civit-tool wc lint loras.yaml characters.yaml      # just these files
civit-tool wc lint                                 # the wildcardsDir folder from the config
civit-tool wc lint ./wildcards --fix               # apply the safe fixes, then report what is left
civit-tool wc lint ./wildcards --ignore "**:S-branch" --ignore "my-lib/custom/**"
civit-tool wc lint ./wildcards --json > findings.json
civit-tool wc lint ./wildcards --calibrate --loras "path/to/forge/models/Lora" --recursive   # pick tags to accept
```

**Setup:** it checks every tag against `danbooru.csv` (the Tag Autocomplete extension's format: `tag,category,count,aliases`, no header; fields separated by `;` instead of `,` work too, told apart by the first row). By default it reads `data/danbooru.csv` in civit-tool's own folder; the file isn't in git, so copy it there from Forge's Tag Autocomplete extension (`extensions/a1111-sd-webui-tagcomplete/tags/danbooru.csv`). To use another folder, run `civit-tool wc config --data-dir <folder>` once, or set it in the config:

```json
{
  "lint": {
    "dataDir": "path/to/forge/extensions/a1111-sd-webui-tagcomplete/tags",
    "loraDirs": ["path/to/forge/models/Lora"]
  }
}
```

- `dataDir` (or `--data-dir`): the folder with `danbooru.csv`; default: civit-tool's `data` folder. An optional `aliases.local.csv` there (header `alias,tag`, or `alias;tag` to use semicolons) adds aliases the CSV is missing, e.g. `tall_woman,tall_female`.
- `loraDirs` (optional): folders with `lora activation`'s JSON sidecars, for the `S-base` check.
- `rules` (optional): `{"S-branch": false}` turns a rule off; every rule is on by default. `wc config --off`/`--on` sets it in the home config, and a local config's switches apply on top of it, rule by rule.
- `acceptedTags` (optional): tags that aren't Danbooru tags but are right as written, such as a LoRA's activation tags (`["EdoEraAnime", "cv4n14-style"]`). Lint doesn't check them against Danbooru (no `R1`–`R4`, so `--fix` never changes one) and `P-tags` doesn't count them, anywhere in the library. They match in any case, with spaces or underscores, escaped or not; escaping (`R5`/`R6`) and `S-dup` still apply. `wc config --accept-loras <folder>` gathers them from the LoRA sidecars, and `--accept`/`--unaccept` add or remove them by hand.
- `exemptKeys` (optional): names of keys whose entries aren't linted at all, at any level and with every key below them: `["old_favs", "*_draft"]` (`*` matches any characters within a name). Unlike `ignore`, which hides findings under a key-path glob and counts them, exempt entries aren't checked; the report ends with `exempt keys: … (N entries not checked)`. References into an exempt key still resolve. `wc config --exempt-keys` sets it.
- Also optional: `minCount` (80), `maxTagsPerEntry` (40), `maxWordsPerEntry` (150, for prose branches), `branches` (see [Model branches](#model-branches)) and `ignore` (`[{"path": "<glob>", "rules": ["S-dup"]}]`).
- `--config <file>` uses another file's `lint` section instead, rule switches included, e.g. a project's own config file. `dataDir` then still falls back to civit-tool's config, then its `data` folder, and civit-tool's `acceptedTags` are used as well as the file's.
- Relative folders are relative to the current folder.

**Rules.** Each finding is an error, or a warning where marked below. The ones marked *fixable* are changed by `--fix`. Empty options such as `{|red_ribbon}` are never reported.

| Rule | Reports |
|---|---|
| `R1` | unknown tag, with "did you mean" suggestions |
| `R2` | a tag with fewer posts than `minCount` |
| `R3` | an alias instead of the real tag (`chains` → `chain`). *Fixable* when there is a single target |
| `R4` | a bare colour word (`red`): it needs a noun, e.g. `red_hair` |
| `R5` / `R6` | unescaped `(` `)` inside a tag (`bow_(weapon)`, `some (thing)`): Forge reads them as emphasis. Emphasis itself is fine: `(tag:1.2)`, and parentheses around whole tags, such as `(((tag)))` or `(red hair, blue eyes)`, also right next to a `<lora:…>`, which A1111 removes from the prompt / unescaped `@`. *Fixable*. Prose too |
| `S-yaml`, `S-brace` | YAML problems, e.g. an unquoted item starting with `{`; an unclosed `{` or a stray `}` |
| `S-ref` | a `__reference__` that matches no wildcard, or a stray `__` |
| `S-range` | an impossible pick, e.g. `{3$$a\|b}` |
| `S-dup` (warning) | the same entry twice in a list, or the same tag twice in an entry (not in prose, where repeating is emphasis) |
| `S-budget` (warning) | an entry that can expand to more than `maxTagsPerEntry` tags, or in prose more than `maxWordsPerEntry` words. `__references__` are followed, so a composed prompt counts in full |
| `S-expand` | a tag with more than 256 variations: its options were checked one by one |
| `S-base` | a `<lora:…>` whose base model doesn't match its branch, or any LoRA under `simple:` |
| `S-branch` (warning) | tags with no branch key (`ill:`, `anima:`, `*krea*`, `simple:`/`generic:`) above them |
| `S-anima` (warning) | an entry under `anima:` with no sentence before its tags |
| `P-tags` (warning) | a prose entry that still looks like Danbooru tags: underscore words (`long_hair`, `score_7`) or quality/count tags (`masterpiece`, `best quality`, `1girl`). One per entry |
| `P-neg` (warning) | a negation in prose (`no helmet`, `without text`): Krea 2 has no negative prompt and naming a thing primes it |

Any rule can be turned off for every run with `civit-tool wc config --off <RULE>`; the report then ends with `rules off: …`, and an off rule's fixes aren't applied either. To skip a rule in part of a library only, use `--ignore` instead. A LoRA's activation tag reported as an unknown tag (`R1`) is better accepted than ignored: `civit-tool wc config --accept-loras <your Lora folder> --recursive` accepts the activation tags of all your LoRAs at once.

**`--calibrate`** lints as usual, then lists every tag reported as unknown (`R1`), one row per tag: how often it's used, where first, and the LoRAs whose sidecar activation text has it. `--loras <folder>` (`--recursive`: and its subfolders) names the LoRA folder, read the way `wc config --accept-loras` reads it; without it, the `lint.loraDirs` folders are used. In a terminal it is a list to pick from, with the LoRA tags picked already:

```
  3 unknown tags (R1): pick the ones to accept. LoRA activation tags are picked already.

› [x] liibrra      2×  favs.yaml:4  LoRA: 9_Liibrra
  [x] ff-ca        1×  favs.yaml:8  LoRA: cute_anime ILL_V2
  [ ] lnog_hair    1×  favs.yaml:4

Used in favs.yaml:4, favs.yaml:6
↑/↓ move   Space select   a all/none   Enter accept 2   q cancel
```

- **Space** picks or unpicks the row, **a** picks all (or none, when all are picked), **Enter** accepts the picked tags, and **q** or Esc leaves without saving.
- The accepted tags are added to `lint.acceptedTags` in `~/.civit-tool.config.json`, and lint runs again to show what is left. If `./civit-tool.config.json` sets `acceptedTags`, it refuses (exit 2): add the tags there.
- Without a terminal, the list is printed, LoRA tags marked `[x]`, with a `wc config --accept` line for them, and nothing is saved. `--calibrate` can't be used with `--fix` or `--json`.

#### Model branches

A key named after a branch puts everything under it in that branch, and the nearest such key wins. Each branch has a prompt style:

| Branch | Keys | Style | LoRA base models (`S-base`) |
|---|---|---|---|
| `ill` | `ill` | tags: Danbooru tags, rules R1–R6 | Illustrious, NoobAI |
| `anima` | `anima` | sentence: one sentence, then a tag line; only the tag line is checked as tags | Anima |
| `krea` | `*krea*` (any key containing "krea": `krea`, `front-krea`, …) | prose: natural language, no Danbooru checks; `P-tags`, `P-neg` and the word budget instead | Krea 2, Krea 2 Turbo |
| `simple` | `simple`, `generic` | tags, shared by every model, so no LoRAs | – |

Keys are globs and case-insensitive. `simple:` entries are fine to reference from any branch, `krea:` included. `(word:1.2)` weights aren't flagged in prose.

Change the branches with `branches` in the `lint` config. Each named branch is merged into the default: give only the fields to change, a new name adds a branch (it needs `keys` and `style`), and `null` removes one:

```json
{
  "lint": {
    "branches": {
      "ill": {"baseModels": ["Illustrious", "NoobAI", "Pony"]},
      "zimage": {"keys": ["zimage"], "style": "prose", "baseModels": ["ZImageTurbo"]}
    }
  }
}
```

If your files don't use branch keys at all, add `--ignore "**:S-branch"`.

**Exit codes:** 0 nothing found, 1 findings, 2 a usage problem (missing file, no `danbooru.csv`, an unknown rule in `--ignore`).

### `civit-tool wc repeats [PATH...]`

Finds text that repeats across wildcard entries: runs of at least 5 words (prose) or 5 tags that appear twice or more, so they can move into one shared leaf and be pulled in with a `__reference__`. It only reports; nothing is changed. Several files or folders are checked together as one library.

```bash
civit-tool wc repeats ./wildcards                              # every .yaml/.yml under the folder
civit-tool wc repeats characters.yaml --min-words 8 --min-tags 4
civit-tool wc repeats characters.yaml --any-order              # tags as sets, in any order
civit-tool wc repeats characters.yaml --path "my-lib/krea/**" --top 20
civit-tool wc repeats ./wildcards --json > repeats.json
```

```
6 words × 3  "A chibi sticker illustration of a"
  shirts.yaml:4:10  lib/krea/knight
  shirts.yaml:6:10  lib/krea/ranger
  shirts.yaml:8:10  lib/krea/rogue
```

- **Words or tags** follow the entry's [model branch](#model-branches): prose branches (`krea:`) are read as words, everything else as comma-separated tags, and an `anima:` entry as its sentence in words plus its tag line in tags.
- **Matching is forgiving:** case doesn't matter, nor punctuation at a word's edges (`cape,` = `cape`), and in tags `long_hair` = `long hair`. A `__ref__`, `{…}` group or `<lora:…>` counts as one word or tag, compared as written.
- **Longest form only:** a 12-word repeat is one finding, not eight 5-word ones. A shorter run that has more copies is a finding of its own. A repeat within one entry counts too; nothing matches across two entries.
- Runs made only of `__refs__` are skipped: that text is already shared.
- The biggest repeats (length × extra copies) come first. Each lists up to 10 places, then how many more; `--json` lists all.

| Flag | Default | |
|---|---|---|
| `--min-words N` | 5 | Shortest repeat in prose |
| `--min-tags N` | 5 | Shortest repeat in tag lists |
| `--any-order` | off | Match tags as sets: entries sharing `--min-tags` or more tags count, in any order and mixed with other tags. Each shared set is reported once, in its largest form. Prose is always matched in order |
| `--path GLOB` | all | Only entries whose key path matches (`*` within a segment, `**` across) |
| `--top N` | all | Only the N biggest repeats |
| `--json` | off | The repeats as JSON |

**Exit codes:** 0 no repeats, 1 repeats found, 2 a usage problem (e.g. a missing file).

### `civit-tool wc config`

Shows and changes the wildcard settings without editing JSON: the folder holding `danbooru.csv` for `wc lint`, the default wildcards folder, the LoRA folders for the `S-base` check, lint's limits, the keys whose entries lint skips, the tags lint accepts without checking them against Danbooru, and which lint rules are on. Run with no flags in a terminal, it opens a menu:

```
  Changes are saved in C:\Users\you\.civit-tool.config.json as you make them.

› Data folder          C:\Tools\civit-tool\data  (default; danbooru.csv found)
  Wildcards folder     not set
  LoRA folders         not set  (S-base checks nothing without them)
  Minimum posts        80  (default)
  Max tags per entry   40  (default)
  Max words per entry  150  (default)
  Exempt keys          none
  Accepted tags        3: cv4n14-style, EdoEraAnime, medieval  (saved)
  Gather LoRA tags…

  Lint rules (all on by default)
  on   R1        error  unknown tag
  ...
  off  S-branch  warn   tags with no branch key (ill:, anima:, …) above them
  ...

The folder with the danbooru.csv (and optional aliases.local.csv) that wc lint checks tags against
↑/↓ move   Enter change   r default   q quit
```

- **↑/↓** move between rows; Home and End jump to the first and last. The line under the menu says what the row under the cursor does.
- **Enter on a rule** switches it on or off. **Enter on a setting** asks for a new value: paste or type it (quotes around a folder are fine), then Enter; Enter on its own keeps the current value, and Esc cancels. LoRA folders are separated by `;`, exempt keys by `,`. **r** puts a setting back to its default.
- **Accepted tags** shows how many there are and the first five. Enter asks for tags to accept, separated by commas; `-tag` removes one (`cv4n14-style, -medieval`). **r** clears them all, after a `y` to confirm.
- **Gather LoRA tags…** asks for a folder of LoRAs, then whether to include its subfolders, and accepts the activation tags of every sidecar there (see the flags below).
- Each change is saved at once, with the same checks as the flags below; a refused change shows why, in red. Rows that `./civit-tool.config.json` sets are marked and can't be changed from the menu.
- **q**, Esc or Ctrl+C leaves, and the settings are printed.
- A list taller than the window scrolls. Without a terminal (a pipe, a script), with `--list`, or with any of the flags below, the settings are printed instead.

The same changes as flags:

```bash
civit-tool wc config --list                            # print the settings, no menu
civit-tool wc config --data-dir "path/to/forge/extensions/a1111-sd-webui-tagcomplete/tags"
civit-tool wc config --wildcards-dir "path/to/forge/extensions/sd-dynamic-prompts/wildcards"
civit-tool wc config --lora-dirs "path/to/forge/models/Lora/illustrious;path/to/forge/models/Lora/anima"
civit-tool wc config --min-count 100 --max-tags 50 --max-words 200
civit-tool wc config --exempt-keys "old_favs,*_draft"  # entries under these keys aren't linted
civit-tool wc config --off S-branch,P-neg              # turn rules off (any case: s-branch works too)
civit-tool wc config --on S-branch                     # and back on
civit-tool wc config --accept-loras "path/to/forge/models/Lora" --recursive   # accept your LoRAs' activation tags
civit-tool wc config --accept cv4n14-style,EdoEraAnime # accept tags by hand
civit-tool wc config --unaccept medieval               # and remove them again
civit-tool wc config --reset data-dir --reset rules    # back to the defaults; any setting's flag name works
```

- Changes are saved in `~/.civit-tool.config.json`: `wildcardsDir`, and in the `lint` section `dataDir`, `loraDirs`, `minCount`, `maxTagsPerEntry`, `maxWordsPerEntry`, `exemptKeys`, `rules` and `acceptedTags`. A value equal to the default is removed instead. A `./civit-tool.config.json` in the current folder still overrides them; `wc config` says so when it does.
- Folders must exist (`--data-dir` must hold `danbooru.csv`) and are saved as absolute paths; numbers must be whole (at least 1 for the two maximums). When a check fails, nothing is saved (exit 2).
- `--off` writes `false` for the rule; `--on` removes it again, since every rule is on by default.
- `--accept-loras <folder>` reads every `.json` sidecar in the folder (`--recursive`: and its subfolders), from `lora activation` or Forge itself, and takes the tags of its `activation text` (or `trainedWords`) as lint reads them, so `(mytrigger:1.2)` gives `mytrigger`. Wildcard syntax in it is left out whole: a `{…|…}` group with the tags in its options (`{2::pauldrons, gauntlets|bare arms}`: those are ordinary tags lint goes on checking), a `__reference__`, a `<lora:…>`, a `${variable}`. It accepts only the tags lint would otherwise report: a tag `danbooru.csv` already knows as a valid tag (`1girl`, `long hair`, often in Civitai's trained words) is left out, and so is one already accepted. It says how many it found and left out; without a `danbooru.csv` it leaves out nothing. Running it again after adding LoRAs adds only the new tags.
- Accepted tags are saved as first written, one per tag (`EdoEraAnime` and `edoeraanime` are the same tag), sorted. `--accept` refuses wildcard syntax, which is never a tag. `--unaccept` refuses a tag that isn't accepted, and `--reset accepted-tags` clears them all.
- `branches` and `ignore` have no menu row; set them in the JSON (see [`wc lint`](#civit-tool-wc-lint-path)).

## img

Generated images: sorting them and reading the generation data Forge stores in them.

### `civit-tool img sort [PATH]`

Sorts generated images into one folder per model, read from their file names. The names follow Forge's **Filename pattern for saving images**, by default `[seed]_[denoising]_[model_name]_[datetime]` with no ascending number: `2447751738_0.6_waiANIMA_v10Base10_20260929160902.png` goes into `waiANIMA_v10Base10/`. If Forge names your images differently, tell civit-tool with [`img config`](#civit-tool-img-config).

- **Folder:** defaults to the current folder. Only files directly in it are moved, never files in subfolders.
- **Model folders** are created inside that folder when they don't exist yet.
- **Before moving,** it lists each target folder (new or existing) with the files that will go into it, then asks for confirmation.
- **Left alone:** images that don't match the pattern (it says how many), and files that already exist in the target folder.
- **Extensions:** `.png`, `.jpg`, `.jpeg` and `.webp`.

```bash
civit-tool img sort                 # sort the current folder
civit-tool img sort ./outputs
civit-tool img sort ./outputs --force   # no confirmation prompt
```

### `civit-tool img meta [PATH]`

Reads the generation metadata Forge / A1111 store in each image (the PNG Info tab's text) and writes it to `metadata.json` in the folder, or only the prompts to `prompts.txt`.

```bash
civit-tool img meta                                     # metadata.json in the current folder
civit-tool img meta ./outputs --prompt                  # prompts.txt, one prompt per line
civit-tool img meta ./outputs --stdout                  # the JSON to the console instead of a file
civit-tool img meta ./outputs --prompt --stdout | clip  # copy the prompts (Windows)
```

- **Images:** `.png`, `.jpg`, `.jpeg` and `.webp` directly in the folder, in name order; subfolders are not read. PNGs keep the text in a `parameters` chunk, JPEG and WebP in the EXIF UserComment. The format is taken from the file's content, not its extension.
- **JSON:** an array with one entry per image: `file`, `prompt`, `negativePrompt`, `settings` (the `Steps: …, Sampler: …` line as an object; values stay strings, as written) and `parameters` (the raw text). Text from other tools, such as ComfyUI's `workflow`, is kept under `other`, and `prompt` is then `null`.
- **`--prompt`:** one line per image, in the same order, ready for **Prompts from file or textbox**. A prompt written on several lines is joined with spaces. Only the positive prompt is written; images without one are listed and skipped.
- **`--stdout`:** prints the JSON or the prompts and writes no file. The status lines go to stderr, so a pipe or `> file` gets only the result.
- **`-o FILE`:** write somewhere else. An existing output file is replaced, and the summary says so.
- **Reported, not fatal:** images with no metadata, and files that aren't valid images.

### `civit-tool img loras [PATH]`

Ranks the LoRAs a folder of generated images used, by how many images use each, with the weights they were used at. It only reads.

```bash
civit-tool img loras                      # the current folder
civit-tool img loras ./outputs -r         # with subfolders, e.g. the ones img sort makes
civit-tool img loras ./outputs --top 10
civit-tool img loras ./outputs --json > loras.json
```

```
folder:  /outputs
images:  120 (118 with metadata, 95 with LoRAs)

#  images  share  weights         LoRA
1      42    36%  1 ×40, 0.8 ×2   ValerioSchitiStyle
2      17    14%  0.7 ×17         iLLMythD4rkL1nes
```

- **Where the LoRAs come from:** Forge / A1111 images list each LoRA as `<lora:name:weight>` (or `<lyco:…>`) in the prompt and again in the settings' `Lora hashes`. The prompt gives the weight (none written = 1); a LoRA only in `Lora hashes` counts with an unknown weight, shown as `?`. The negative prompt is read too. ComfyUI images: the LoRA loader nodes of the graph that ran (`lora_name`, e.g. LoraLoader, or rgthree's Power Lora Loader), named by file name without folder and extension; not yet checked against a real ComfyUI image with LoRAs.
- **Counting:** images, not mentions. Names are grouped regardless of case and shown in their most common spelling. `share` is the percentage of the images with metadata; `weights` lists each weight with how many images used it, most used first.
- **The same LoRA twice in one prompt is an error:** those images are listed on stderr and the exit code is 1. The image still counts once.
- **Images:** the same formats as `img meta`. Subfolders only with `-r`/`--recursive`, and then files are shown with their relative path. Images without metadata are listed, unreadable files are warned about.
- **`--json`:** `{folder, images, withMetadata, withLoras, ranking: [{rank, name, images, share, weights: [{weight, count}]}], duplicates: [{file, loras}]}`; the status lines go to stderr. `--top N` limits the ranking to the N most used.

### `civit-tool img config`

Shows and changes how Forge names your images, so `img sort` can find the model name in them. Both settings are in Forge under **Settings → Saving images/grids**. Run with no flags in a terminal, it opens the same kind of menu as [`wc config`](#civit-tool-wc-config):

```
  Changes are saved in C:\Users\you\.civit-tool.config.json as you make them.

› Filename pattern  [seed]_[denoising]_[model_name]_[datetime]  (default)
  Ascending number  off  (default)

  Example           2447751738_0.6_waiANIMA_v10Base10_20260929160902.png  (what img sort looks for)
```

```bash
civit-tool img config --pattern "[model_name]-[seed]" --add-number on
civit-tool img config --reset pattern --reset add-number
```

| Setting | Flag | Config key | Default |
|---|---|---|---|
| Filename pattern: Forge's **Filename pattern for saving images**, pasted as it is | `--pattern` | `img.filenamePattern` | `[seed]_[denoising]_[model_name]_[datetime]` |
| Ascending number: whether Forge's **Add number to filename when saving** is on | `--add-number on\|off` | `img.addNumber` | off |

- **The example line** is a name Forge would write with your settings; compare it with your own images.
- **The pattern needs `[model_name]`,** since `img sort` makes one folder per model. A pattern without it is refused.
- **What it reads like Forge:** tags in any case; `[tag<arg>]` arguments such as `[datetime<%Y-%m-%d_%H-%M-%S>]` (a `:` in the format becomes `_` in the name, as Forge writes it) and `[prompt_hash<6>]`; an unknown tag kept as written; and the ascending number as a 5-digit counter and a dash, `00042-…`. `[denoising]`, `[seed_last]`, `[batch_number]` and `[generation_number]` may be missing from a name together with the text before them, as Forge leaves them out when they have no value.
- **One limit:** when `[model_name]` sits right next to a free-text tag such as `[prompt]` or `[sampler]`, where the model name ends is a best guess. With a fixed tag between them, as in the default pattern, it is exact.
- Keys, saving, `--list`, `--reset <flag>` and `./civit-tool.config.json` work as in `wc config`.

## file

Bulk operations on any kind of file.

### `civit-tool file rename [PATH]`

Bulk-renames files by substring. Defaults to collapsing `__` → `_`.

```bash
civit-tool file rename ./loras                              # __  ->  _, current folder, asks to confirm
civit-tool file rename ./loras --recurse                     # include subfolders
civit-tool file rename ./loras --find "old" --replace "new" --force
```

Nothing is overwritten. When a new name already exists, or two files would get the same new name, the preview marks that file and prints a warning. The file keeps its current name.

**Sequence mode**: renumbers every `.png` file in a folder to `<index>-<date>-<hour>-<minute>.png` (e.g. `0001-2026-08-20-12-33.png`), ordered by original filename. All files in one run share the same timestamp, captured once at the start. Non-png files are untouched. `--find`/`--replace` are ignored in this mode.

```bash
civit-tool file rename ./screenshots --sequence                       # 0001-2026-08-20-12-33.png, 0002-..., ...
civit-tool file rename ./screenshots --sequence --width 5 --start 0   # 00000-..., 00001-..., ...
civit-tool file rename ./screenshots --sequence --recurse --force
```

## Development

```bash
npm test   # every src/test/*.test.js, with node:test
```

- **Layout:** `bin/run.js` starts the CLI. `src/commands/<group>/` holds one file per command, and `src/lib/` the shared code: the Civitai client, hashing, the settings menus, and the linter in `src/lib/lint/`, `src/lib/wildcard-parser/` and `src/lib/tag-index/`.
- **A new command** goes into the group whose files it works on. When none fits, it starts a new group with a short lowercase name, which needs an entry in `oclif.topics` in `package.json` and in the `GROUPS` list of `src/test/commands.test.js`. After adding or renaming commands, run `civit-tool autocomplete --refresh-cache`.
- **The sidecar contract** above ties `lora activation` to `wc lint`'s `S-base` rule (`src/lib/lint/rules/lora.js`), and `src/test/activation.test.js` checks it. Change the `"sd version"` field in both places, or not at all.

## License

MIT, see [LICENSE](LICENSE).
