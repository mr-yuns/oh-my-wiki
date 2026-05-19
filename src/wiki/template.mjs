import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../utils/fs.js';
import { assertSafeExistingFile } from './safety.mjs';

export async function renderWikiTemplate({ wikiPath, template, values }) {
  if (!template) {
    throw new Error('wiki contract raw type does not define a template');
  }
  const templatePath = path.join(wikiPath, template);
  if (!(await pathExists(templatePath))) {
    throw new Error(`wiki template does not exist: ${template}`);
  }
  await assertSafeExistingFile({ wikiPath }, templatePath, 'Wiki template');
  const source = await readFile(templatePath, 'utf8');
  const rendered = source.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) return match;
    return String(values[key] ?? '');
  });
  const unresolved = [...rendered.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`wiki template has unresolved placeholders (${template}): ${[...new Set(unresolved)].join(', ')}`);
  }
  return rendered;
}
