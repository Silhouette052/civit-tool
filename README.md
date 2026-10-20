# civit-tool

One CLI for day-to-day LoRA, image and wildcard file management. It replaces five standalone scripts and adds a few tools of its own:

| Command | Replaces |
|---|---|
| **`lora`**: LoRA files | |
| `civit-tool lora activation` | `lora_activation.js` |
| `civit-tool lora url` | `url_exporter.js` + `url_with_author.js` (merged) |
| `civit-tool lora duplicates` | `duplicate_lora_finder.js`: finds identical `.safetensors` files, then asks which copy to keep |
| **`wc`**: wildcard YAML files | |
| `civit-tool wc expand` | (new) `expand-wildcards.mjs` from the t-shirt project: wildcard → prompt list |
| `civit-tool wc lint` | `unbalanced.js`, now a full linter: tags checked against Danbooru, plus structure |
| `civit-tool wc repeats` | (new) finds repeated phrases and tag runs that could move into a shared leaf |
| `civit-tool wc sort` | (new) sorts the keys of a wildcard YAML file by name under a path |
| **`img`**: generated images | |
| `civit-tool img sort` | (new) sorts generated images into per-model folders |
| `civit-tool img meta` | (new) generation metadata of a folder's images as JSON, or just the prompts |
| `civit-tool img loras` | (new) ranks the LoRAs a folder of images used, with their weights |
| **`file`**: bulk file operations | |
| `civit-tool file rename` | `Rename-Files.ps1` |

Commands are grouped by what they work on, like `aws s3 cp`: `civit-tool <group> <command>`. `civit-tool <group>` alone lists that group's commands. See [Command groups](#command-groups) for where new features go.

## Install

From this folder:

```bash
npm install
npm link
```

`civit-tool` is now a global command, runnable from anywhere. To undo later: `npm unlink -g civit-tool`.

(If you specifically want `npx civit-tool ...` to work, that requires publishing this package somewhere npx can resolve it from — e.g. `npm publish`, a private registry, or `npx github:yourname/civit-tool`. `npm link` gives you the same "works from any folder" result without publishing anything.)

## Autocomplete

```bash
civit-tool autocomplete
```

This prints the install command for your shell (bash, zsh, or PowerShell). Run the one it gives you, restart your shell, and `civit-tool <TAB>` will complete groups, commands and flags. After an update that adds or moves commands, run `civit-tool autocomplete --refresh-cache`.

**PowerShell note:** the generated PowerShell completion script uses PowerShell 7+ syntax (`?:`, `??`). It will throw parse errors on every startup if installed into Windows PowerShell 5.1's profile (the default `powershell.exe`). Install it from a **pwsh** (PowerShell 7) session instead — it has its own separate `$PROFILE`, so this won't touch or break your 5.1 profile.

## Config

Optional. Create `civit-tool.config.json` in your working directory (or `~/.civit-tool.config.json` for a global default):

```json
{
  "domain": "civitai.red",
  "wildcardsDir": "path/to/forge/extensions/sd-dynamic-prompts/wildcards"
}
```

