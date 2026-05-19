---
name: wiki-refresh
description: Refresh the configured wiki contract and optional search index.
metadata:
  short-description: Refresh the configured wiki contract and optional search index.
---

# Wiki Refresh

Use when wiki folders, templates, operating rules, or search material changed.

1. Run `omw wiki refresh` for contract plus optional SQLite index.
2. Run `omw wiki refresh --target contract` when structure/templates changed.
3. Run `omw wiki refresh --target index` when only searchable notes changed.
4. Report any issues exactly.
