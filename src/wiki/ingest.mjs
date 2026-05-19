import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertNoRawAmbiguityForWrite, buildWikiStatus, contractUnderstandingNotice, loadWikiRuleSummaries } from './contract.mjs';
import { pathExists, writeTextFileAtomic } from '../utils/fs.js';
import { assertSafeExistingDirectory, assertSafeExistingFile, assertSafeOptionalOwmDirectory, ensureSafeDirectory, isInsidePath } from './safety.mjs';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const DRAFTS_RELATIVE_ROOT = path.join('.omw', 'ingest-drafts');

export async function listRawQueue({ config }) {
  const status = await buildWikiStatus(config);
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  await assertSafeRawRoot(status);
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
  await assertSafeOptionalOwmDirectory(config?.wikiPath || '');
  const status = await buildWikiStatus(config);
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  assertNoRawAmbiguityForWrite(status, 'ingest workflow');
  const rawPath = await resolveRawRef(status, rawRef);
  const rawText = await readFile(rawPath, 'utf8');
  const title = titleFromText(rawText, rawPath);
  const rawRelativePath = path.relative(status.wikiPath, rawPath);
  const excerpt = rawText.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 2000);
  const rules = await loadWikiRuleSummaries(status, status.contract?.ingest?.ruleKeys || []);
  const draft = await maybeWriteIngestDraft({ status, rawRelativePath, title, excerpt, rules, options });
  const promotion = await maybePromoteRawNote({ status, rawPath, rawRelativePath, title, excerpt, rules, options });
  return {
    ok: true,
    writePerformed: draft.writePerformed || promotion.writePerformed,
    path: draft.path,
    relativePath: draft.relativePath,
    promotion,
    rawPath,
    rawRelativePath,
    title,
    excerpt,
    rules,
    contractUnderstanding: contractUnderstandingNotice(status, draft.writePerformed || promotion.writePerformed ? 'ingest write' : 'ingest preview'),
    review: {
      source: rawRelativePath,
      promotedWritePerformed: promotion.writePerformed,
      draftWritePerformed: draft.writePerformed,
      instruction: promotion.writePerformed
        ? `Review promoted note at ${promotion.relativePath}.`
        : draft.writePerformed
        ? 'Review the draft under .omw/ingest-drafts before manually promoting durable notes.'
        : 'Review the contract.rules operating notes before writing promoted notes.',
    },
  };
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

async function maybePromoteRawNote({ status, rawPath, rawRelativePath, title, excerpt, rules, options }) {
  if (!options.promote) return { writePerformed: false, path: null, relativePath: null, rawStateUpdated: false, template: null };
  const targetRef = String(options.target || '').trim();
  if (!targetRef) throw new Error('wiki ingest --promote requires --target <relative-note-path>');
  const targetPath = await resolvePromotionTarget(status, targetRef);
  const relativePath = path.relative(status.wikiPath, targetPath);
  const template = promotionTemplateForTarget(relativePath);
  const content = renderPromotedNote({ rawRelativePath, title, excerpt, rules, template });
  await writePromotionFile({
    targetPath,
    content,
    overwrite: Boolean(options.overwritePromote || options['overwrite-promote']),
    relativePath,
  });
  const rawStateUpdated = await updateRawIngestState(rawPath, promotedState(status));
  return {
    writePerformed: true,
    path: targetPath,
    relativePath,
    rawStateUpdated,
    template: template.name,
  };
}

