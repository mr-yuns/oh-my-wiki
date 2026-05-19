---
name: wiki-autopilot
description: Search, capture, ingest-preview, and refresh wiki knowledge in one conservative review-first flow.
metadata:
  short-description: Search, capture, ingest-preview, and refresh wiki knowledge in one conservative review-first flow.
---

# Wiki Autopilot

Use when the user asks to keep wiki knowledge up to date.

1. Run `omw wiki contract --explain --json` before write-oriented actions.
2. If `understanding.score` is below `100`, follow the `wiki-deep-interview` handoff prompt and answer missing dimensions before capture, draft, or promote writes.
3. Search first with `omw wiki search "<topic>"`.
4. If reusable knowledge is missing and the contract is understood, capture a Raw note.
5. Use ingest preview before any durable promotion.
6. Refresh the contract or index when structure or searchable content changed.
7. Keep all durable writes review-first.
