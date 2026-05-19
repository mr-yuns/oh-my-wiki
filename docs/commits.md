# Commit Message Rules

OMW uses Conventional Commits for commit subjects.

## Format

```text
<type>(optional-scope)!: <summary>
```

Examples:

```text
feat: add wiki init command
fix(search): skip sqlite-only tests when node:sqlite is unavailable
docs: describe npm release setup
ci: validate branch and commit naming
```

## Types

Use one of these types:

| Type | Use for |
| --- | --- |
| `feat` | New user-facing capability. |
| `fix` | Bug fix or behavior correction. |
| `docs` | Documentation-only change. |
| `style` | Formatting-only code change. |
| `refactor` | Code restructuring without behavior change. |
| `perf` | Performance improvement. |
| `test` | Test-only change. |
| `build` | Build, packaging, or dependency metadata. |
| `ci` | GitHub Actions or release automation. |
| `chore` | Maintenance that does not fit another type. |
| `revert` | Reverting a previous commit. |

Scopes are optional and should be lowercase:

```text
fix(wiki): keep ingest previews no-write by default
ci(release): publish with npm trusted publishing
```

Use `!` for breaking changes:

```text
feat(cli)!: rename setup flags
```

## Rules

- Keep the subject under 100 characters.
- Use lowercase types.
- Write the summary in imperative mood.
- Do not end the subject with a period.
- Prefer a short body when the change needs context.

## Verification

The repository validates commit subjects in CI for pull requests and direct
pushes. You can check a subject locally:

```bash
node scripts/git-policy.mjs subject "feat: add wiki init command"
```

Merge commits are exempt from commit-subject validation. Prefer squash or
rebase merges so the commit that lands on `main` still follows this format.