async function prepareSafeDraftRoot(status, draftRoot) {
  const omwRoot = path.join(status.wikiPath, '.omw');
  await assertSafeExistingDirectory(status, status.wikiPath, 'wiki root');
  await ensureSafeDirectory(status, omwRoot, '.omw directory');
  await ensureSafeDirectory(status, draftRoot, 'ingest draft root');
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
  await writeTextFileAtomic(draftPath, content);
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

function renderPromotedNote({ rawRelativePath, title, excerpt, rules, template }) {
  const lines = [
    '---',
    ...renderFrontmatterLines(template.frontmatter),
    `sourceRaw: ${JSON.stringify(rawRelativePath)}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Summary',
    '',
    '- Curate this promoted note before treating it as stable knowledge.',
    '',
    '## Source Raw',
    '',
    `- ${rawRelativePath}`,
    '',
    '## Extracted Content',
    '',
    excerpt || '(empty)',
  ];
  if (rules.length > 0) {
    lines.push('', '## Rule Notes', '');
    for (const rule of rules) lines.push(`- ${rule.label}: ${rule.path}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderFrontmatterLines(frontmatter) {
  return Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
}

function promotionTemplateForTarget(relativePath) {
  const normalized = normalizePath(relativePath);
  const date = new Date().toISOString().slice(0, 10);
  const base = {
    status: 'draft',
    documentationLens: 'promoted-note',
    knowledgeMaturity: 'draft',
    created: date,
    updated: date,
    captureChannel: 'ingest',
    area: '[]',
    tags: '[omw, ingest]',
  };
  const nav = {
    topicScope: 'local',
    impactScope: 'note',
    verificationNeed: 'required',
    recommendedSearchDepth: 'standard',
    parentHub: '[[06-02-01. Knowledge Map]]',
  };
  const baseWikiType = baseWikiTypeForPath(normalized);
  if (!baseWikiType) {
    return {
      name: 'generic-draft',
      frontmatter: {
        type: 'Note',
        status: 'draft',
      },
    };
  }
  return {
    name: `base-wiki-${baseWikiType.toLowerCase().replace(/\s+/g, '-')}`,
    frontmatter: {
      type: baseWikiType,
      ...base,
      ...(requiresNavigationFields(normalized) ? nav : {}),
    },
  };
}

function baseWikiTypeForPath(normalizedPath) {
  const top = baseWikiTopFolder(normalizedPath);
  if (top === '02. Literature Notes') return 'Literature Note';
  if (top === '03. Permanent Notes') return 'Permanent Note';
  if (top === '04. Projects') return 'Project Note';
  if (top === '05. Areas') return 'Area Note';
  if (top === '06. Resources') return resourceTypeForPath(normalizedPath);
  if (top === '07. Archive') return 'Archive Note';
  return null;
}

function baseWikiTopFolder(normalizedPath) {
  const withoutLanguage = normalizedPath.replace(/^(en|ko)\//, '');
  return withoutLanguage.split('/')[0] || '';
}

function resourceTypeForPath(normalizedPath) {
  if (normalizedPath.includes('/06-02. Maps/')) return 'Map';
  if (normalizedPath.includes('/06-03. Catalogs/')) return 'Catalog';
  return 'Operating Guide';
}

function requiresNavigationFields(normalizedPath) {
  const top = baseWikiTopFolder(normalizedPath);
  return ['03. Permanent Notes', '05. Areas', '06. Resources'].includes(top);
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
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

async function resolvePromotionTarget(status, targetRef) {
  if (path.isAbsolute(targetRef)) throw new Error('wiki ingest --target must be relative to the wiki root');
  if (!MARKDOWN_EXTENSIONS.has(path.extname(targetRef).toLowerCase())) {
    throw new Error('wiki ingest --target must end with .md or .mdx');
  }
  const targetPath = path.join(status.wikiPath, targetRef);
  const relative = path.relative(status.wikiPath, targetPath);
  if (!isInsidePath(status.wikiPath, targetPath)) throw new Error(`promotion target must stay inside the wiki: ${targetRef}`);
  if (relative.startsWith('.omw/') || relative === '.omw') throw new Error('wiki ingest --target cannot write under .omw');
  if (isInsidePath(status.raw.rootPath, targetPath)) throw new Error('wiki ingest --target cannot write under the Raw root');
  const [wikiRealPath, targetParentRealPath] = await ensurePromotionParent(status, targetPath);
  if (!isInsidePath(wikiRealPath, targetParentRealPath)) throw new Error(`promotion target must stay inside the wiki: ${relative}`);
  return targetPath;
}

async function ensurePromotionParent(status, targetPath) {
  await assertSafeExistingDirectory(status, status.wikiPath, 'wiki root');
  const parent = path.dirname(targetPath);
  await ensureSafeDirectory(status, parent, 'promotion target directory');
  return Promise.all([realpath(status.wikiPath), realpath(parent)]);
}

async function writePromotionFile({ targetPath, content, overwrite, relativePath }) {
  if (!overwrite) {
    try {
      const handle = await open(targetPath, 'wx');
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Promoted note already exists: ${relativePath}. Use --overwrite-promote to replace it.`);
      }
      throw error;
    }
  }
  const targetStat = await lstat(targetPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
    throw new Error(`Promoted note overwrite requires a regular file: ${relativePath}`);
  }
  await writeTextFileAtomic(targetPath, content);
}

async function updateRawIngestState(rawPath, state) {
  const text = await readFile(rawPath, 'utf8');
  const next = replaceFrontmatterState(text, state);
  if (next === text) return false;
  await writeTextFileAtomic(rawPath, next);
  return true;
}

function replaceFrontmatterState(text, state) {
  return String(text || '').replace(/^---\r?\n([\s\S]*?)\r?\n---/, (match, body) => {
    const lines = body.split(/\r?\n/);
    const index = findFrontmatterStateLine(lines);
    if (index === -1) return match;
    const key = lines[index].split(':')[0];
    lines[index] = `${key}: ${state}`;
    return `---\n${lines.join('\n')}\n---`;
  });
}

function findFrontmatterStateLine(lines) {
  for (const pattern of [/^(ingestState|ingest상태):\s*/, /^(status|상태):\s*/]) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index !== -1) return index;
  }
  return -1;
}

function promotedState(status) {
  const states = status.contract?.raw?.ingestStates || status.contract?.ingest?.pendingStates || [];
  return states.find((state) => /promoted|승격/.test(String(state).toLowerCase())) || (status.language === 'ko' ? '승격완료' : 'promoted');
}

async function assertSafeRawRoot(status) {
  await assertSafeExistingDirectory(status, status.raw.rootPath, 'Raw root');
}

async function safeRawFilePath(status, candidate) {
  await assertSafeExistingFile(status, candidate, 'Raw note');
  const [rawRootRealPath, rawFileRealPath] = await Promise.all([
    realpath(status.raw.rootPath),
    realpath(candidate),
  ]);
  if (!isInsidePath(rawRootRealPath, rawFileRealPath)) {
    throw new Error(`Raw note must stay inside the Raw root: ${path.relative(status.wikiPath, candidate)}`);
  }
  return candidate;
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
