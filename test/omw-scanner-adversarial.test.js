import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

function execFileWithInput(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { code, signal, stdout, stderr }));
    });
    child.stdin.end(options.input || '');
  });
}

async function setupWiki(prefix, language = 'en') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(wiki, { recursive: true });
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  const setupArgs = [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    language,
    '--no-hooks',
    '--codex-home',
    path.join(root, 'codex'),
    '--claude-home',
    path.join(root, 'claude'),
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ];
  return { root, home, wiki, env, setupArgs };
}

test('scanner bootstraps an empty wiki with generated fallback capture and queue', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-empty-scanner-');
  await execFileAsync(process.execPath, setupArgs, { env });

  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.source.profile, 'generic-markdown');
  assert.equal(contract.capabilities.search.ready, false);
  assert.equal(contract.capabilities.capture.ready, true);
  assert.equal(contract.raw.root, '.omw/raw');

  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Empty wiki capture',
    '--body',
    'bootstrapped body',
  ], { env });

  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].state, 'captured');
});

test('scanner treats uppercase markdown and underscore template folders as normal wiki input', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-uppercase-scanner-');
  await mkdir(path.join(wiki, '_templates'), { recursive: true });
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, '_templates/session.MD'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'notes/Upper.MD'), '# Upper Case Note\n\nSearchable uppercase markdown.\n');
  await writeFile(path.join(wiki, 'notes/Component.mdx'), '# Component Note\n\nSearchable mdx markdown.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.types.agent_session.agentTemplate, '_templates/session.MD');
  assert(contract.search.excludeDirs.includes('_templates'));

  const search = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'uppercase markdown', '--json'], { env })).stdout);
  assert.equal(search.ok, true);
  assert(search.results.some((item) => item.relativePath === 'notes/Upper.MD'));
  assert(search.results.every((item) => !item.relativePath.startsWith('_templates/')));
  const mdxSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'mdx markdown', '--json'], { env })).stdout);
  assert(mdxSearch.results.some((item) => item.relativePath === 'notes/Component.mdx'));
});

test('scanner avoids classifying source-materials as raw root when explicit raw exists', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-raw-vs-source-scanner-');
  await mkdir(path.join(wiki, 'source-materials'), { recursive: true });
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'wiki'), { recursive: true });
  await writeFile(path.join(wiki, 'source-materials/interview.md'), '# Interview\n\nRaw-ish source text.\n');
  await writeFile(path.join(wiki, 'raw/sessions/existing.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'status: new',
    '---',
    '# Existing Raw',
    '',
    'Existing raw body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'wiki/index.md'), '# Index\n\nDurable knowledge.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'raw');
  assert.equal(contract.raw.types.agent_session.folder, 'sessions');
  assert.equal(contract.search.root, 'wiki');
  assert(!contract.search.excludeDirs.includes('raw'));
  assert(!contract.search.excludeDirs.includes('source-materials'));

  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].state, 'new');
  const rawSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Existing raw body', '--json'], { env })).stdout);
  assert.equal(rawSearch.total, 0);
});

test('scanner keeps global raw candidates when requested language notes also exist', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-global-raw-with-language-root-', 'en');
  await mkdir(path.join(wiki, 'en/notes'), { recursive: true });
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'en/notes/index.md'), '# English Notes\n\nDurable language-scoped note.\n');
  await writeFile(path.join(wiki, 'raw/sessions/existing.md'), [
    '---',
    'type: RawCustom',
    'rawType: agent_session',
    'ingestState: new-custom',
    '---',
    '# Existing Global Raw',
    '',
    'Existing global raw body.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'raw');
  assert.deepEqual(contract.raw.noteTypes, ['RawCustom']);
  assert.deepEqual(contract.ingest.pendingStates, ['new-custom']);
});

