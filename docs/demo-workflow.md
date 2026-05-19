# Demo Workflow

This demo runs OMW against a disposable copy of the bundled base wiki. It is
safe to paste into a shell from a local checkout because all state is written
under a temporary directory.

```bash
OMW_DEMO_ROOT="$(mktemp -d)"
cp -R .wiki "$OMW_DEMO_ROOT/wiki"
export OH_MY_WIKI_HOME="$OMW_DEMO_ROOT/state"

node src/cli/omw.js setup \
  --wiki "$OMW_DEMO_ROOT/wiki" \
  --language en \
  --no-hooks \
  --codex-home "$OMW_DEMO_ROOT/codex" \
  --claude-home "$OMW_DEMO_ROOT/claude"

node src/cli/omw.js doctor
node src/cli/omw.js wiki status

printf '%s\n' "Captured from the public demo workflow." |
  node src/cli/omw.js capture --title "Demo session" --stdin

printf '%s\n' "- Verified the public demo workflow" |
  node src/cli/omw.js daily \
    --author "Alex" \
    --team "Docs" \
    --date 2026-05-18 \
    --stdin

node src/cli/omw.js queue
node src/cli/omw.js search "Knowledge Map"
node src/cli/omw.js report-raw-ingest
node src/cli/omw.js report-daily --date 2026-05-18
node src/cli/omw.js validate
```

To preview ingest for one queued Raw note:

```bash
RAW_NOTE="$(node src/cli/omw.js queue --json |
  node -e "let input=''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => console.log(JSON.parse(input).items[0].relativePath));")"

node src/cli/omw.js ingest "$RAW_NOTE"
```

The ingest command is intentionally review-only. It prints the source Raw note,
an excerpt, and rule notes to review before you manually promote durable wiki
knowledge.

