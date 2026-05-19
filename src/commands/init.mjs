import { cp, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, writeConfig } from '../config/config.js';
import { repoRoot } from '../skills/manager.js';
import { pathExists } from '../utils/fs.js';
import { buildWikiStatus, ensureWikiContract, normalizeWikiLanguage } from '../wiki/contract.mjs';

const BASE_WIKI_GITIGNORE = [
  '.obsidian/',
  '.omw/*',
  '.omx/',
  '.DS_Store',
  '',
].join('\n');

export async function initializeWiki({ config, options = {} }) {
  const wikiPath = path.resolve(options.wiki || options['wiki-path'] || options._?.[0] || config?.wikiPath || path.join(process.cwd(), 'wiki'));
  const language = normalizeWikiLanguage(options.language || options.lang || config?.wikiLanguage || 'en');
  const createdWiki = !(await pathExists(wikiPath));
  await ensureInitWikiDirectory(wikiPath);

  const copiedBaseWiki = await seedBaseWikiIfEmpty({ wikiPath, language });
  if (copiedBaseWiki) await ensureBaseWikiIgnoreFile(wikiPath);
  const nextConfig = await writeConfig({
    sourcePath: repoRoot(),
    wikiPath,
    wikiLanguage: language,
    wikiAutoCapture: options['wiki-auto-capture'] ? true : options['no-wiki-auto-capture'] ? false : undefined,
    omxBin: options['omx-bin'],
    omcBin: options['omc-bin'],
    previousConfig: config,
  });
  const contract = await ensureWikiContract(wikiPath, { language });
  const validation = await validateConfig(nextConfig);
  const status = await buildWikiStatus(nextConfig);
  const issues = [...new Set([...contract.issues, ...validation.issues, ...status.issues])];

  return {
    ok: issues.length === 0,
    wikiPath,
    language,
    createdWiki,
    copiedBaseWiki,
    contractPath: contract.contractPath,
    contractCreated: Boolean(contract.created),
    contractUpdated: Boolean(contract.updated),
    status,
    issues,
  };
}

async function ensureBaseWikiIgnoreFile(wikiPath) {
  const ignorePath = path.join(wikiPath, '.gitignore');
  if (await pathExists(ignorePath)) return false;
  await writeFile(ignorePath, BASE_WIKI_GITIGNORE);
  return true;
}

async function seedBaseWikiIfEmpty({ wikiPath, language }) {
  await ensureInitWikiDirectory(wikiPath);
  const entries = await readdir(wikiPath, { withFileTypes: true }).catch(() => []);
  if (entries.length > 0) return false;

  const source = path.join(repoRoot(), '.wiki');
  if (!(await pathExists(source))) return false;
  const sourceEntries = await readdir(source, { withFileTypes: true });
  for (const entry of sourceEntries) {
    await cp(path.join(source, entry.name), path.join(wikiPath, entry.name), { recursive: true, errorOnExist: true, force: false });
  }
  return true;
}

async function ensureInitWikiDirectory(wikiPath) {
  const existing = await lstat(wikiPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`wikiPath must be a real directory: ${wikiPath}`);
    }
    return;
  }

  let ancestor = path.dirname(wikiPath);
  while (ancestor && ancestor !== path.dirname(ancestor)) {
    const stat = await lstat(ancestor).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`wikiPath ancestor must be a real directory: ${ancestor}`);
      }
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  await mkdir(wikiPath, { recursive: true });
}