test('scanner prefers the selected global raw root over language-scoped durable ingest metadata', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-global-raw-durable-ingest-', 'en');
  await mkdir(path.join(wiki, 'en/notes'), { recursive: true });
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'en/notes/article.md'), [
    '---',
    'type: Article',
    'ingestState: stable',
    '---',
    '# Durable Article',
    '',
    'Language-scoped durable note with lifecycle metadata.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'raw/sessions/existing.md'), [
    '---',
    'type: RawCustom',
    'rawType: agent_session',
    'ingestState: new-custom',
    '---',
    '# Existing Global Raw',
    '',
    'Existing global raw body.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'raw');
  assert.deepEqual(contract.raw.noteTypes, ['RawCustom']);
  assert.deepEqual(contract.ingest.pendingStates, ['new-custom']);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].state, 'new-custom');
});

test('scanner excludes nested language raw folders from search', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-language-raw-search-exclude-', 'en');
  await mkdir(path.join(wiki, 'en/notes'), { recursive: true });
  await mkdir(path.join(wiki, 'en/notes/raw'), { recursive: true });
  await mkdir(path.join(wiki, 'en/01. Inbox/01-01. Raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'en/notes/index.md'), '# Durable Note\n\nSearchable durable material.\n');
  await writeFile(path.join(wiki, 'en/notes/raw/topic.md'), '# Legit Raw Topic\n\nlegitimate-raw-folder-note\n');
  await writeFile(path.join(wiki, 'en/01. Inbox/01-01. Raw/sessions/raw.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Raw Search Leak',
    '',
    'needle-only-in-raw-queue',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.search.root, 'en');
  assert(contract.search.excludeDirs.includes('01. Inbox/01-01. Raw'));

  const rawSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'needle-only-in-raw-queue', '--json'], { env })).stdout);
  assert.equal(rawSearch.total, 0);
  const legitimateRawFolderSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'legitimate-raw-folder-note', '--json'], { env })).stdout);
  assert(legitimateRawFolderSearch.results.some((item) => item.relativePath === 'en/notes/raw/topic.md'));
  const durableSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'durable material', '--json'], { env })).stdout);
  assert(durableSearch.results.some((item) => item.relativePath === 'en/notes/index.md'));
});

test('scanner does not let global raw exclusion hide language note folders named raw', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-global-raw-language-search-', 'en');
  await mkdir(path.join(wiki, 'en/notes/raw'), { recursive: true });
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'en/notes/raw/topic.md'), '# Raw Named Note Folder\n\nlanguage-note-raw-folder-token\n');
  await writeFile(path.join(wiki, 'raw/sessions/raw.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Global Raw',
    '',
    'global-raw-token',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.search.root, 'en');
  assert(!contract.search.excludeDirs.includes('raw'));

  const noteSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'language-note-raw-folder-token', '--json'], { env })).stdout);
  assert(noteSearch.results.some((item) => item.relativePath === 'en/notes/raw/topic.md'));
  const globalRawSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'global-raw-token', '--json'], { env })).stdout);
  assert.equal(globalRawSearch.total, 0);
});

test('scanner does not let top-level raw exclusion hide nested durable note folders named raw', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-top-raw-nested-note-search-', 'en');
  await mkdir(path.join(wiki, 'notes/raw'), { recursive: true });
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/raw/durable.md'), '# Durable Raw Named Folder\n\ndurable-notes-raw-token\n');
  await writeFile(path.join(wiki, 'raw/sessions/session.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Raw Session',
    '',
    'top-level-raw-token',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.search.root, '');
  assert(contract.search.excludeDirs.includes('raw'));

  const noteSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'durable-notes-raw-token', '--backend', 'scan', '--json'], { env })).stdout);
  assert(noteSearch.results.some((item) => item.relativePath === 'notes/raw/durable.md'));
  const rawSearch = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'top-level-raw-token', '--backend', 'scan', '--json'], { env })).stdout);
  assert.equal(rawSearch.total, 0);
});

