# Oh My Wiki (OMW)

[![npm version](https://img.shields.io/npm/v/oh-my-wiki?color=cb3837)](https://www.npmjs.com/package/oh-my-wiki)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-wiki?color=blue)](https://www.npmjs.com/package/oh-my-wiki)
[![CI](https://github.com/mr-yuns/oh-my-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/mr-yuns/oh-my-wiki/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Local-first wiki runtime for agent-assisted Markdown knowledge bases.**

OMW turns a plain Markdown folder into a practical knowledge workflow for
agents and humans: contract generation, search, capture, Raw-note queues,
ingest previews, daily reports, validation, Codex skills, Claude Code skills,
and optional wrapper commands for
[OMX](https://github.com/Yeachan-Heo/oh-my-codex) and
[OMC](https://github.com/Yeachan-Heo/oh-my-claudecode).

OMW is intentionally not a hosted wiki, sync service, or database product.
Your notes stay on disk. Your Git history stays yours. The runtime only adds a
small local contract, a search index when available, and generated helper files
inside the connected wiki.

**Quick links:** [Installation](#installation) |
[Quick Start](#quick-start) | [Commands](#commands) |
[Wiki Contract](docs/wiki-contract.md) | [Release Policy](docs/release.md) |
[Contributing](CONTRIBUTING.md)

**Related projects:** OMW is designed to complement
[oh-my-codex (OMX)](https://github.com/Yeachan-Heo/oh-my-codex) and
[oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode).
Those projects orchestrate agent sessions; OMW gives those sessions a durable,
review-first place to store useful knowledge.

## Why OMW

LLM-assisted work produces useful context, but most of it disappears inside
chat transcripts. OMW helps you keep the durable parts without turning your
wiki into an application-specific silo.

Use OMW when you want to:

- connect any Markdown wiki, not only the bundled template
- start from an empty folder and create a safe Raw-note area
- search Markdown notes through SQLite FTS when supported, with scan fallback
- capture agent sessions, discussions, and daily reports as reviewable Raw notes
- generate ingest previews before promoting Raw notes into durable knowledge
- install Codex and Claude Code skills that teach agents how to use the wiki
- keep all knowledge local, inspectable, and Git-friendly

## Status

OMW is early but usable. The current release focuses on local CLI workflows,
contract generation, search, capture, queue inspection, ingest previews, daily
reports, wiki reports, validation, hooks, npm release automation, and managed
skills.

The project is suitable for people who are comfortable with a Markdown folder
and a terminal. It does not provide a web UI or hosted collaboration layer.

## Requirements

- Node.js 20 or newer.
- Git, if you want versioned notes.
- Node.js with `node:sqlite` support for the SQLite search backend. When it is
  unavailable, OMW falls back to a slower Markdown scan backend.

OMX and OMC are optional. OMW can wrap them when installed, but the wiki
features work without either runtime.

## Installation

From npm:

```bash
npm install -g oh-my-wiki
omw --help
```

From a local checkout:

```bash
git clone https://github.com/mr-yuns/oh-my-wiki.git
cd oh-my-wiki
npm install -g .
omw --help
```

For development without global installation:

```bash
node src/cli/omw.js --help
```

## Quick Start

Create or connect a wiki:

```bash
omw init --wiki /path/to/my-wiki --language en
omw doctor
omw wiki status
```

`omw init` is idempotent. Empty wiki directories are seeded from the bundled
base wiki; non-empty Markdown folders are connected in place and scanned for a
contract without overwriting existing notes.

From a local checkout, you can also try OMW against a disposable copy of the
bundled base wiki:

```bash
OMW_DEMO_ROOT="$(mktemp -d)"
cp -R .wiki "$OMW_DEMO_ROOT/wiki"
export OH_MY_WIKI_HOME="$OMW_DEMO_ROOT/state"

node src/cli/omw.js setup \
  --wiki "$OMW_DEMO_ROOT/wiki" \
  --language en \
  --no-hooks \
  --codex-home "$OMW_DEMO_ROOT/codex" \
  --claude-home "$OMW_DEMO_ROOT/claude"

node src/cli/omw.js doctor
node src/cli/omw.js wiki status
```

Connect an existing Markdown wiki:

```bash
omw setup --wiki /path/to/my-wiki
omw wiki refresh
omw search "knowledge map"
```

Capture a session summary as a Raw note:

```bash
printf '%s\n' "What happened, what changed, and what should be remembered." |
  omw capture --title "Session summary" --stdin
```

Create or update a daily report Raw note:

```bash
printf '%s\n' "- Documented the wiki runtime" |
  omw daily --author "Alex" --team "Docs" --date 2026-05-18 --stdin
```

Review the Raw queue and generate an ingest preview:

```bash
omw queue
RAW_NOTE="$(omw queue --json |
  node -e "let input=''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => console.log(JSON.parse(input).items[0].relativePath));")"
omw ingest "$RAW_NOTE"
```

Summarize and validate the connected wiki:

```bash
omw report-raw-ingest
omw report-daily --date 2026-05-18
omw validate
```

`omw validate` is profile-aware: OMW base wikis keep the bundled strict
frontmatter/navigation rules, while connected generic Markdown wikis are checked
against the generated wiki contract plus portable Markdown safety checks.

See [docs/demo-workflow.md](docs/demo-workflow.md) for the full copy-paste
demo flow used by the test suite.

## Core Concepts

### Wiki Contract

OMW writes a local contract at:

```text
<wiki>/.omw/contract.json
```

The contract describes how OMW should interact with your wiki:

- active language
- search root and excluded directories
- Raw-note root and Raw-note types
- templates for captured notes
- ingest states and pending states
- operating rule documents, when OMW can detect them
- daily report headings and placeholders
- runtime capabilities
- structure understanding score and missing dimensions

The contract is generated by scanning the wiki. OMW preserves user-owned
extensions when regenerating scanner-owned sections. If OMW can only infer a
personal wiki structure, `omw wiki contract --explain` reports an understanding
score below `100` with a Wiki-specific Deep Interview handoff before
write-oriented workflows should rely on that structure.

See [docs/wiki-contract.md](docs/wiki-contract.md) for the schema, supported
layouts, scanner-owned fields, and extension rules.

### Base Wiki

This repository includes a tracked `.wiki` folder. It is a starter knowledge
base with English and Korean layouts:

```text
.wiki/
  en/
  ko/
```

The tracked base wiki contains only reusable Markdown content, templates, and
editor defaults. OMW runtime files such as `.omw/contract.json`, search indexes,
ingest drafts, and report/validation logic are generated or provided by the CLI
outside the repository base wiki.

You can use it directly, fork it, or ignore it and connect another Markdown
folder with `omw setup --wiki <path>`.

### Raw Notes

Raw notes are source material. They are intentionally review-first:

1. capture raw context
2. inspect the Raw queue
3. generate an ingest preview
4. optionally write a draft-status durable note to an explicit target
5. curate that promoted draft before treating it as stable knowledge
6. refresh the search index

OMW does not guess where durable knowledge belongs. Promotion only writes when
you pass `--promote --target <relative-note.md>`, and existing promoted notes
are protected unless you opt into `--overwrite-promote`.

### Search

`omw search` and `omw wiki search` search the active wiki. The default backend
is `auto`:

- `sqlite`: preferred when `node:sqlite` is available
- `scan`: fallback backend that walks Markdown files directly

Search respects the contract's active search root and excluded directories, so
Raw queues, templates, and source folders can stay out of normal results.
Ranking weights can be tuned with `search.ranking` in the wiki contract.
Use `--type`, `--status`, and `--path` to narrow results by detected
frontmatter metadata or wiki-relative paths. Non-JSON output includes the
selected backend and fallback reason when SQLite search falls back to scan.
SQLite JSON reports `unfilteredTotalExact: false` when it returns a bounded
candidate window instead of running an expensive exact all-match count.
Index refresh JSON includes backend, index path, and scan/change/delete counts
when SQLite indexing is available.

## Commands

| Command | Purpose |
| --- | --- |
| `omw setup [--wiki <path>] [--language en|ko] [--wiki-auto-capture]` | Configure OMW and generate the wiki contract. |
| `omw init [--wiki <path>] [--language en|ko] [--json]` | Create or connect a wiki safely, then write config and contract. |
| `omw doctor [--json]` | Check config, wiki readiness, and optional wrappers. |
| `omw paths` | Print OMW state and configured paths. |
| `omw wiki status [--json]` | Show connected wiki and contract health. |
| `omw wiki init [--wiki <path>] [--language en|ko] [--json]` | Wiki-scoped alias for `omw init`. |
| `omw wiki contract [--refresh] [--dry-run] [--explain|--validate] [--json]` | Regenerate, preview, explain, or validate `.omw/contract.json` from the wiki. |
| `omw wiki contract --explain` | Print a concise summary of the active contract. |
| `omw wiki contract --validate` | Validate the active contract's required schema shape. |
| `omw wiki refresh [--target all|contract|index] [--dry-run] [--json]` | Refresh or preview contract and/or search index work. |
| `omw wiki search "<query>" [--backend auto|sqlite|scan] [--limit <n>] [--type <type>] [--status <status>] [--path <path>] [--sort relevance|path|title] [--json]` | Search wiki notes through the wiki command group. |
| `omw wiki capture --title "<title>" [--type agent_session|discussion] [--stdin|--body <text>] [--json]` | Wiki-scoped form of Raw note capture. |
| `omw wiki queue [--json]` | Wiki-scoped pending Raw note queue. |
| `omw wiki ingest <raw-note> [--write-draft] [--overwrite-draft] [--json]` | Wiki-scoped Raw note ingest preview and draft workflow. |
| `omw wiki ingest <raw-note> --promote --target <relative-note.md> [--overwrite-promote] [--json]` | Wiki-scoped Raw note promotion workflow. |
| `omw wiki daily --author <name> --team <team> --date YYYY-MM-DD [--stdin|--body <text>] [--json]` | Wiki-scoped daily report Raw note creation. |
| `omw wiki report-raw-ingest [--language en|ko]` | Wiki-scoped Raw ingest state summary. |
| `omw wiki report-daily [--language en|ko] [--date YYYY-MM-DD] [--author <name>] [--team <team>]` | Wiki-scoped daily report summary. |
| `omw wiki validate [--json]` | Wiki-scoped validation. |
| `omw search "<query>" [--backend auto|sqlite|scan] [--limit <n>] [--type <type>] [--status <status>] [--path <path>] [--sort relevance|path|title] [--json]` | Search wiki notes. Alias for `omw wiki search`. |
| `omw capture --title "<title>" [--type agent_session|discussion] [--stdin|--body <text>] [--json]` | Capture an agent-session or discussion Raw note. |
| `omw queue [--json]` | List pending Raw notes. |
| `omw ingest <raw-note> [--write-draft] [--overwrite-draft] [--json]` | Build a review-only ingest preview or write/replace a protected review draft for a Raw note. |
| `omw ingest <raw-note> --promote --target <relative-note.md> [--overwrite-promote] [--json]` | Write a draft-status durable note to an explicit wiki-relative target and mark the Raw note promoted. Base-wiki targets receive section-aware draft frontmatter. |
| `omw daily --author <name> --team <team> --date YYYY-MM-DD [--stdin|--body <text>] [--json]` | Create or update a daily report Raw note. |
| `omw report-raw-ingest [--language en|ko]` | Summarize Raw ingest states and targets. |
| `omw report-daily [--language en|ko] [--date YYYY-MM-DD] [--author <name>] [--team <team>]` | Summarize daily report Raw notes. |
| `omw validate [--json]` | Validate the connected wiki with profile-aware base or contract rules. |
| `omw wiki --help` | Show wiki command group help. |
| `omw codex-hooks install` | Install Codex hook entries. |
| `omw codex-hooks status` | Report Codex hook installation status. |
| `omw codex-hooks uninstall` | Remove managed Codex hook entries. |
| `omw claude-hooks install` | Install Claude Code hook entries. |
| `omw claude-hooks status` | Report Claude Code hook installation status. |
| `omw claude-hooks uninstall` | Remove managed Claude Code hook entries. |
| `omw skills install --platform codex` | Install managed Codex skills. |
| `omw skills install --platform claude` | Install managed Claude Code skills. |
| `omw skills status --platform codex|claude` | Report managed skill installation status. |
| `omw skills list --platform codex|claude` | List managed skills for a platform. |
| `omw skills uninstall --platform codex|claude` | Remove managed skills for a platform. |
| `omw omx -- <args>` | Run OMX with OMW environment variables. |
| `omw omc -- <args>` | Run OMC with OMW environment variables. |
| `omw -- <omx args>` | Pass arguments through to OMX with OMW environment variables. |
| `omw <omx launch flags>` | Launch OMX directly when the first argument is an OMX launch flag such as `--model`. |

Top-level aliases are provided for the most common wiki commands:

```bash
omw search "topic"
omw capture --title "Session" --stdin
omw daily --author "Alex" --team "Docs" --date 2026-05-18 --stdin
omw queue
omw ingest <raw-note>
omw report-raw-ingest
omw report-daily
omw validate
```

These aliases map directly to the wiki command group: `omw wiki search`,
`omw wiki capture`, `omw wiki queue`, `omw wiki ingest`, `omw wiki daily`,
`omw wiki report-raw-ingest`, `omw wiki report-daily`, and
`omw wiki validate`.

## Configuration

OMW stores runtime state under `~/.omw` by default.
Runtime JSON/TOML updates for config, contracts, hooks, hook events, and managed
skill markers are written through a same-directory temporary file and rename so
partial writes do not replace the previous valid state.
If local config or hook JSON is already corrupt, `omw doctor --json` reports the
broken file as an issue or warning, and `omw setup` / hook install commands can
rewrite the managed runtime files.
Generated wiki-local writes such as captures, daily reports, ingest drafts,
promoted-note overwrites, Raw ingest-state updates, and fallback templates use
the same safe-write boundary where replacement is expected.

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `OH_MY_WIKI_HOME` | Override the OMW state root. |
| `OMW_WIKI_PATH` | Default wiki path for setup. |
| `OMW_WIKI_LANGUAGE` | Default language for setup, such as `en` or `ko`. |
| `OMW_OMX_BIN` | Override the OMX command used by wrappers. |
| `OMW_OMC_BIN` | Override the OMC command used by wrappers. |

Hook auto capture is disabled by default. Enable it explicitly:

```bash
omw setup --wiki /path/to/wiki --wiki-auto-capture
```

When auto capture is enabled, Stop hooks store only a short redacted transcript
excerpt. They do not store the full transcript or transcript path, and transcript
read failures are recorded as best-effort metadata without blocking the agent
runtime.

Disable hooks during setup:

```bash
omw setup --wiki /path/to/wiki --no-hooks
```

## Managed Skills

OMW ships Codex and Claude Code skills for common wiki workflows:

- `wiki-search`
- `wiki-capture`
- `wiki-ingest`
- `wiki-refresh`
- `wiki-daily-report`
- `wiki-autopilot`

Install them with:

```bash
omw skills install --platform codex
omw skills install --platform claude
```

These skills are prompt surfaces. They do not replace the CLI; they teach agents
when and how to call the CLI safely.

OMW writes a `.omw-managed-skill.json` marker into installed skills. Reinstall
only replaces skills with that marker; unmanaged user skills with the same
directory name are left untouched and reported as an error.

Inspect or remove managed skills with:

```bash
omw skills status --platform codex
omw skills uninstall --platform codex --name wiki-search
```

## Security and Privacy

OMW is local-first, but it still handles sensitive session material. The runtime
includes redaction for common secret-like strings, JWTs, bearer tokens, GitHub
tokens, OpenAI/Anthropic-style API keys, npm tokens, Slack tokens and webhooks,
AWS access keys, cookie headers, environment-style secret assignments, private
keys, signed URL query secrets, local paths, and session IDs when capturing Raw
notes. Redaction is a safety net, not a substitute for review.

Recommended practice:

- Keep generated Raw notes reviewable and short.
- Do not paste credentials, tokens, signed URLs, or private keys into captures.
- Review Raw notes before promoting information into durable notes.
- Keep `.omw/index.sqlite` and other generated runtime files out of Git unless
  you intentionally want to version them.

The bundled `.wiki/.gitignore` excludes generated OMW state by default.

## Development

Clone and run the test suite:

```bash
git clone https://github.com/mr-yuns/oh-my-wiki.git
cd oh-my-wiki
npm test
npm run check
```

Useful commands while working locally:

```bash
node src/cli/omw.js setup --no-hooks
node src/cli/omw.js wiki status
node src/cli/omw.js wiki refresh
node src/cli/omw.js search "knowledge"
```

The project uses Node's built-in test runner and has no runtime npm
dependencies.

## Repository Layout

```text
src/cli/          CLI entrypoint
src/commands/     Command handlers
src/config/       Local config loading and validation
src/platforms/    Codex and Claude Code hook installers
src/runtime/      OMW state-root helpers
src/skills/       Managed skill installer
src/wiki/         Contract, scanner, search, capture, ingest, daily reports
skills/           Bundled Codex and Claude Code skills
.wiki/            Bundled base wiki
test/             Node test suite
```

## Contributing

Issues and pull requests are welcome. Please keep the project local-first,
Markdown-native, dependency-light, and review-first for any workflow that writes
to a user's wiki.

Before opening a pull request:

```bash
npm run check
git diff --check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines,
[docs/commits.md](./docs/commits.md) for commit message rules,
[docs/branches.md](./docs/branches.md) for branch naming rules, and
[docs/release.md](./docs/release.md) for the CI and publish checklist.

## License

MIT. See [LICENSE](./LICENSE).
