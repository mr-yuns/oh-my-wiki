import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../utils/fs.js';

export class WikiSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WikiSafetyError';
    this.code = 'OMW_WIKI_SAFETY';
  }
}

export async function assertSafeExistingDirectory(status, directoryPath, label) {
  const directoryStat = await lstat(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw wikiSafetyError(`${label} must be a real directory: ${relativeToWiki(status, directoryPath)}`);
  }
  const [wikiRealPath, directoryRealPath] = await Promise.all([
    realpath(status.wikiPath),
    realpath(directoryPath),
  ]);
  if (!isInsidePath(wikiRealPath, directoryRealPath)) {
    throw wikiSafetyError(`${label} must stay inside the wiki: ${relativeToWiki(status, directoryPath)}`);
  }
}

export async function assertSafeOptionalOwmDirectory(wikiPath) {
  const omwRoot = path.join(wikiPath, '.omw');
  if (!(await pathExists(omwRoot))) return;
  await assertSafeExistingDirectory({ wikiPath }, omwRoot, '.omw directory');
}

export async function assertSafeExistingFile(status, filePath, label) {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw wikiSafetyError(`${label} must be a real file: ${relativeToWiki(status, filePath)}`);
  }
  const [wikiRealPath, fileRealPath] = await Promise.all([
    realpath(status.wikiPath),
    realpath(filePath),
  ]);
  if (!isInsidePath(wikiRealPath, fileRealPath)) {
    throw wikiSafetyError(`${label} must stay inside the wiki: ${relativeToWiki(status, filePath)}`);
  }
}

export async function assertSafeOptionalFile(status, filePath, label) {
  const fileStat = await lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!fileStat) return false;
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw wikiSafetyError(`${label} must be a real file: ${relativeToWiki(status, filePath)}`);
  }
  const [wikiRealPath, fileRealPath] = await Promise.all([
    realpath(status.wikiPath),
    realpath(filePath),
  ]);
  if (!isInsidePath(wikiRealPath, fileRealPath)) {
    throw wikiSafetyError(`${label} must stay inside the wiki: ${relativeToWiki(status, filePath)}`);
  }
  return true;
}

export function isWikiSafetyError(error) {
  return error instanceof WikiSafetyError || error?.code === 'OMW_WIKI_SAFETY';
}

function wikiSafetyError(message) {
  return new WikiSafetyError(message);
}

export function isInsidePath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeToWiki(status, targetPath) {
  return path.relative(status.wikiPath, targetPath) || '.';
}
