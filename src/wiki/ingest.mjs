import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWikiStatus, loadWikiRuleSummaries } from './contract.mjs';
import { pathExists } from '../utils/fs.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const DRAFTS_RELATIVE_ROOT = path.join('.omw', 'ingest-drafts');

export async function listRawQueue({ config }) {
  const status = await buildWikiStatus(config);
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  const files = await markdownFiles(status.raw.rootPath);
  const items = [];
  const pendingStates = pendingIngestStates(status);
  const rawTypes = rawNoteTypes(status);
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    const frontmatter = parseFrontmatter(text);
    if (!rawTypes.has(rawNoteType(frontmatter))) continue;
    const state = rawIngestState(frontmatter);
    if (!pendingStates.has(state)) continue;
    items.push({
      id: path.relative(status.wikiPath, file),
      path: file,
      relativePath: path.relative(status.wikiPath, file),
      title: titleFromText(text, file),
      state,
      target: rawIngestTarget(frontmatter),
    });
  }
  return {
    ok: true,
    total: items.length,
    items,
  };
}

export async function createIngestPreview({ config, rawRef, options = {} }) {
  await assertSafeOwmDirectory(config?.wikiPath || '');
  const status = await buildWikiStatus(config);
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  const rawPath = await resolveRawRef(status, rawRef);
  const rawText = await readFile(rawPath, 'utf8');
  const title = titleFromText(rawText, rawPath);
  const rawRelativePath = path.relative(status.wikiPath, rawPath);
  const excerpt = rawText.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 2000);
  const rules = await loadWikiRuleSummaries(status, status.contract?.ingest?.ruleKeys || []);
  const draft = await maybeWriteIngestDraft({ status, rawRelativePath, title, excerpt, rules, options });
  return {
    ok: true,
    writePerformed: draft.writePerformed,
    path: draft.path,
    relativePath: draft.relativePath,
    rawPath,
    rawRelativePath,
    title,
    excerpt,
    rules,
    review: {
      source: rawRelativePath,
      promotedWritePerformed: false,
      draftWritePerformed: draft.writePerformed,
      instruction: draft.writePerformed
        ? 'Review the draft under .omw/ingest-drafts before manually promoting durable notes.'
        : 'Review the contract.rules operating notes before writing promoted notes.',
    },
  };
}

async function assertSafeOwmDirectory(wikiPath) {
  if (!wikiPath) return;
  const omwRoot = path.join(wikiPath, '.omw');
  if (!(await pathExists(omwRoot))) return;
  const omwStat = await lstat(omwRoot);
  if (omwStat.isSymbolicLink() || !omwStat.isDirectory()) {
    throw new Error(`.omw directory must be a real directory: ${omwRoot}`);
  }
  const [wikiRealPath, omwRealPath] = await Promise.all([
    realpath(wikiPath),
    realpath(omwRoot),
  ]);
  if (!isInsidePath(wikiRealPath, omwRealPath)) {
    throw new Error(`.omw directory must stay inside the wiki: ${omwRoot}`);
  }
}

async function maybeWriteIngestDraft({ status, rawRelativePath, title, excerpt, rules, options }) {
  if (!options.writeDraft) return { writePerformed: false, path: null, relativePath: null };
  const draftRoot = path.join(status.wikiPath, DRAFTS_RELATIVE_ROOT);
  const fileName = `${safeFileName(title || path.basename(rawRelativePath, path.extname(rawRelativePath)))}.md`;
  const draftPath = path.join(draftRoot, fileName);
  await prepareSafeDraftRoot(status, draftRoot);
  await writeDraftFile({
    draftPath,
    content: renderIngestDraft({ rawRelativePath, title, excerpt, rules }),
    overwrite: Boolean(options.overwriteDraft),
    relativePath: path.relative(status.wikiPath, draftPath),
  });
  return {
    writePerformed: true,
    path: draftPath,
    relativePath: path.relative(status.wikiPath, draftPath),
  };
}

async function prepareSafeDraftRoot(status, draftRoot) {
  const omwRoot = path.join(status.wikiPath, '.omw');
  await assertSafeExistingDirectory(status, status.wikiPath, 'wiki root');
  if (await pathExists(omwRoot)) {
    await assertSafeExistingDirectory(status, omwRoot, '.omw directory');
  } else {
    await mkdir(omwRoot);
    await assertSafeExistingDirectory(status, omwRoot, '.omw directory');
  }
  if (await pathExists(draftRoot)) {
    await assertSafeExistingDirectory(status, draftRoot, 'ingest draft root');
  } else {
    await mkdir(draftRoot);
    await assertSafeExistingDirectory(status, draftRoot, 'ingest draft root');
  }
}

