import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

test('base wiki capture to ingest e2e stays inside contract-approved paths', async () => {
  const repoWikiBefore = await snapshotFiles(path.resolve('.wiki'));
  const { env, wiki } = await setupBaseWiki('omw-base-e2e-', 'en');
  let before = await snapshotFiles(wiki);

  const captured = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'E2E Source',
    '--body',
    'E2E raw body for promotion.',
    '--json',
  ], { env })).stdout);
  const rawRef = path.relative(wiki, captured.path).split(path.sep).join('/');
  assertOnlyChanged(before, await snapshotFiles(wiki), [rawRef]);

  before = await snapshotFiles(wiki);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].relativePath, rawRef);
  assert.deepEqual(await snapshotFiles(wiki), before);

  const preview = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--json'], { env })).stdout);
  assert.equal(preview.writePerformed, false);
  assert.deepEqual(await snapshotFiles(wiki), before);

  const draft = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft', '--json'], { env })).stdout);
  assert.equal(draft.writePerformed, true);
  assert.match(draft.relativePath, /^\.omw\/ingest-drafts\//);
  assertOnlyChanged(before, await snapshotFiles(wiki), [draft.relativePath]);

  before = await snapshotFiles(wiki);
  const target = 'en/03. Permanent Notes/03-e2e-promoted.md';
  const promoted = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'ingest',
    rawRef,
    '--promote',
    '--target',
    target,
    '--json',
  ], { env })).stdout);
  assert.equal(promoted.promotion.relativePath, target);
  assert.equal(promoted.promotion.rawStateUpdated, true);
  assertOnlyChanged(before, await snapshotFiles(wiki), [rawRef, target]);

  before = await snapshotFiles(wiki);
  const daily = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'daily',
    '--author',
    'Safety User',
    '--team',
    'Runtime',
    '--date',
    '2026-05-19',
    '--body',
    '- Verified e2e write boundaries',
    '--json',
  ], { env })).stdout);
  assert.match(daily.relativePath, /^en\/01\. Inbox\/01-01\. Raw\/01-01-02\. Daily Reports\//);
  assertOnlyChanged(before, await snapshotFiles(wiki), [daily.relativePath]);

  const validation = await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env });
  assert.match(validation.stdout, /OK: base wiki validation passed/);
  assert.deepEqual(await snapshotFiles(path.resolve('.wiki')), repoWikiBefore);
});

test('generic wiki capture to ingest e2e writes only generated state and explicit durable target', async () => {
  const repoWikiBefore = await snapshotFiles(path.resolve('.wiki'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-generic-e2e-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/index.md'), '# Personal Index\n\nDurable personal note.\n');
  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    'en',
    '--no-hooks',
    '--codex-home',
    path.join(root, 'codex'),
    '--claude-home',
    path.join(root, 'claude'),
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ], { env });

  let before = await snapshotFiles(wiki);
  const captured = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Generic E2E Source',
    '--body',
    'Generic e2e raw body.',
    '--json',
  ], { env })).stdout);
  const rawRef = path.relative(wiki, captured.path).split(path.sep).join('/');
  assert.match(rawRef, /^\.omw\/raw\/agent_sessions\//);
  assertOnlyChanged(before, await snapshotFiles(wiki), [rawRef]);

  before = await snapshotFiles(wiki);
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].relativePath, rawRef);
  const preview = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--json'], { env })).stdout);
  assert.equal(preview.writePerformed, false);
  assert.deepEqual(await snapshotFiles(wiki), before);

  const draft = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft', '--json'], { env })).stdout);
  assert.match(draft.relativePath, /^\.omw\/ingest-drafts\//);
  assertOnlyChanged(before, await snapshotFiles(wiki), [draft.relativePath]);

  before = await snapshotFiles(wiki);
  const target = 'notes/promoted-generic-e2e.md';
  const promoted = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'ingest',
    rawRef,
    '--promote',
    '--target',
    target,
    '--json',
  ], { env })).stdout);
  assert.equal(promoted.promotion.relativePath, target);
  assert.equal(promoted.promotion.template, 'generic-draft');
  assertOnlyChanged(before, await snapshotFiles(wiki), [rawRef, target]);
  assert.deepEqual(await snapshotFiles(path.resolve('.wiki')), repoWikiBefore);
});

async function setupBaseWiki(prefix, language) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await cp(path.resolve('.wiki'), wiki, { recursive: true });
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await execFileAsync(process.execPath, [
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
  ], { env });
  return { root, home, wiki, env };
}

async function snapshotFiles(root, relativeDir = '') {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const snapshot = {};
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotFiles(root, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const [fileStat, content] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);
    snapshot[relativePath.split(path.sep).join('/')] = {
      size: fileStat.size,
      mtimeMs: Math.trunc(fileStat.mtimeMs),
      hash: createHash('sha256').update(content).digest('hex'),
    };
  }
  return snapshot;
}

function assertOnlyChanged(before, after, allowedPaths) {
  const changed = changedPaths(before, after, allowedPaths);
  assert.deepEqual(changed.unexpected, [], `Unexpected wiki file changes: ${changed.unexpected.join(', ')}`);
  for (const expected of allowedPaths) {
    assert(changed.allowed.includes(expected), `Expected wiki file change was not observed: ${expected}`);
  }
}

function changedPaths(before, after, allowedPaths) {
  const allowed = [];
  const unexpected = [];
  const allowedSet = new Set(allowedPaths);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.reduce((out, key) => {
    if (JSON.stringify(before[key] || null) === JSON.stringify(after[key] || null)) return out;
    if (allowedSet.has(key)) out.allowed.push(key);
    else out.unexpected.push(key);
    return out;
  }, { allowed, unexpected });
}
