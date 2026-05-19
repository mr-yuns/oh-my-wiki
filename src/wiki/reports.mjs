import {
  createDailyReportSummary as createBaseDailyReportSummary,
  createRawIngestReport as createBaseRawIngestReport,
  validateWiki as validateBaseWiki,
} from '../../.wiki/scripts/_wiki-tools.mjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWikiStatus } from './contract.mjs';
import { storedSecretIssues } from './validation.mjs';

export async function createRawIngestReport({ config, options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error('Wiki is not configured. Run omw setup first.');
  return {
    ok: true,
    output: createBaseRawIngestReport({
      root: status.wikiPath,
      language: resolveLanguage(status, options),
    }),
  };
}

export async function createDailyReportSummary({ config, options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error('Wiki is not configured. Run omw setup first.');
  return {
    ok: true,
    output: createBaseDailyReportSummary({
      root: status.wikiPath,
      language: resolveLanguage(status, options),
      date: options.date,
      team: options.team,
      author: options.author,
    }),
  };
}

export async function validateWiki({ config }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error('Wiki is not configured. Run omw setup first.');
  const profile = status.contract?.source?.profile || 'unknown';
  const result = profile === 'omw-base-wiki'
    ? validateBaseWiki({ root: status.wikiPath })
    : await validateContractWiki(status);
  return {
    ...result,
    root: status.wikiPath,
    mode: profile === 'omw-base-wiki' ? 'base-wiki' : 'contract',
    profile,
    issues: result.failures,
  };
}

function resolveLanguage(status, options) {
  return options.language || options.lang || status.language || status.contract?.language || 'en';
}

async function validateContractWiki(status) {
  const failures = [...(status.issues || [])];
  if (status.search?.rootPath && !status.search.rootExists) {
    failures.push(`wiki search root does not exist: ${status.search.rootPath}`);
  }
  if (status.raw?.rootPath && !status.raw.rootExists) {
    failures.push(`wiki raw root does not exist: ${status.raw.rootPath}`);
  }
  const markdownFiles = status.search?.rootPath && status.search.rootExists
    ? await listMarkdownFiles(status.search.rootPath, {
      root: status.wikiPath,
      base: status.search.rootPath,
      excludeDirs: new Set(['.git', '.omw', '.omx', '.obsidian', 'node_modules', ...(status.search.excludeDirs || [])]),
    })
    : [];
  for (const file of markdownFiles) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(status.wikiPath, file).split(path.sep).join('/');
    const frontmatterIssue = validateFrontmatterFence(text);
    if (frontmatterIssue) failures.push(`${relative}: ${frontmatterIssue}`);
    for (const issue of storedSecretIssues(text)) {
      failures.push(`${relative}: ${issue}`);
    }
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

async function listMarkdownFiles(directory, { root, base, excludeDirs }) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relative = path.relative(root, fullPath).split(path.sep).join('/');
    const baseRelative = path.relative(base, fullPath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name) || excludeDirs.has(relative) || excludeDirs.has(baseRelative)) continue;
      files.push(...await listMarkdownFiles(fullPath, { root, base, excludeDirs }));
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function validateFrontmatterFence(text) {
  if (!String(text || '').startsWith('---')) return '';
  if (!/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) return 'frontmatter closing marker missing';
  return '';
}
