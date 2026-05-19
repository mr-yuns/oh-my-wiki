import { access, readFile, writeFile } from 'node:fs/promises';

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath, fallback = null) {
  if (!(await pathExists(filePath))) {
    return fallback;
  }
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
