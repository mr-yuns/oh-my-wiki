---
name: wiki-daily-report
description: Append or update one daily report Raw note per author/date in the configured wiki.
metadata:
  short-description: Append or update one daily report Raw note per author/date in the configured wiki.
---

# Wiki Daily Report

Use when the user wants a daily report captured.

1. Confirm author, team, and date.
2. Run `omw wiki daily --author "<name>" --team "<team>" --date YYYY-MM-DD --stdin`.
3. The same author/date should update the existing note instead of creating duplicates.
4. Keep sensitive information out of the report.
