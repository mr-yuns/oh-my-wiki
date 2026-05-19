---
name: wiki-ingest
description: Preview how a Raw note should be reviewed before durable wiki promotion.
metadata:
  short-description: Preview how a Raw note should be reviewed before durable wiki promotion.
---

# Wiki Ingest

Use when a Raw note should be reviewed for promotion.

1. Run `omw wiki queue` to find pending Raw notes.
2. Run `omw wiki ingest "<raw-note-path>"`.
3. Use `omw wiki ingest "<raw-note-path>" --write-draft` only when a review draft should be written under `.omw/ingest-drafts/`.
4. Add `--overwrite-draft` only when intentionally replacing an existing review draft.
5. Read the listed operating-rule notes before proposing durable writes.
6. Do not create promoted notes unless the user explicitly approves.
