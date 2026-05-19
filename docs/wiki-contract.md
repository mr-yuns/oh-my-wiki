# Wiki Contract

OMW stores one generated contract in each connected wiki:

```text
<wiki>/.omw/contract.json
```

The contract is the local agreement between OMW and a Markdown folder. It tells
the CLI where to search, where Raw notes live, which templates should be used,
which ingest states are pending, and which operating rule notes should be shown
before a human promotes durable knowledge.

The public JSON Schema for the contract is tracked at
[`docs/wiki-contract.schema.json`](wiki-contract.schema.json). Use
`omw wiki contract --explain` for a concise runtime summary of the active
contract, and `omw wiki contract --validate` to check the active contract's
required schema shape without adding an external validator dependency.

## Lifecycle

`omw setup --wiki <path>` creates the contract when it is missing. `omw wiki
contract --refresh` and `omw wiki refresh --target contract` rescan the wiki and
rewrite scanner-owned fields. Add `--dry-run --json` to preview the next
contract and a field-level change summary without writing `.omw/contract.json`.

The scanner is intentionally conservative:

- It writes only inside the connected wiki.
- It keeps Raw ingest review-first.
- It creates managed fallback Raw folders under `.omw/raw` only when the wiki
  does not already expose a usable Raw area.
- It preserves user-owned contract extensions when the selected language stays
  the same.

## Supported Layouts

OMW currently recognizes three broad layout profiles:

| Profile | Meaning |
| --- | --- |
| `omw-base-wiki` | The bundled English/Korean PARA-style base wiki. |
| `karpathy-llm-wiki` | A source/wiki split with schema notes, source material, an index, and a log. |
| `generic-markdown` | Any Markdown folder that does not match a stronger profile. |

For generic Markdown folders, OMW tries to infer existing raw folders and
templates. If none are usable, it creates `.omw/raw` and `.omw/templates` so
capture, queue, and ingest-preview commands still work locally.

## Schema Version

Current contracts use `schemaVersion: 2`. OMW still accepts schema version `1`
for queue compatibility, but refresh rewrites scanner-owned sections in the
current v2 shape.

Top-level fields:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Contract schema version. |
| `generatedBy` | Scanner name, currently `omw-contract-scanner`. |
| `generatedAt` | ISO timestamp of the scan. |
| `defaultLanguage` | Default language fallback. |
| `language` | Active language used for localized roots and templates. |
| `wikiName` | Basename of the connected wiki path. |
| `source` | Detected layout profile, confidence, and signals. |
| `scanner` | Scanner metadata, selected roots, and fallbacks. |
| `understanding` | OMW's 0-100 confidence that the active wiki structure is fully understood. |
| `capabilities` | Readiness summary for major OMW workflows. |
| `frontmatter` | Detected key names for type, raw type, state, target, and sensitivity fields. |
| `rules` | Operating rule note paths. |
| `raw` | Raw-note root, note types, templates, naming, and ingest states. |
| `ingest` | Pending states, candidate targets, review rule keys, and approval policy. |
| `search` | Search root and excluded directories. |
| `daily` | Daily report headings, placeholders, and naming hints. |

## Capabilities

`capabilities` is a diagnostic summary. Each capability has:

| Field | Meaning |
| --- | --- |
| `ready` | Whether the scanner found enough structure for that workflow. |
| `mode` | How OMW will operate, such as `detected`, `scoped`, `frontmatter`, `rules-backed`, or `minimal`. |
| `issues` | Human-readable blockers when `ready` is false. |

The main capability keys are `search`, `capture`, `queue`, `ingest`, `daily`,
`rules`, and `templates`.

## Understanding Score

`understanding` is the safety gate for unfamiliar personal wikis. It records a
0-100 score, the scored dimensions, missing dimensions, and a handoff hint when
OMW inferred part of the structure instead of detecting it directly.

The score is complete only at `100`. Anything lower means OMW can continue with
conservative behavior, but write-oriented wiki workflows should first run a
Wiki-specific Deep Interview to confirm the missing structure. The interview is
expected to fill the contract dimensions that are not fully detected, such as
Raw folders, capture templates, ingest rules, daily-report structure, search
scope, and operating-rule notes.

## Raw Section

`raw.root` is the path, relative to the wiki root, where Raw notes live.
`raw.noteTypes` lists frontmatter `type` values treated as Raw notes.
`raw.ingestStates` lists known Raw states.

`raw.types` maps OMW logical capture types to folders and templates:

| Type | Purpose |
| --- | --- |
| `daily_report` | Human or agent daily report Raw notes. |
| `agent_session` | Captured AI-agent or session summaries. |
| `discussion` | Meeting, decision, or discussion source notes. |
| `web_clip` | Optional web clipper source notes when detected. |

