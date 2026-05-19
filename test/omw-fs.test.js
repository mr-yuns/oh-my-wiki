import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeJsonFile, writeTextFileAtomic } from '../src/utils/fs.js';

test('writeJsonFile creates parent directories and leaves no temp files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-fs-json-'));
  const filePath = path.join(root, 'nested', 'state.json');

  await writeJsonFile(filePath, { ok: true, count: 2 });

  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { ok: true, count: 2 });
  const entries = await readdir(path.dirname(filePath));
  assert.deepEqual(entries, ['state.json']);
});

test('writeTextFileAtomic replaces existing content without leaving temp files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-fs-atomic-'));
  const filePath = path.join(root, 'state.txt');

  await writeTextFileAtomic(filePath, 'stable\n');
  await writeTextFileAtomic(filePath, 'new value\n');

  assert.equal(await readFile(filePath, 'utf8'), 'new value\n');
  const entries = await readdir(root);
  assert.deepEqual(entries, ['state.txt']);
});
