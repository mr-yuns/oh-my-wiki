# Branch Naming Rules

OMW branches use lowercase type prefixes.

## Format

```text
<type>/<short-slug>
```

Examples:

```text
feat/wiki-init
fix/sqlite-node20
docs/release-guide
ci/npm-publish
```

## Allowed Branches

Long-lived branches:

- `main`
- `develop`
- `dev`

Release branches:

```text
release/0.3.9
```

Work branches:

| Type | Use for |
| --- | --- |
| `feat/` | New capability. |
| `fix/` | Bug fix. |
| `docs/` | Documentation-only change. |
| `chore/` | Maintenance. |
| `test/` | Tests. |
| `refactor/` | Refactoring. |
| `ci/` | GitHub Actions or release automation. |
| `hotfix/` | Urgent production/release fix. |

Slug rules:

- lowercase letters and numbers
- separators: `-`, `_`, or `.`
- no spaces

## Verification

CI validates branch names for pull requests and direct pushes. You can check a
branch locally:

```bash
node scripts/git-policy.mjs branch "fix/sqlite-node20"
```
