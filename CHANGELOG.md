# Changelog

## 0.4.2

- Capture bounded, redacted Stop-hook transcript excerpts while keeping hook
  failures best-effort and omitting raw transcript paths from persisted notes.
- Report Codex/Claude hook readiness and stale hook drift from `omw doctor`
  as warnings without changing core readiness exit semantics.
- Extend Raw-note redaction and validation for OpenAI/Anthropic-style API keys,
  npm tokens, Slack tokens/webhooks, AWS access keys, cookie headers, and
  environment-style secret assignments.
- Add packaged-install smoke coverage that validates npm tarball contents,
  installed `omw`/`wiki-agent` bins, setup, doctor, capture, and search from an
  isolated external runtime directory.
- Include the base wiki contract file in packaged artifacts so fresh installs
  preserve the managed wiki contract.
- Make `omw validate` contract-aware so generic Markdown wikis are validated
  without requiring base-wiki frontmatter conventions.
- Add dry-run contract refresh previews for `omw wiki contract --refresh` and
  `omw wiki refresh` so scanner-owned contract changes can be reviewed before
  writing.
- Keep Raw-note and generic-wiki secret validation on the same detection rules
  to avoid drift across validation surfaces.
- Add hook repair regression coverage proving `codex-hooks install` and
  `claude-hooks install` replace stale OMW hook entries and stale state roots.
- Make contract refresh dry-runs exit successfully when preview generation
  succeeds, while still reporting current wiki readiness issues in JSON.
- Report SQLite search index refresh stats, including scanned, changed,
  deleted, and unchanged file counts.
- Write OMW JSON/TOML state updates atomically for config, wiki contracts,
  hooks, hook events, and managed skill markers.
- Report corrupt config and hook JSON as actionable diagnostics, and allow
  `setup` / hook install commands to repair those local runtime files.
- Extend safe writes to generated wiki-local files such as Raw captures, ingest
  drafts, promoted note overwrites, Raw ingest-state updates, daily reports, and
  scanner-managed fallback templates.

## 0.4.1

- Align public docs with explicit ingest promotion and hardened redaction
  behavior.
- Render base-wiki-aware promoted note frontmatter for explicit promotion
  targets in numbered base-wiki sections.
- Improve search output with backend visibility, fallback diagnostics, metadata
  filters, and stable path/title sorting.
- Add runtime contract shape validation via `omw wiki contract --validate`.
- Split scanner inventory and text-normalization helpers out of the main
  contract scanner module.

## 0.4.0

- Add explicit ingest promotion to a user-selected durable Markdown target.
- Record hook auto-capture success or failure details in event logs.
- Harden Raw-note redaction for JWTs, bearer tokens, GitHub tokens, private
  keys, and signed URL query secrets.
- Add contract explanation output and a public contract JSON Schema.
- Improve wiki command help and reduce npm package size by excluding
  heavyweight documentation image assets.

## 0.3.3

- Improve scan search fallback so multi-word queries can match separated terms
  while preserving Raw-note exclusions.

## 0.3.2

- Align release and branch documentation with the current npm-published project
  state and workflow behavior.

## 0.3.1

- Verify GitHub Actions npm Trusted Publishing with the initialized public
  release workflow.

## 0.3.0

- Initial public release of OMW as a local-first wiki runtime.
- Include wiki initialization, scanning, capture, ingest preview, daily reports,
  localized base wiki templates, and Codex/Claude skill bundles.
- Add Conventional Commit, branch naming, release, and npm Trusted Publishing
  policy documentation for open-source contributors.