async function assertSafeExistingDirectory(status, directoryPath, label) {
  const directoryStat = await lstat(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path.relative(status.wikiPath, directoryPath) || '.'}`);
  }
  const [wikiRealPath, directoryRealPath] = await Promise.all([
    realpath(status.wikiPath),
    realpath(directoryPath),
  ]);
  if (!isInsidePath(wikiRealPath, directoryRealPath)) {
    throw new Error(`${label} must stay inside the wiki: ${path.relative(status.wikiPath, directoryPath) || '.'}`);
  }
}

async function writeDraftFile({ draftPath, content, overwrite, relativePath }) {
  if (!overwrite) {
    try {
      const handle = await open(draftPath, 'wx');
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Ingest draft already exists: ${relativePath}. Use --overwrite-draft to replace it.`);
      }
      throw error;
    }
  }

  const draftStat = await lstat(draftPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (draftStat?.isSymbolicLink() || (draftStat && !draftStat.isFile())) {
    throw new Error(`Ingest draft overwrite requires a regular file: ${relativePath}`);
  }
  await writeFile(draftPath, content);
}

function renderIngestDraft({ rawRelativePath, title, excerpt, rules }) {
  const lines = [
    '---',
    'type: Ingest Draft',
    'status: review',
    `sourceRaw: ${JSON.stringify(rawRelativePath)}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Source Raw',
    '',
    `- ${rawRelativePath}`,
    '',
    '## Draft Notes',
    '',
    '- Review the source Raw note and operating rules before promoting durable knowledge.',
    '- Replace this checklist with manually curated notes.',
    '',
    '## Raw Excerpt',
    '',
    excerpt || '(empty)',
  ];
  if (rules.length > 0) {
    lines.push('', '## Rule Notes', '');
    for (const rule of rules) {
      lines.push(`- ${rule.label}: ${rule.path}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

function safeFileName(value) {
  return String(value || 'ingest-draft')
    .replace(/[\\/:*?"<>|#\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'ingest-draft';
}

function pendingIngestStates(status) {
  const states = status.contract?.ingest?.pendingStates || status.contract?.raw?.ingestStates || [];
  return new Set(states.length > 0 ? states.slice(0, 2) : []);
}

function rawNoteTypes(status) {
  const configured = status.contract?.raw?.noteTypes || [];
  if (configured.length > 0) return new Set(configured);
  return new Set([status.language === 'ko' ? 'Raw수집' : 'Raw']);
}

function rawNoteType(frontmatter) {
  return frontmatter['유형'] || frontmatter.type || '';
}

function rawIngestState(frontmatter) {
  return frontmatter['ingest상태'] || frontmatter.ingestState || frontmatter['상태'] || frontmatter.status || defaultRawState(frontmatter);
}

function rawIngestTarget(frontmatter) {
  return frontmatter['ingest대상'] || frontmatter.ingestTarget || frontmatter.target || '';
}

function defaultRawState(frontmatter) {
  return frontmatter.type || frontmatter['유형'] ? '' : '';
}

async function resolveRawRef(status, rawRef) {
  if (!rawRef) throw new Error('wiki ingest requires a Raw note path');
  await assertSafeRawRoot(status);
  const candidates = [
    path.isAbsolute(rawRef) ? rawRef : path.join(status.wikiPath, rawRef),
    path.join(status.raw.rootPath, rawRef),
  ];
  for (const candidate of candidates) {
    if ((await pathExists(candidate)) && isInsidePath(status.raw.rootPath, candidate)) {
      return safeRawFilePath(status, candidate);
    }
  }
  throw new Error(`Raw note does not exist: ${rawRef}`);
}

async function assertSafeRawRoot(status) {
  const rawRootStat = await lstat(status.raw.rootPath);
  if (rawRootStat.isSymbolicLink() || !rawRootStat.isDirectory()) {
    throw new Error(`Raw root must be a real directory: ${path.relative(status.wikiPath, status.raw.rootPath)}`);
  }
  const [wikiRealPath, rawRootRealPath] = await Promise.all([
    realpath(status.wikiPath),
    realpath(status.raw.rootPath),
  ]);
  if (!isInsidePath(wikiRealPath, rawRootRealPath)) {
    throw new Error(`Raw root must stay inside the wiki: ${path.relative(status.wikiPath, status.raw.rootPath)}`);
  }
}

async function safeRawFilePath(status, candidate) {
  const rawStat = await lstat(candidate);
  if (rawStat.isSymbolicLink() || !rawStat.isFile()) {
    throw new Error(`Raw note must be a real file: ${path.relative(status.wikiPath, candidate)}`);
  }
  const [rawRootRealPath, rawFileRealPath] = await Promise.all([
    realpath(status.raw.rootPath),
    realpath(candidate),
  ]);
  if (!isInsidePath(rawRootRealPath, rawFileRealPath)) {
    throw new Error(`Raw note must stay inside the Raw root: ${path.relative(status.wikiPath, candidate)}`);
  }
  return candidate;
}

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function markdownFiles(root) {
  const out = [];
  await walk(root, out);
  return out;
}

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(child, out);
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(child);
    }
  }
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (item) data[item[1].trim()] = item[2].trim();
  }
  return data;
}

function titleFromText(text, file) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file));
}
