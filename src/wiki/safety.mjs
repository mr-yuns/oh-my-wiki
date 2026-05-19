import { lstat, mkdir, realpath } from 'node:fs/promises';
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

export async function assertSafeExistingAncestor(status, targetPath, label) {
  let current = targetPath;
  while (!(await pathExists(current))) {
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  await assertSafeExistingDirectory(status, current, `${label} ancestor`);
}

export async function ensureSafeDirectory(status, directoryPath, label) {
  if (await assertSafeOptionalDirectory(status, directoryPath, label)) {
    return;
  }
  await assertSafeExistingAncestor(status, directoryPath, label);
  await mkdir(directoryPath, { recursive: true });
  await assertSafeExistingDirectory(status, directoryPath, label);
}

export async function assertSafeOptionalOwmDirectory(wikiPath) {
  const omwRoot = path.join(wikiPath, '.omw');
  if (!(await pathExists(omwRoot))) return;
  await assertSafeExistingDirectory({ wikiPath }, omwRoot, '.omw directory');
}

export async function assertSafeOptionalDirectory(status, directoryPath, label) {
  const directoryStat = await lstat(directoryPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!directoryStat) return false;
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
  return true;
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
