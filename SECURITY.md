# Security Policy

Oh My Wiki is local-first software. It does not run a hosted service, but it can
process sensitive session summaries, paths, and notes. Please treat wiki
captures as user-owned source material.

## Supported Versions

Security fixes target the latest released version.

## Reporting a Vulnerability

Please report suspected vulnerabilities through GitHub issues if the details are
not sensitive. If the report includes private exploit details, credentials, or
personal data, open a minimal issue asking for a private contact path instead of
posting the sensitive material publicly.

Useful reports include:

- affected version or commit
- operating system and Node.js version
- command or workflow involved
- expected behavior
- actual behavior
- minimal reproduction steps

## Sensitive Data Handling

OMW attempts to redact common secret-like strings, local paths, and session IDs
when capturing Raw notes. Redaction is a safety net, not a guarantee. Users and
agents should still avoid capturing credentials, tokens, signed URLs, private
keys, and personal identifiers.

Generated files such as `.omw/index.sqlite` should normally stay out of Git
unless a user intentionally versions them.