`wildcardsDir` (optional) is where `wc expand` and `wc lint` look for a bare file name, and what `wc lint` checks when no path is given. The `lint` config section is described under [`civit-tool wc lint`](#civit-tool-wc-lint-path). `domain` is the Civitai domain `lora url` and `lora activation` look LoRAs up on first; the default is `civitai.red`. Both domains serve the same API, but a LoRA can be visible on one and not the other, so a LoRA the first domain doesn't know (any error: 404, refused, network) is looked up on the other. Links, in `lora url`'s output and in the sidecar's `"civitai url"`, point to the domain that had the LoRA, and the sidecar's `"civitai lookup"` names it. Override per run with `--domain`; `--domain civitai.com` tries civitai.com first.

## API token (optional)

```bash
export CIVITAI_API_TOKEN=xxxxxxxx     # macOS/Linux
setx CIVITAI_API_TOKEN xxxxxxxx       # Windows
```

Used automatically by `lora url` and `lora activation` if set.

## Command groups

Every command belongs to a group. A new feature goes into the group whose files it works on, or, when none fits, into a new group with a short lowercase name (added to `oclif.topics` in `package.json` and to `src/test/commands.test.js`).

- **`lora`**: `.safetensors` LoRA files, their JSON sidecars and Civitai lookups.
- **`wc`**: wildcard YAML files: expanding, checking, finding repeats in and editing them.
- **`img`**: generated images.
- **`file`**: generic bulk file operations that don't care what the files are.

## lora

### `civit-tool lora activation PATH`

For every `.safetensors` in a folder (top-level only): uses the JSON sidecar if one exists, otherwise resolves trigger words + weight from Civitai and creates it. Always (re)writes `loras.yaml` from every sidecar found.

```bash
civit-tool lora activation ./loras
civit-tool lora activation ./loras --yaml-name my-wildcards.yaml
civit-tool lora activation ./loras --refresh   # re-resolve + overwrite every sidecar, even existing ones
civit-tool lora activation ./loras --xyz       # print only the X/Y/Z plot values line
civit-tool lora activation ./loras --fix-names # rename problem names without asking
civit-tool lora activation ./loras --warn-chars "@&#"   # warn about these characters from now on
civit-tool lora activation ./loras --reset-warn-chars   # back to the default @&
civit-tool lora activation ./loras --skip-sort-base     # don't offer the base model sort
```

**Problem names:** before anything else, `lora activation` lists every LoRA whose name has `__` or a character from the warn list, and asks whether to rename it:

- `__`: Dynamic Prompts reads it as the start of a wildcard reference, so a `<lora:my__style:1>` tag can be misread in wildcard files. Each run of underscores becomes one `_` (`my__style` → `my_style`).
- **Warn characters** (default `@` and `&`): they are removed from the name, then doubled underscores and spaces are tidied (`Rock & Roll` → `Rock Roll`, `Iter@L1nes` → `IterL1nes`). A name made only of them can't be renamed and is just reported.
- `--warn-chars "@&#"` replaces the list and saves it as `warnChars` in `~/.civit-tool.config.json`, so later runs use it too. `--reset-warn-chars` removes the saved list, so the default applies again. A `warnChars` in the project's `./civit-tool.config.json` wins over the saved one, and the run says so.

Files with the same name are renamed along with the LoRA: the JSON sidecar, `.preview.png`, `.civitai.info` and so on. A LoRA whose new name is already taken is left alone, as in `file rename`. Answering no keeps the names and carries on. `--fix-names` renames without asking. Wildcard files that use the old names need updating by hand.

**Sorting by base model:** when the folder holds LoRAs for more than one base model, `lora activation` offers to move each into a folder named after its model family. It runs after the sidecars are written and reads their `"sd version"`. The families are generic, not the exact checkpoint: `illustrious` (Illustrious and NoobAI), `pony` (every Pony version), `anima`, `krea`, `flux` (Flux.1), `flux2`, `sdxl`, `sd15`, `sd2`, `sd3`, `zimage`, `qwen`, `wan`, `hunyuan`, `ltxv`, `chroma`, `hidream`, `lumina`, `kolors`, `pixart`, `auraflow` (`src/lib/baseModels.js`).

- **Preview first:** every family folder (new or existing) with the LoRAs going there, the Civitai base model in brackets when it differs from the folder name (`[NoobAI]`), then `Sort N LoRA(s) into base model folders? [y/N]`.
- **One family only:** nothing is offered.
- **Moved with the LoRA:** every file named after it, as for the name fixes. `loras.yaml` stays.
- **Left where they are, with a WARNING:** LoRAs without a sidecar (the Civitai lookup failed) and those whose base model is `Other`, `Unknown` or not in the list.
- **Nothing is overwritten:** a LoRA whose file already exists in the target folder stays, marked `can't move`.
- **`--skip-sort-base`** skips the step. With `--xyz` the preview and the question go to stderr.
- `<lora:…>` tags keep working, since Forge finds LoRAs in subfolders by name. `loras.yaml` lists the moved LoRAs too; but `lora activation` reads only the folder's top level, so a later run on the same folder no longer sees them.

The last line of the output is every LoRA's prompt (the `loras.yaml` lines) in double quotes, separated by commas, ready to paste as the X values of an X/Y/Z plot with X type **Prompt S/R**:

```
"<lora:CastlevaniaTV-ANIMA:1>, cv4n14-style,","<lora:Dawnmap Anima:1>, medieval,","<lora:IterL1nesV2:1>, @iterl1nes,"
```

`--xyz` prints only that line, so it can be copied or piped (`civit-tool lora activation ./loras --xyz | clip` on Windows). The sidecars and `loras.yaml` are still created or updated as usual; problems go to stderr.

**Where the preferred weight comes from**, in priority order:

1. **Civitai "Usage Tips" settings** (`settings.strength` / `minStrength` / `maxStrength`). These are only exposed by Civitai's internal tRPC API, which is unofficial and may change, so any failure there silently falls through to the next step. If the author only set min/max, the midpoint is used.
   - Exception: a bare `strength: 1` with no min/max is usually just the upload form's default. If the description text has a hint, that hint wins, and the console prints a `NOTE` line.
2. **Free text** in the model-*version* description, then the full *model* description, then the version's `notes`. Phrasings like "Strength: 0.8", "recommended to be 0.4~0.6", "use at 0.7 strength", "I recommend starting in the 0.8 - 1 range", "weight between [0.8,1]" and "I prefer 0.9" are recognised. Values above 2 are ignored, as are numbers next to CFG, steps or version names.
3. **A hardcoded default of `1`**, with a `WARNING` line in the console.

Ranges always resolve to their **midpoint**: 0.4~0.6 → 0.5. Each sidecar records:
- `"preferred weight source"`
- `"preferred weight min"` / `"preferred weight max"`, when a range is known

Use `--refresh` to recompute this for LoRAs that already have a JSON sidecar, e.g. ones generated by older versions. Refresh replaces only Civitai-derived fields and keeps your non-empty `notes`, `negative text` and `activation text`.

**The sidecar is also read by `wc lint`**. Its rule `S-base` checks that a `<lora:…>` sits under the right model branch (`ill:`, `anima:`, `krea:`, …). It relies on exactly this:

| What | Contract |
|---|---|
| File name | `<lora name>.json`, the `.safetensors` name without its extension. It must match the name inside `<lora:NAME:weight>`, case-insensitively. |
| `"sd version"` | A string: Civitai's `baseModel` (`Illustrious`, `NoobAI`, `Anima`, `Krea 2`, …). `Unknown` is written when Civitai has none, and S-base then reports a mismatch. |
| Location | Any folder listed in the `lint.loraDirs` config, searched recursively |

Don't rename or drop `"sd version"` without updating `src/lib/lint/rules/lora.js`. `src/test/activation.test.js` checks the field.

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

## wc

### `civit-tool wc expand FILE WILDCARD`

Writes every prompt a wildcard path can produce to a text file, one per line, for batch runs. It works like sd-dynamic-prompts' combinatorial mode, and duplicates are removed.

```bash
civit-tool wc expand tshirt-gamenight.yaml "__tshirt-gamenight/wh40k/front-krea/*/matyi__"
civit-tool wc expand ./wildcards/hair.yaml "hair/**" --output hair.txt
civit-tool wc expand clothes.yaml "clothes/*" --max 50000
civit-tool wc expand scenes.yaml "scenes/battle/*" --keep-long 10
```

- **FILE** is a wildcard YAML file. A bare file name is also looked up in the `wildcardsDir` folder from the config.
- **WILDCARD** is the path, with or without the `__` markers. Quote it so the shell leaves the `*` alone.
  - `*` matches within one path segment and `**` across segments; a glob uses every matching wildcard.
  - `{a|b}` picks only the listed siblings: `"__chars/{elf|orc}/*__"` uses `chars/elf/*` and `chars/orc/*` but not `chars/dwarf/*`. Alternatives may contain `/` and globs, and can be nested.
  - When the path matches nothing, it is retried as `**/path`, then ignoring upper/lower case.
- **Output** defaults to a file named after the path in the current folder, e.g. `tshirt-gamenight_wh40k_front-krea_all_matyi.txt`.
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
```

**Setup:** it checks every tag against `danbooru.csv` (the Tag Autocomplete extension's format: `tag,category,count,aliases`, no header). Point the config at the folder holding it:

```json
{
  "lint": {
    "dataDir": "path/to/forge/extensions/a1111-sd-webui-tagcomplete/tags",
    "loraDirs": ["path/to/forge/models/Lora"]
  }
}
```

- `dataDir` (or `--data-dir`): the folder with `danbooru.csv`. An optional `aliases.local.csv` there (header `alias,tag`) adds aliases the CSV is missing, e.g. `tall_woman,tall_female`.
- `loraDirs` (optional): folders with `lora activation`'s JSON sidecars, for the `S-base` check.
- Also optional: `minCount` (80), `maxTagsPerEntry` (40), `maxWordsPerEntry` (150, for prose branches), `branches` (see [Model branches](#model-branches)) and `ignore` (`[{"path": "<glob>", "rules": ["S-dup"]}]`).
- `--config <file>` uses another file's `lint` section instead, e.g. a project's own config file. `dataDir` then still falls back to civit-tool's config.
- Relative folders are relative to the current folder.

**Rules.** Each finding is an error, or a warning where marked below. The ones marked *fixable* are changed by `--fix`. Empty options such as `{|red_ribbon}` are never reported.

| Rule | Reports |
|---|---|
| `R1` | unknown tag, with "did you mean" suggestions |
| `R2` | a tag with fewer posts than `minCount` |
| `R3` | an alias instead of the real tag (`chains` → `chain`). *Fixable* when there is a single target |
| `R4` | a bare colour word (`red`): it needs a noun, e.g. `red_hair` |
| `R5` / `R6` | unescaped `(` `)` (Forge reads them as emphasis; `(tag:1.2)` is fine) / unescaped `@`. *Fixable*. Prose too |
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

The code lives in `src/lib/lint/`, `src/lib/wildcard-parser/` and `src/lib/tag-index/`. If `civit-tool <TAB>` doesn't offer `wc lint`, run `civit-tool autocomplete --refresh-cache`.

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

## img

### `civit-tool img sort [PATH]`

Sorts generated images named `<seed>_<denoise>_<model>_<yyyyMMddHHmmss>.png` into one folder per model. For example, `2447751738_0.6_waiANIMA_v10Base10_20260929160902.png` goes into `waiANIMA_v10Base10/`.

- **Folder:** defaults to the current folder. Only files directly in it are moved, never files in subfolders.
- **Model folders** are created inside that folder when they don't exist yet.
- **Before moving,** it lists each target folder (new or existing) with the files that will go into it, then asks for confirmation.
- **Left alone:** images that don't match the pattern, and files that already exist in the target folder.
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

## file

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

## What changed vs. the original scripts

- **Commands are grouped** (`lora`, `wc`, `img`, `file`; see [Command groups](#command-groups)). The old flat names (`civit-tool activation`, `civit-tool order`, …) are gone.
- All five scripts' safetensor-metadata reading, hashing, and Civitai API calls are consolidated into `src/lib/` (previously duplicated 2–3 times with small inconsistencies).
- `activation`'s `loras.yaml` write is now enabled — in the original `lora_activation.js` this was commented out, so the file was never actually produced.
- `url_exporter.js`'s stray debug `console.log(metadata)` is gone.
- Lookups try `civitai.red` first and then `civitai.com` (since 2026-10-15; before, the API only went to `civitai.com` and `domain` changed only the link text). `--domain`/config `domain` picks the domain tried first, and links point to the domain that found the LoRA.
- `url` merges the flat-folder-only `url_exporter.js` and the recursive, author-grouping `url_with_author.js` into one command with `--recursive` (on by default) and `--group-by-author` flags.
- **`activation` now fetches the full parent model, not just the model-version stub.** Civitai's model-version API returns a slim `model` object (name/type/nsfw/poi only, no description), so any "Usage Tips" text that lives on the model page rather than repeated per-version was previously invisible to weight extraction and silently defaulted to `1`. `activation` now also calls `GET /models/{id}` and checks its description too.
- **Description text is HTML-stripped before the weight/strength regexes run.** Civitai descriptions are HTML; inline formatting like `<strong>Strength:</strong> 0.9` previously broke the whitespace-only adjacency the patterns assumed.
- **Weight extraction records its source** (`structured field`, `model-version description`, `model description`, `notes field`, or `default (not found)`) in each JSON sidecar, and the console warns when it falls back to the default.
- `lint` is no longer the per-line `{}` / `__` counter from `unbalanced.js`: it is a full linter, which parses the YAML and also checks the tags (see above).
- `wc lint` handles Krea 2 prose wildcards (since 2026-10-17): any key containing `krea` is a prose branch with its own rules (`P-tags`, `P-neg`, a 150-word budget) instead of Danbooru checks. Model branches are now set in the `branches` config, which replaces the old `baseModels` setting.
- `lora duplicates` asks which copy to keep (since 2026-10-20) and deletes the others with their `.json` and previews; `--list` only lists, as before.
- `lora duplicates` caches hashes (since 2026-10-20) in `.cache/hashes.json` in civit-tool's folder, so unchanged files aren't read again; `lora activation` and `lora url` share the cache. `--rehash` reads every file again.
- New `img loras` (since 2026-10-19): ranks the LoRAs a folder of images used, by image count, with their weights; a LoRA written twice in one prompt is an error.
- Dependencies trimmed (since 2026-10-20): the `oclif` dev tool and `shx` are gone, with the `prepack`/`postpack` scripts that used them. The dev tool was only for `npm pack`, and brought in the AWS SDK and an unfixable `braces` audit finding. `npm install` now installs 51 packages (5.6 MB) instead of 257 (35 MB); `npx oclif manifest` makes a manifest if one is ever needed.
- New `wc repeats` (since 2026-10-17): finds runs of 5+ words or tags repeated across entries, in order or (`--any-order`) as tag sets.
- `src/test/` has unit tests (`node --test src/test/*.test.js`) covering the HTML stripper and the weight-extraction priority order, including a fixture for the exact "tips are on the model page, not the version page" scenario.
