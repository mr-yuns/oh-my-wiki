# Release Checklist

OMW publishes from GitHub Actions when changes land on `main`.

## Before Merge

Run the local checks:

```bash
npm run check
git diff --check
npm pack --dry-run
```

Publishable changes must update both `package.json` and `CHANGELOG.md` with the
next sequential SemVer version. Documentation-only changes under `docs/`,
`examples/`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, or `LICENSE` do not
require a package version bump.

## CI Gates

The CI workflow runs:

- branch-name and Conventional Commit policy checks
- version policy checks for pull requests and `main`
- Node.js checks on Node 20 and Node 22
- `npm pack --dry-run`
- npm publish on `main` when the package version has not already been published

Manual `workflow_dispatch` releases skip branch and commit-subject checks because
they publish the already-merged `main` revision. The version-policy job still
runs, but it treats the merged `main` commit as already checked and exits early;
tests, packaging, and npm publish checks still run.

## npm Trusted Publishing

The publish job uses npm Trusted Publishing through GitHub Actions OIDC. The npm
package settings must trust this repository and the `ci.yml` workflow filename.

Expected npm Trusted Publisher settings:

- Provider: GitHub Actions
- Organization or user: `mr-yuns`
- Repository: `oh-my-wiki`
- Workflow filename: `ci.yml`
- Environment: empty unless the workflow adds a GitHub environment

Trusted publishing requires npm CLI 11.5.1 or newer and Node.js 22.14.0 or
newer in the publish job. The workflow publishes on Node 24 and grants
`id-token: write` to the publish job.

If a publishable change reaches `main` with an already-published package version,
the publish job fails and asks for a version and changelog update.
