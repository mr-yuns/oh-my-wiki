---
name: wiki-search
description: Search the configured base wiki before answering questions that may depend on existing Markdown knowledge.
metadata:
  short-description: Search the configured base wiki before answering questions that may depend on existing Markdown knowledge.
---

# Wiki Search

Use when a task may depend on existing wiki knowledge.

1. Run `omw wiki search "<query>"` or `omw search "<query>"`.
2. Prefer `--json` when you need exact paths and excerpts.
3. Cite the note paths you used.
4. If search returns nothing, say that clearly and continue from available context.
