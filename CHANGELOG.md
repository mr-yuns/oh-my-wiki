# Changelog

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
