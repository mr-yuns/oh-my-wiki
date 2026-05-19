---
name: wiki-ingest
description: Preview how a Raw note should be reviewed before durable wiki promotion.
metadata:
  short-description: Preview how a Raw note should be reviewed before durable wiki promotion.
---

# Wiki Ingest

Use when a Raw note should be reviewed for promotion.

1. Run `omw wiki queue` to find pending Raw notes.
2. Run `omw wiki contract --explain --json` before draft or promotion writes.
3. If `understanding.score` is below `100`, follow the `wiki-deep-interview` handoff prompt and answer missing dimensions before write-oriented ingest actions.
4. Run `omw wiki ingest "<raw-note-path>"`.
5. Use `omw wiki ingest "<raw-note-path>" --write-draft` only when a review draft should be written under `.omw/ingest-drafts/`.
6. Add `--overwrite-draft` only when intentionally replacing an existing review draft.
7. Read the listed operating-rule notes before proposing durable writes.
8. Do not create promoted notes unless the user explicitly approves.