Known user-owned custom raw types are preserved when they define a folder and a
template.

All contract paths are wiki-relative. Absolute paths, parent traversal (`..`),
Windows drive paths, UNC paths, and NUL bytes are invalid. `search.root` may be
an empty string to mean the wiki root; other path fields should name a concrete
wiki-relative file or directory.

Daily naming patterns are also path-checked. `memberFolderPattern` may include
nested folders under the daily Raw type folder, but it must not be absolute or
contain `.` / `..` path segments. `reportFilePattern` must render to a file name,
not a nested path.

## Ingest Section

`ingest.pendingStates` tells `omw queue` which Raw notes need attention.
`ingest.ruleKeys` tells `omw ingest` which rule notes to include in the preview.
`ingest.approvalRequiredForPromotedNotes` is currently expected to stay `true`.

OMW ingest is review-first. `omw ingest <raw-note>` produces a preview and does
not write promoted durable notes by default.

`omw ingest <raw-note> --write-draft` writes a review draft under
`.omw/ingest-drafts/`. Drafts are still not promoted durable notes; they are a
workspace for manual review. Existing drafts are protected by default; add
`--overwrite-draft` only when you intentionally want to replace the draft.

`omw ingest <raw-note> --promote --target <relative-note.md>` writes a
draft-status durable note to a wiki-relative target and updates the Raw note to
the promoted ingest state when the Raw note exposes a supported state
frontmatter key. Promotion requires an explicit Markdown target, refuses writes
under `.omw` or the Raw root, and protects existing target files by default.
Add `--overwrite-promote` only when replacing the promoted target is deliberate.
When the target is inside a recognized bundled base-wiki section, OMW renders
section-aware draft frontmatter such as `Permanent Note`, `Area Note`,
`Operating Guide`, `Map`, or `Catalog` so the promoted draft remains compatible
with base-wiki validation rules.

## Search Section

`search.root` scopes normal search. For the base wiki it is the active language
root, such as `en` or `ko`. For Karpathy-style layouts it is usually `wiki`.

`search.excludeDirs` removes Raw queues, templates, source folders, and other
non-durable material from normal search results.

`search.ranking` may override search ranking weights. All values must be
non-negative numbers. Omitted keys use defaults:

| Key | Default | Meaning |
| --- | ---: | --- |
| `title` | `20` | Boost exact query matches in note titles. |
| `path` | `10` | Boost matches in file names. |
| `bodyTerm` | `1` | Weight each body occurrence in scan search. |
| `noteType` | `1` | Boost notes with a detected type in SQLite search. |
| `maturity` | `1` | Boost notes with maturity metadata in SQLite search. |
| `status` | `0.5` | Boost notes with status metadata in SQLite search. |
| `lens` | `0.5` | Boost notes with documentation-lens metadata in SQLite search. |

## Rules Section

`rules` maps stable rule keys to Markdown notes. OMW uses these paths when it
needs operating context, especially ingest previews.

Common rule keys:

| Key | Meaning |
| --- | --- |
| `agentKnowledge` | How agents should capture useful context. |
| `noteWriting` | Durable note writing rules. |
| `wikiOperation` | Wiki operating procedure. |
| `rawOperation` | Raw capture and ingest rules. |
| `knowledgeMap` | Main map or index note. |
| `searchProperties` | Frontmatter/property catalog. |
| `aiPlatform` | AI tool integration rules. |
| `areaCatalog` | Area taxonomy or catalog. |

## Scanner-Owned Fields

Refresh overwrites scanner-owned sections because they reflect the current wiki
shape. Unknown user-owned keys are preserved in these sections where possible:
`raw`, `raw.types.*`, `search`, `ingest`, and `daily`.

The scanner owns these top-level fields:

```text
schemaVersion, generatedBy, generatedAt, defaultLanguage, language, wikiName,
source, scanner, understanding, capabilities, frontmatter, rules, raw, ingest,
search, daily
```

Custom top-level keys outside that set are preserved. For custom Raw behavior,
prefer adding unknown keys under an existing `raw.types.<name>` entry or adding
a new raw type with `folder` and `agentTemplate`/`template`/`humanTemplate`.

## Validation And Inspection

Useful commands:

```bash
omw wiki status
omw wiki contract --refresh
omw wiki contract --validate
omw wiki refresh --target contract
omw wiki validate
omw wiki queue --json
```

`omw wiki validate` applies bundled strict rules to OMW base wikis and
contract-aware safety checks to generic Markdown wikis. It is strictest for the
bundled English/Korean base layout and is most useful before publishing or
committing base-wiki changes.