test('scanner ignores runtime .omx markdown contamination', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-omx-contamination-scanner-');
  await mkdir(path.join(wiki, '.omx/state'), { recursive: true });
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, '.omx/state/runtime.md'), [
    '---',
    'type: RuntimeRaw',
    'rawType: agent_session',
    'status: runtime',
    '---',
    '# Runtime State',
    '',
    'This should never influence the scanner.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'notes/index.md'), '# Index\n\nClean durable note.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['captured', 'reviewing']);
  assert(!Object.values(contract.rules).some((rule) => rule.path.startsWith('.omx/')));
  assert.equal(contract.capabilities.rules.ready, false);
});

test('scanner ignores durable ingestState metadata when falling back to managed raw', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-durable-ingest-state-scanner-');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/article.md'), [
    '---',
    'type: Article',
    'ingestState: stable',
    '---',
    '# Durable Article',
    '',
    'This is a durable note that happens to use ingestState metadata.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['captured', 'reviewing']);
  const template = await readFile(path.join(wiki, '.omw/templates/agent_session.md'), 'utf8');
  assert.match(template, /type: Raw/);
  assert.match(template, /ingestState: captured/);

  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Fallback raw capture',
    '--body',
    'fallback raw body',
    '--json',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].state, 'captured');
});

test('scanner parses CRLF frontmatter in user raw notes', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-crlf-scanner-');
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'raw/sessions/win.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Windows Raw',
    '',
    'CRLF body.',
    '',
  ].join('\r\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['captured']);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
});

test('scanner does not treat code-fence placeholders in durable notes as templates', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-code-fence-scanner-');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/session-guide.md'), [
    '# Session Guide',
    '',
    '```md',
    '# {{title}}',
    '',
    '{{body}}',
    '```',
    '',
    'This is documentation, not a template.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.types.agent_session.agentTemplate, '.omw/templates/agent_session.md');
});

test('scanner ignores fenced placeholders even under documentation template folders', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-doc-template-fence-scanner-');
  await mkdir(path.join(wiki, 'docs/templates'), { recursive: true });
  await writeFile(path.join(wiki, 'docs/templates/session-guide.md'), [
    '# Session Guide',
    '',
    '```md',
    '# {{title}}',
    '',
    '{{body}}',
    '```',
    '',
    'This documents template syntax but is not itself a template.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.types.agent_session.agentTemplate, '.omw/templates/agent_session.md');
  assert(!contract.search.excludeDirs.includes('templates'));

  const search = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'documents template syntax', '--json'], { env })).stdout);
  assert(search.results.some((item) => item.relativePath === 'docs/templates/session-guide.md'));
});

test('scanner ignores indented and long fenced placeholders under documentation template folders', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-long-fence-scanner-');
  await mkdir(path.join(wiki, 'docs/templates'), { recursive: true });
  await writeFile(path.join(wiki, 'docs/templates/session-guide.md'), [
    '# Session Guide',
    '',
    '  ````md',
    '  # {{title}}',
    '',
    '  {{body}}',
    '  ````',
    '',
    '   ~~~~md',
    '   # {{title}}',
    '   {{body}}',
    '   ~~~~',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.types.agent_session.agentTemplate, '.omw/templates/agent_session.md');
});

