import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertNoRawAmbiguityForWrite, buildWikiStatus, contractUnderstandingNotice } from './contract.mjs';
import { frontmatterScalar, redactSensitiveText } from './redaction.mjs';
import { renderWikiTemplate } from './template.mjs';
import { assertRawNoteSafety } from './validation.mjs';
import { pathExists, writeTextFileAtomic } from '../utils/fs.js';
import { assertSafeExistingDirectory, assertSafeOptionalFile, ensureSafeDirectory } from './safety.mjs';

export async function createDailyReport({ config, author, team, date, body = '', options = {} }) {
  if (!author?.trim()) throw new Error('wiki daily requires --author');
  if (!team?.trim()) throw new Error('wiki daily requires --team');
  const status = await buildWikiStatus(config);
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  const dailyType = status.raw.types.find((entry) => entry.key === 'daily_report');
  if (!dailyType) throw new Error('wiki contract does not define daily_report raw type');
  const reportDate = normalizeDate(date || new Date());
  const canonicalAuthor = resolveAuthorName(author, dailyType.naming);
  const platform = options.platform || 'manual';
  const dryRun = Boolean(options.dryRun);
  if (!dryRun) assertNoRawAmbiguityForWrite(status, 'daily report write');
  await assertSafeExistingDirectory(status, status.raw.rootPath, 'Raw root');
  if (dailyType.folderPath && await pathExists(dailyType.folderPath)) {
    await assertSafeExistingDirectory(status, dailyType.folderPath, 'Raw type folder');
  }
  if (!dryRun) {
    await assertSafeExistingDirectory(status, dailyType.folderPath, 'Raw type folder');
  }

  const execute = async () => {
    const memberFolder = await ensureMemberFolder(status, dailyType.folderPath, canonicalAuthor, dailyType.naming, { dryRun });
    const memberPath = path.join(dailyType.folderPath, memberFolder);
    if (!dryRun) await assertSafeExistingDirectory(status, memberPath, 'Daily report member folder');
    const plannedNotePath = path.join(memberPath, renderReportFileName(dailyType.naming, { author: canonicalAuthor, memberFolder, reportDate }));
    const notePath = await findExistingReportPath(memberPath, reportDate, plannedNotePath);
    const result = await buildDailyReportWrite({
      status,
      dailyType,
      notePath,
      author: canonicalAuthor,
      team,
      reportDate,
      body,
      platform,
    });
    assertRawNoteSafety(result.note, 'wiki daily report note');
    if (!dryRun && result.changed) {
      await writeFileAtomic(notePath, result.note);
    }
    return {
      ok: true,
      dryRun,
      path: notePath,
      relativePath: path.relative(status.wikiPath, notePath),
      author: canonicalAuthor,
      team,
      date: reportDate,
      action: result.action,
      changed: result.changed,
      added: result.added,
      contractUnderstanding: contractUnderstandingNotice(status, 'daily report write'),
    };
  };

  if (dryRun) return execute();
  return withDailyReportLock(dailyType.folderPath, canonicalAuthor, reportDate, execute);
}

async function ensureMemberFolder(status, root, author, naming = {}, options = {}) {
  const safeAuthor = sanitizeName(author);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const existing = entries.find((entry) => entry.isDirectory() && (entry.name === safeAuthor || entry.name.endsWith(`. ${author}`)));
  if (existing) return existing.name;
  const parentPrefix = path.basename(root).match(/^(\d{2}(?:-\d{2})*)\. /)?.[1] || '';
  const pad = Number.isInteger(naming.memberFolderSequencePad) ? naming.memberFolderSequencePad : 2;
  const numbers = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.match(new RegExp(`^${escapeRegExp(parentPrefix)}-(\\d+)\\. `))?.[1])
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
  const next = String(numbers.length > 0 ? Math.max(...numbers) + 1 : 1).padStart(pad, '0');
  const memberPrefix = parentPrefix ? `${parentPrefix}-${next}` : next;
  const pattern = naming.memberFolderPattern || '{author}';
  const folder = pattern
    .replaceAll('{parentPrefix}', parentPrefix)
    .replaceAll('{sequence}', next)
    .replaceAll('{author}', sanitizeName(author))
    .replaceAll('{memberPrefix}', memberPrefix);
  assertSafeRelativePatternResult(folder, 'daily member folder', { allowNested: true });
  if (!options.dryRun) {
    await ensureSafeDirectory(status, path.join(root, folder), 'Daily report member folder');
  }
  return folder;
}

function normalizeDate(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  throw new Error(`invalid daily report date: ${value}`);
}

