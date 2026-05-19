---
name: wiki-capture
description: Capture reusable session knowledge into the configured wiki as a Raw note.
metadata:
  short-description: Capture reusable session knowledge into the configured wiki as a Raw note.
---

# Wiki Capture

Use when the current work produced reusable knowledge.

1. Summarize only reusable, non-secret knowledge.
2. Run `omw wiki contract --explain --json` before writing.
3. If `understanding.score` is below `100`, follow the `wiki-deep-interview` handoff prompt and answer missing dimensions before capture.
4. Run `omw wiki capture --type agent_session --title "<title>" --stdin`.
5. Never include credentials, signed URLs, local private paths, or raw transcripts.
6. Mention the created Raw note path.
