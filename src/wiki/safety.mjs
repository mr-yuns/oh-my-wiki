import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../utils/fs.js';

export async function assertSafeExistingDirectory(status, directoryPath, label) {
  const directoryStat = await lstat(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${relativeToWiki(status, directoryPath)}`);
  }
  const [wikiRealPath, directoryRealPath] = await Promise.all([
    realpath(status.wikiPath),
    realpath(directoryPath),
  ]);
  if (!isInsidePath(wikiRealPath, directoryRealPath)) {
    throw new Error(`${label} must stay inside the wiki: ${relativeToWiki(status, directoryPath)}`);
  }
}

export async function assertSafeOptionalOwmDirectory(wikiPath) {
  const omwRoot = path.join(wikiPath, '.omw');
  if (!(await pathExists(omwRoot))) return;
  await assertSafeExistingDirectory({ wikiPath }, omwRoot, '.omw directory');
}

export function isInsidePath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeToWiki(status, targetPath) {
  return path.relative(status.wikiPath, targetPath) || '.';
}
