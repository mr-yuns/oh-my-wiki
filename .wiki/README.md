# OMW base wiki

This folder contains multilingual base wiki templates for Oh My Wiki.

- `en/`: English base wiki
- `ko/`: Korean base wiki

The tracked base wiki contains reusable Markdown content, templates, placeholder
folders, and minimal ignore rules only. Runtime contracts, indexes, generated
drafts, editor-local settings, and report or validation logic are generated only
for the active wiki and are excluded from Git and npm packaging. When this
repository `.wiki` is used directly, local runtime files may appear under
`.wiki/.omw/`; they must stay ignored and unpacked.

Choose the language during setup:

```bash
omw setup --language en
omw setup --language ko
```

The public base wiki contains operating rules and templates only. Do not add real team, customer, product, or personal notes here.
