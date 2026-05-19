import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function stateRoot() {
  return process.env.OH_MY_WIKI_HOME || path.join(os.homedir(), '.omw');
}

export function fallbackStateRoot() {
  return (
    process.env.OH_MY_WIKI_FALLBACK_HOME ||
    path.join(os.tmpdir(), 'omw', sanitizePathSegment(os.userInfo().username || 'user'))
  );
}

export function configPath() {
  return path.join(stateRoot(), 'config.json');
}

export async function ensureStateDirs() {
  let lastError;
  for (const root of uniquePaths([stateRoot(), fallbackStateRoot()])) {
    try {
      return await createStateDirs(root);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function createStateDirs(root) {
  const dirs = {
    root,
    configPath: path.join(root, 'config.json'),
    eventsDir: path.join(root, 'events'),
  };

  await mkdir(dirs.root, { recursive: true });
  await mkdir(dirs.eventsDir, { recursive: true });
  await assertWritable(dirs.root);
  return dirs;
}

async function assertWritable(root) {
  const probePath = path.join(root, `.write-test-${process.pid}-${Date.now()}`);
  await writeFile(probePath, '');
  await rm(probePath, { force: true });
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function sanitizePathSegment(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}