test('scanner falls back to managed raw when raw-materials contains durable content only', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-raw-materials-scanner-');
  await mkdir(path.join(wiki, 'raw-materials'), { recursive: true });
  await writeFile(path.join(wiki, 'raw-materials/article.md'), [
    '---',
    'type: Article',
    'status: stable',
    '---',
    '# Raw Materials Article',
    '',
    'Durable content despite the folder name.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
});

test('scanner falls back to managed raw when raw-materials only has durable ingestState metadata', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-raw-materials-ingest-state-scanner-');
  await mkdir(path.join(wiki, 'raw-materials'), { recursive: true });
  await writeFile(path.join(wiki, 'raw-materials/article.md'), [
    '---',
    'type: Article',
    'ingestState: stable',
    '---',
    '# Raw Materials Article',
    '',
    'Durable content despite the folder name and ingestState key.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['captured', 'reviewing']);
});

test('scanner does not treat typed child folders under raw-materials as raw evidence without raw markers', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-raw-materials-typed-child-scanner-');
  await mkdir(path.join(wiki, 'raw-materials/agent_sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'raw-materials/agent_sessions/history.md'), [
    '---',
    'type: Article',
    'status: stable',
    '---',
    '# Session History',
    '',
    'Durable history content.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
});

test('scanner infers custom raw roots from strong raw markers without raw-ish folder names', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-custom-captures-root-scanner-');
  await mkdir(path.join(wiki, 'captures/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'captures/sessions/one.md'), [
    '---',
    'type: RawCustom',
    'rawType: agent_session',
    'ingestState: new-custom',
    '---',
    '# Captured Session',
    '',
    'Existing custom raw queue body.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'captures');
  assert.equal(contract.raw.types.agent_session.folder, 'sessions');
  assert.deepEqual(contract.raw.noteTypes, ['RawCustom']);
  assert.deepEqual(contract.ingest.pendingStates, ['new-custom']);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].state, 'new-custom');
});

test('scanner does not crash on raw notes with literal placeholders outside template folders', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-raw-placeholder-note-scanner-');
  await mkdir(path.join(wiki, 'captures/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'captures/sessions/one.md'), [
    '---',
    'type: RawCustom',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Captured',
    '',
    '{{body}}',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'captures');
  assert.deepEqual(contract.raw.noteTypes, ['RawCustom']);
});

test('scanner does not let language templates override a concrete custom raw root', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-template-vs-custom-root-scanner-', 'en');
  await mkdir(path.join(wiki, 'captures/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'en/templates'), { recursive: true });
  await writeFile(path.join(wiki, 'captures/sessions/one.md'), [
    '---',
    'type: RawCustom',
    'rawType: agent_session',
    'ingestState: new-custom',
    '---',
    '# Captured Session',
    '',
    'Existing custom raw queue body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'en/templates/session.md'), [
    '---',
    'type: Raw',
    'rawType: {{rawType}}',
    'ingestState: captured',
    '---',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'captures');
  assert.equal(contract.raw.types.agent_session.agentTemplate, 'en/templates/session.md');
  assert.deepEqual(contract.raw.noteTypes, ['RawCustom']);
  assert.deepEqual(contract.ingest.pendingStates, ['new-custom']);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].relativePath, 'captures/sessions/one.md');
});

test('scanner does not let concrete raw templates override a custom raw root', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-concrete-template-vs-custom-root-', 'en');
  await mkdir(path.join(wiki, 'captures/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'en/templates'), { recursive: true });
  await writeFile(path.join(wiki, 'captures/sessions/one.md'), [
    '---',
    'type: RawCustom',
    'rawType: agent_session',
    'ingestState: new-custom',
    '---',
    '# Captured Session',
    '',
    'Existing custom raw queue body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'en/templates/session.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, 'captures');
  assert.equal(contract.raw.types.agent_session.agentTemplate, 'en/templates/session.md');
  assert.deepEqual(contract.raw.noteTypes, ['RawCustom']);
  assert.deepEqual(contract.ingest.pendingStates, ['new-custom']);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.deepEqual(queue.items.map((item) => item.relativePath), ['captures/sessions/one.md']);
});

test('scanner does not false-positive Karpathy layout from unrelated docs index', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-karpathy-false-positive-scanner-');
  await mkdir(path.join(wiki, 'docs'), { recursive: true });
  await mkdir(path.join(wiki, 'sources'), { recursive: true });
  await mkdir(path.join(wiki, 'wiki'), { recursive: true });
  await writeFile(path.join(wiki, 'AGENTS.md'), '# Agent Schema\n\nGeneral project guidance.\n');
  await writeFile(path.join(wiki, 'docs/index.md'), '# Docs Index\n\nImportant docs index content.\n');
  await writeFile(path.join(wiki, 'sources/source.md'), '# Source\n\nSource content.\n');
  await writeFile(path.join(wiki, 'wiki/topic.md'), '# Topic\n\nTopic content.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.source.profile, 'generic-markdown');
  assert.equal(contract.search.root, '');

  const search = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'docs index content', '--json'], { env })).stdout);
  assert(search.results.some((item) => item.relativePath === 'docs/index.md'));
});