async function renderDailyReport({ status, dailyType, author, team, reportDate, body, platform }) {
  const safeAuthor = frontmatterScalar(author);
  const safeTeam = frontmatterScalar(team);
  const safePlatform = frontmatterScalar(platform);
  return renderWikiTemplate({
    wikiPath: status.wikiPath,
    template: dailyType.template,
    values: {
      title: renderPattern(status.contract?.daily?.titlePattern || '{reportDate} {author} Daily Report', { reportDate, author: safeAuthor, team: safeTeam }),
      date: reportDate,
      reportDate,
      author: safeAuthor,
      team: safeTeam,
      platform: safePlatform,
      channel: captureChannel(status.contract?.daily, safePlatform),
      body: body || placeholderText(status.contract?.daily),
      sensitivityCheck: status.contract?.daily?.sensitivityCheck || 'completed',
    },
  });
}

function captureChannel(dailyConfig = {}, platform) {
  const channel = dailyConfig.channel || {};
  return platform === 'manual' ? channel.manual || 'manual' : channel.automated || platform;
}

function placeholderText(dailyConfig = {}) {
  return dailyConfig.placeholder || '- To be filled';
}

async function buildDailyReportWrite({ status, dailyType, notePath, author, team, reportDate, body, platform }) {
  const redactedBody = redactSensitiveText(body);
  const exists = await assertSafeOptionalFile(status, notePath, 'Daily report note');
  if (!exists) {
    const fragment = parseDailyFragment(redactedBody, status.contract?.daily);
    const note = await renderDailyReport({
      status,
      dailyType,
      author,
      team,
      reportDate,
      body: fragment.work.length > 0 ? fragment.work.join('\n') : placeholderText(status.contract?.daily),
      platform,
    });
    const withSections = mergeDailyReportContent(note, fragment, platform, { dailyConfig: status.contract?.daily, skipSections: new Set(['work']) });
    return {
      note: withSections.note,
      action: 'created',
      changed: true,
      added: withSections.added + fragment.work.length,
    };
  }
  const merged = await mergeDailyReport({ status, notePath, body: redactedBody, platform });
  return {
    note: merged.note,
    action: merged.changed ? 'updated' : 'unchanged',
    changed: merged.changed,
    added: merged.added,
  };
}

async function mergeDailyReport({ status, notePath, body, platform }) {
  const existing = await readFile(notePath, 'utf8');
  return mergeDailyReportContent(existing, parseDailyFragment(body, status.contract?.daily), platform, { dailyConfig: status.contract?.daily });
}

function mergeDailyReportContent(existing, fragment, platform, options = {}) {
  const platformLabel = frontmatterScalar(platform || 'manual');
  const stamp = new Date();
  const time = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  const metadata = { platformLabel, time, dailyConfig: options.dailyConfig || {} };
  let note = existing;
  let added = 0;
  const skipSections = options.skipSections || new Set();
  for (const section of dailySections(options.dailyConfig)) {
    if (skipSections.has(section.key)) continue;
    const result = mergeItemsIntoSection(note, section.heading, fragment[section.key] || [], metadata);
    note = result.note;
    added += result.added;
  }
  if (added === 0) return { note: existing, changed: false, added: 0 };
  return { note: touchUpdatedAt(note), changed: true, added };
}

