# Contributing to Oh My Wiki

Thanks for taking the time to improve Oh My Wiki.

OMW is a local-first runtime for Markdown knowledge bases. The most important
project values are:

- keep user data local
- keep Markdown files human-readable
- keep generated files easy to ignore or regenerate
- keep workflows review-first before durable wiki writes
- avoid new runtime dependencies unless they clearly pay for themselves

## Development Setup

```bash
git clone https://github.com/mr-yuns/oh-my-wiki.git
cd oh-my-wiki
npm test
npm run check
```

You can run the CLI directly from a checkout:

```bash
node src/cli/omw.js --help
node src/cli/omw.js setup --wiki .wiki --no-hooks
node src/cli/omw.js wiki status
```

## Pull Request Checklist

Before opening a pull request, please run:

```bash
npm run check
git diff --check
npm pack --dry-run
```

For wiki behavior changes, add or update tests under `test/`. Prefer focused
fixtures that describe the wiki layout being tested.

## Commit Messages

OMW uses Conventional Commits. Commit subjects should look like:

```text
feat: add wiki init command
fix(search): skip sqlite-only test without node:sqlite
ci(release): validate npm publish setup
```

See [docs/commits.md](./docs/commits.md) for allowed types and examples.

## Branch Names

Use lowercase type-prefixed branches such as `feat/wiki-init`,
`fix/sqlite-node20`, or `ci/npm-publish`. See
[docs/branches.md](./docs/branches.md) for the full branch policy.

## Design Guidelines

- Prefer scanner-based detection over hardcoded wiki layouts.
- Preserve user-owned contract extensions when regenerating OMW-owned fields.
- Treat Raw notes as source material, not durable knowledge.
- Do not make ingest flows silently rewrite durable notes.
- Keep Codex and Claude Code skill text short, explicit, and operational.
- Keep CLI output useful in both human-readable and `--json` forms when
  practical.

## Documentation

If a command or workflow changes, update `README.md` in the same pull request.
If managed skills change, update both Codex and Claude Code skill variants when
the behavior should remain equivalent.

## Release Policy

See [docs/release.md](./docs/release.md) for the full CI and publish checklist.
Publishable changes must bump `package.json` and update `CHANGELOG.md` with the
next sequential SemVer version. Documentation-only changes under `docs/`,
`examples/`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, or `LICENSE` do not
require a version bump.

## Security and Privacy

Do not add sample tokens, signed URLs, secrets, private local paths, or personal
identifiers to tests or documentation. When adding capture behavior, verify that
sensitive text is redacted or explicitly documented as user-reviewed source
material.