test('scanner supports Karpathy wiki index in mdx form', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-karpathy-mdx-index-scanner-');
  await mkdir(path.join(wiki, 'wiki'), { recursive: true });
  await mkdir(path.join(wiki, 'sources'), { recursive: true });
  await writeFile(path.join(wiki, 'AGENTS.md'), '# Agent Schema\n\nUse the wiki index as the knowledge map.\n');
  await writeFile(path.join(wiki, 'wiki/index.mdx'), '# Wiki Index\n\nKarpathy-style index in MDX.\n');
  await writeFile(path.join(wiki, 'wiki/topic.mdx'), '# Topic\n\nDurable wiki topic.\n');
  await writeFile(path.join(wiki, 'sources/source.md'), '# Source\n\nSource content.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.source.profile, 'karpathy-llm-wiki');
  assert.equal(contract.search.root, 'wiki');
  assert.equal(contract.rules.knowledgeMap.path, 'wiki/index.mdx');
});

test('scanner routes ambiguous multi-root raw layouts through contract handoff', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-ambiguous-raw-root-scanner-');
  await mkdir(path.join(wiki, 'team-a/raw/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'team-b/raw/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'team-a/raw/sessions/one.md'), [
    '---',
    'type: RawA',
    'rawType: agent_session',
    'ingestState: captured-a',
    '---',
    '# Team A Raw',
    '',
    'Team A raw body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'team-b/raw/sessions/two.md'), [
    '---',
    'type: RawB',
    'rawType: agent_session',
    'ingestState: captured-b',
    '---',
    '# Team B Raw',
    '',
    'Team B raw body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'notes/index.md'), '# Index\n\nDurable knowledge.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.understanding.complete, false);
  assert(contract.understanding.score < 100);
  assert.equal(contract.understanding.handoff.recommended, true);
  assert.equal(contract.understanding.handoff.workflow, 'wiki-deep-interview');
  assert(contract.understanding.missingDimensions.some((item) => item.key === 'raw'));
  assert.deepEqual(contract.raw.ambiguities.map((item) => item.root).sort(), ['team-a/raw', 'team-b/raw']);
});

test('scanner preserves custom contract extensions while regenerating scanner-owned sections', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-custom-extension-scanner-');
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'raw/sessions/existing.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Existing Raw',
    '',
    'Existing raw body.',
    '',
  ].join('\n'));
  await execFileAsync(process.execPath, setupArgs, { env });

  const contractPath = path.join(wiki, '.omw/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.customIntegration = { owner: 'user' };
  contract.raw.customRawOption = 'preserve-me';
  contract.raw.types.agent_session.customTypeOption = 'preserve-nested';
  contract.raw.types.custom_capture = {
    label: 'Custom Capture',
    folder: 'custom',
    humanTemplate: '.omw/templates/custom_capture.md',
  };
  contract.raw.root = 'stale/raw';
  await mkdir(path.join(wiki, 'raw/custom'), { recursive: true });
  await mkdir(path.join(wiki, '.omw/templates'), { recursive: true });
  await writeFile(path.join(wiki, '.omw/templates/custom_capture.md'), [
    '---',
    'type: Raw',
    'rawType: custom_capture',
    'ingestState: captured',
    'sensitivityCheck: {{sensitivityCheck}}',
    '---',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await execFileAsync(process.execPath, setupArgs, { env });
  const updated = JSON.parse(await readFile(contractPath, 'utf8'));
  assert.deepEqual(updated.customIntegration, { owner: 'user' });
  assert.equal(updated.raw.customRawOption, 'preserve-me');
  assert.equal(updated.raw.types.agent_session.customTypeOption, 'preserve-nested');
  assert.equal(updated.raw.types.custom_capture.folder, 'custom');
  assert.equal(updated.raw.root, 'raw');

  const capture = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--type',
    'custom_capture',
    '--title',
    'Custom raw capture',
    '--body',
    'custom body',
  ], { env });
  assert.match(capture.stdout, /Captured Raw note/);
});