function mergeItemsIntoSection(note, heading, candidateItems, metadata = {}) {
  if (!Array.isArray(candidateItems) || candidateItems.length === 0) return { note, added: 0 };
  const lines = String(note || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    const suffix = lines.at(-1) === '' ? [] : [''];
    const newItems = [
      `- ${metadata.time || '00:00'} ${metadata.platformLabel || 'manual'}:`,
      ...candidateItems.map((item) => `  ${item}`),
    ];
    return { note: [...lines, ...suffix, heading, '', ...newItems, ''].join('\n'), added: candidateItems.length };
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const sectionLines = lines.slice(start + 1, end);
  const existingKeys = new Set(sectionLines.map(normalizeLineKey).filter(Boolean));
  const newBodyItems = candidateItems.filter((item) => {
    const key = normalizeLineKey(item);
    if (!key || existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });
  if (newBodyItems.length === 0) return { note, added: 0 };
  const newItems = [
    `- ${metadata.time || '00:00'} ${metadata.platformLabel || 'manual'}:`,
    ...newBodyItems.map((item) => `  ${item}`),
  ];

  const cleaned = removePlaceholderLines(lines, start + 1, end, metadata.dailyConfig);
  const adjustedEnd = end - (lines.length - cleaned.length);
  const insertAt = trimSectionTrailingBlank(cleaned, start + 1, adjustedEnd);
  const before = cleaned.slice(0, insertAt);
  const after = cleaned.slice(insertAt);
  const needsBlankBefore = before.at(-1)?.trim() !== '';
  const needsBlankAfter = after[0]?.trim() !== '';
  return {
    note: [
      ...before,
      ...(needsBlankBefore ? [''] : []),
      ...newItems,
      ...(needsBlankAfter ? [''] : []),
      ...after,
    ].join('\n'),
    added: newBodyItems.length,
  };
}

function trimSectionTrailingBlank(lines, start, end) {
  let insertAt = end;
  while (insertAt > start && lines[insertAt - 1].trim() === '') insertAt -= 1;
  return insertAt;
}

function parseDailyFragment(body, dailyConfig = {}) {
  const sections = dailySections(dailyConfig);
  const fragment = Object.fromEntries(sections.map((section) => [section.key, []]));
  let current = 'work';
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = sections.find((section) => section.heading === line || section.aliases.includes(line));
    if (heading) {
      current = heading.key;
      continue;
    }
    if (/^##\s+/.test(line)) continue;
    const item = normalizeDailyItem(line, dailyConfig);
    if (item) fragment[current].push(item);
  }
  return fragment;
}

function normalizeDailyItem(line, dailyConfig = {}) {
  const trimmed = String(line || '').trim();
  if (!trimmed || dailyPlaceholders(dailyConfig).has(trimmed)) return '';
  return trimmed.startsWith('- ') ? trimmed : `- ${trimmed}`;
}

async function findExistingReportPath(memberPath, reportDate, plannedNotePath) {
  if (await pathExists(plannedNotePath)) return plannedNotePath;
  const yyyymmdd = reportDate.replaceAll('-', '');
  const entries = await readdir(memberPath, { withFileTypes: true }).catch(() => []);
  const existing = entries.find((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.includes(yyyymmdd));
  return existing ? path.join(memberPath, existing.name) : plannedNotePath;
}

function normalizeLineKey(line) {
  return String(line || '')
    .trim()
    .replace(/^\s*-\s+\d{2}:\d{2}\s+[^:]+:\s*$/, '')
    .replace(/^\s*-\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function removePlaceholderLines(lines, start, end, dailyConfig = {}) {
  return [
    ...lines.slice(0, start),
    ...lines.slice(start, end).filter((line) => !dailyPlaceholders(dailyConfig).has(line.trim())),
    ...lines.slice(end),
  ];
}

function touchUpdatedAt(note) {
  const today = new Date();
  const value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return String(note || '')
    .replace(/^수정일:\s*.*$/m, `수정일: ${value}`)
    .replace(/^updated:\s*.*$/m, `updated: ${value}`);
}

function sanitizeName(value) {
  return String(value).trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ');
}

function resolveAuthorName(author, naming = {}) {
  const safeAuthor = sanitizeName(author);
  const aliases = naming.authorAliases || {};
  for (const [canonical, values] of Object.entries(aliases)) {
    const aliasList = Array.isArray(values) ? values : [values];
    if (sanitizeName(canonical) === safeAuthor || aliasList.map(sanitizeName).includes(safeAuthor)) {
      return sanitizeName(canonical);
    }
  }
  return safeAuthor;
}

async function withDailyReportLock(root, author, reportDate, callback) {
  const lockPath = path.join(root, `.daily-${sanitizeName(author)}-${reportDate}.lock`);
  let handle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await sleep(50);
    }
  }
  if (!handle) throw new Error(`daily report is locked: ${author} ${reportDate}`);
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function writeFileAtomic(targetPath, content) {
  await writeTextFileAtomic(targetPath, content);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isStaleLock(lockPath) {
  const details = await stat(lockPath).catch(() => null);
  if (!details) return false;
  return Date.now() - details.mtimeMs > 5 * 60 * 1000;
}

function renderReportFileName(naming = {}, { author, memberFolder, reportDate }) {
  const yyyymmdd = reportDate.replaceAll('-', '');
  const safeAuthor = sanitizeName(author);
  const memberPrefix = String(memberFolder || '').match(/^(\d{2}(?:-\d{2})*)\. /)?.[1] || safeAuthor;
  const fileName = (naming.reportFilePattern || '{author}-{YYYYMMDD}.md')
    .replaceAll('{memberPrefix}', memberPrefix)
    .replaceAll('{memberFolder}', sanitizeName(memberFolder || safeAuthor))
    .replaceAll('{author}', safeAuthor)
    .replaceAll('{YYYYMMDD}', yyyymmdd)
    .replaceAll('{reportDate}', reportDate);
  assertSafeRelativePatternResult(fileName, 'daily report file name', { allowNested: false });
  return fileName;
}

function assertSafeRelativePatternResult(value, label, options = {}) {
  const text = String(value || '');
  const normalized = text.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!text || path.isAbsolute(text) || text.includes('\0') || (!options.allowNested && segments.length > 1) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dailySections(dailyConfig = {}) {
  const sections = Array.isArray(dailyConfig.sections) ? dailyConfig.sections : [];
  return sections.map((section) => ({ ...section, aliases: section.aliases || [] })).filter((section) => section.key && section.heading);
}

function renderPattern(pattern, values = {}) {
  return String(pattern || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => values[key] ?? '');
}

function dailyPlaceholders(dailyConfig = {}) {
  return new Set(dailyConfig.placeholders || []);
}