test('scanner does not let another language raw tree poison requested language defaults', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-mixed-language-scanner-', 'en');
  await mkdir(path.join(wiki, 'ko/raw/세션'), { recursive: true });
  await mkdir(path.join(wiki, 'en/notes'), { recursive: true });
  await writeFile(path.join(wiki, 'ko/raw/세션/session.md'), [
    '---',
    '유형: Raw수집',
    'raw유형: 에이전트세션',
    'ingest상태: 수집됨',
    '---',
    '# Korean Raw',
    '',
    'Korean raw body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'en/notes/index.md'), '# English Index\n\nEnglish durable note.\n');

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.language, 'en');
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['captured', 'reviewing']);
  assert.equal(contract.raw.types.agent_session.folder, 'agent_sessions');
});

test('scanner treats an empty requested language root as active for raw defaults', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-empty-language-root-scanner-', 'en');
  await mkdir(path.join(wiki, 'en'), { recursive: true });
  await mkdir(path.join(wiki, 'ko/raw/세션'), { recursive: true });
  await writeFile(path.join(wiki, 'ko/raw/세션/session.md'), [
    '---',
    '유형: Raw수집',
    'raw유형: 에이전트세션',
    'ingest상태: 수집됨',
    '---',
    '# Korean Raw',
    '',
    'Korean raw body.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['captured', 'reviewing']);
});

test('queue title fallback strips mdx extension from heading-less raw notes', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-mdx-queue-title-');
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'raw/sessions/note.mdx'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '',
    'Heading-less mdx raw body.',
    '',
  ].join('\n'));

  await execFileAsync(process.execPath, setupArgs, { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].title, 'note');
});

test('refresh overwrites stale legacy contract sections with the scanned wiki shape', async () => {
  const { wiki, env, setupArgs } = await setupWiki('omw-refresh-scanner-');
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'raw/sessions/existing.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Existing Raw',
    '',
    'Existing raw body.',
    '',
  ].join('\n'));
  await execFileAsync(process.execPath, setupArgs, { env });

  const contractPath = path.join(wiki, '.omw/contract.json');
  const stale = JSON.parse(await readFile(contractPath, 'utf8'));
  stale.schemaVersion = 1;
  stale.raw.root = 'stale/raw';
  stale.raw.ambiguities = [{ kind: 'raw-root', root: 'stale/raw', score: 99, sources: ['stale'], evidence: ['stale/raw'] }];
  stale.raw.types.agent_session.folder = 'stale_sessions';
  stale.search.root = 'stale';
  await writeFile(contractPath, `${JSON.stringify(stale, null, 2)}\n`);

  await execFileWithInput(process.execPath, [cliPath, 'wiki', 'refresh'], { env });
  const refreshed = JSON.parse(await readFile(contractPath, 'utf8'));
  assert.equal(refreshed.schemaVersion, 2);
  assert.equal(refreshed.raw.root, 'raw');
  assert.deepEqual(refreshed.raw.ambiguities, []);
  assert.equal(refreshed.raw.types.agent_session.folder, 'sessions');
  assert.notEqual(refreshed.search.root, 'stale');
});
