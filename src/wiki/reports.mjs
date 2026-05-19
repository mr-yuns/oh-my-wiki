import {
  createDailyReportSummary as createBaseDailyReportSummary,
  createRawIngestReport as createBaseRawIngestReport,
  validateWiki as validateBaseWiki,
} from './base-tools.mjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWikiStatus } from './contract.mjs';
import { assertSafeExistingDirectory, assertSafeExistingFile } from './safety.mjs';
import { storedSecretIssues } from './validation.mjs';

const WIKI_UNAVAILABLE_MESSAGE = 'Active wiki is not available; run omw setup, set OMW_WIKI_PATH, or use the CLI default repository .wiki.';

export async function createRawIngestReport({ config, options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error(WIKI_UNAVAILABLE_MESSAGE);
  if (isBaseWiki(status)) {
    return {
      ok: true,
      output: createBaseRawIngestReport({
        root: status.wikiPath,
        language: resolveLanguage(status, options),
      }),
    };
  }
  return {
    ok: true,
    output: await createContractRawIngestReport(status),
  };
}

export async function createDailyReportSummary({ config, options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error(WIKI_UNAVAILABLE_MESSAGE);
  if (isBaseWiki(status)) {
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
  return {
    ok: true,
    output: await createContractDailyReportSummary(status, options),
  };
}

export async function validateWiki({ config }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error(WIKI_UNAVAILABLE_MESSAGE);
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

function isBaseWiki(status) {
  return status.contract?.source?.profile === 'omw-base-wiki';
}

async function createContractRawIngestReport(status) {
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  await assertSafeExistingDirectory(status, status.raw.rootPath, 'Raw root');
  const files = await listMarkdownFiles(status.raw.rootPath, {
    root: status.wikiPath,
    base: status.raw.rootPath,
    excludeDirs: new Set(['.git', '.omw', '.omx', '.obsidian', 'node_modules', ...(status.search?.excludeDirs || [])]),
  });
  const rawTypes = new Set(status.contract?.raw?.noteTypes || []);
  const rows = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    const frontmatter = parseFrontmatter(text);
    if (rawTypes.size > 0 && !rawTypes.has(frontmatter.type || frontmatter['유형'] || '')) continue;
    rows.push({
      path: normalizeRelative(status, file),
      state: frontmatter.ingestState || frontmatter['ingest상태'] || frontmatter.status || frontmatter['상태'] || 'unspecified',
      target: frontmatter.ingestTarget || frontmatter['ingest대상'] || frontmatter.target || '',
      processedAt: frontmatter.processedAt || frontmatter['처리일'] || '',
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const lines = ['# Raw Ingest Report', '', `- Total: ${rows.length}`];
  for (const [state, count] of countBy(rows.map((row) => row.state))) {
    lines.push(`- ${state}: ${count}`);
  }
  lines.push('', '| State | Target | Processed at | Note |', '|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.state} | ${row.target} | ${row.processedAt} | ${row.path} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function createContractDailyReportSummary(status, options = {}) {
  if (!status.ok) throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  const dailyType = status.raw.types.find((entry) => entry.key === 'daily_report');
  const files = dailyType?.folderPath && dailyType.exists
    ? await dailyReportFiles(status, dailyType)
    : [];
  const rows = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    const frontmatter = parseFrontmatter(text);
    if (!isDailyRaw(frontmatter)) continue;
    const body = text.replace(/^---[\s\S]*?---\s*/, '');
    const row = {
      path: normalizeRelative(status, file),
      date: frontmatter.reportDate || frontmatter['보고일'] || frontmatter.created || '',
      author: frontmatter.author || frontmatter['작성자'] || '',
      team: frontmatter.team || frontmatter['팀'] || '',
      state: frontmatter.ingestState || frontmatter['ingest상태'] || frontmatter.status || frontmatter['상태'] || '',
      projects: normalizeArray(frontmatter.relatedProjects || frontmatter['관련프로젝트']).join(', '),
      blockers: [
        ...sectionLines(body, 'Blockers / Support Needed'),
        ...sectionLines(body, '막힌 점 / 지원 필요'),
      ],
      knowledge: [
        ...sectionLines(body, 'Knowledge Candidates'),
        ...sectionLines(body, '지식화 후보'),
      ],
    };
    if (options.date && row.date !== options.date) continue;
    if (options.team && row.team !== options.team) continue;
    if (options.author && row.author !== options.author) continue;
    rows.push(row);
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const lines = [
    '# Daily Report Summary',
    '',
    `- Total: ${rows.length}`,
    `- Dates: ${unique(rows.map((row) => row.date)).join(', ')}`,
    `- Teams: ${unique(rows.map((row) => row.team)).join(', ')}`,
    '',
    '## By Author',
    '',
    '| Author | Team | Reports |',
    '|---|---|---|',
  ];
  for (const item of groupedAuthorRows(rows)) {
    lines.push(`| ${item.author} | ${item.team} | ${item.count} |`);
  }
  lines.push('', '## Reports', '', '| Report date | Author | Team | Ingest state | Related projects | Note |', '|---|---|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.date} | ${row.author} | ${row.team} | ${row.state} | ${row.projects} | ${row.path} |`);
  }
  appendDailyDetails(lines, rows);
  return `${lines.join('\n')}\n`;
}

async function dailyReportFiles(status, dailyType) {
  await assertSafeExistingDirectory(status, dailyType.folderPath, 'Daily report folder');
  return listMarkdownFiles(dailyType.folderPath, {
    root: status.wikiPath,
    base: dailyType.folderPath,
    excludeDirs: new Set(['.git', '.omw', '.omx', '.obsidian', 'node_modules']),
  });
}

async function validateContractWiki(status) {
  const failures = [...(status.issues || [])];
  if (status.search?.rootPath && !status.search.rootExists) {
    failures.push(`wiki search root does not exist: ${status.search.rootPath}`);
  }
  if (status.raw?.rootPath && !status.raw.rootExists) {
    failures.push(`wiki raw root does not exist: ${status.raw.rootPath}`);
  }
  if (status.raw?.rootPath && status.raw.rootExists) {
    await pushSafetyFailure(failures, () => assertSafeExistingDirectory(status, status.raw.rootPath, 'Raw root'));
  }
  for (const type of status.raw?.types || []) {
    if (type.folderPath && type.exists) {
      await pushSafetyFailure(failures, () => assertSafeExistingDirectory(status, type.folderPath, 'Raw type folder'));
    }
    if (type.templatePath && type.templateExists) {
      await pushSafetyFailure(failures, () => assertSafeExistingFile(status, type.templatePath, 'Raw template'));
    }
  }
  for (const rule of status.rules || []) {
    if (rule.fullPath && rule.exists) {
      await pushSafetyFailure(failures, () => assertSafeExistingFile(status, rule.fullPath, 'Wiki rule'));
    }
  }
  let searchRootSafe = true;
  if (status.search?.rootPath && status.search.rootExists) {
    try {
      await assertSafeExistingDirectory(status, status.search.rootPath, 'Search root');
    } catch (error) {
      searchRootSafe = false;
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const markdownFiles = searchRootSafe && status.search?.rootPath && status.search.rootExists
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

async function pushSafetyFailure(failures, check) {
  try {
    await check();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
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

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  let currentKey = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const item = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (item) {
      currentKey = item[1].trim();
      data[currentKey] = parseScalar(stripInlineComment(item[2].trim()));
    } else if (currentKey && line.trim().startsWith('- ')) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = data[currentKey] ? [data[currentKey]] : [];
      data[currentKey].push(parseScalar(stripInlineComment(line.trim().slice(2).trim())));
    }
  }
  return data;
}

function parseScalar(valueText) {
  if (valueText === '[]') return [];
  if (valueText.startsWith('[') && valueText.endsWith(']')) {
    return splitFlowArray(valueText.slice(1, -1)).map((item) => unquote(item.trim())).filter(Boolean);
  }
  return unquote(valueText);
}

function stripInlineComment(valueText) {
  let quote = null;
  for (let index = 0; index < valueText.length; index += 1) {
    const char = valueText[index];
    const previous = valueText[index - 1];
    if ((char === '"' || char === "'") && previous !== '\\') quote = quote === char ? null : quote || char;
    if (char === '#' && !quote && (index === 0 || /\s/.test(previous))) return valueText.slice(0, index).trimEnd();
  }
  return valueText;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function splitFlowArray(valueText) {
  const items = [];
  let quote = null;
  let current = '';
  for (let index = 0; index < valueText.length; index += 1) {
    const char = valueText[index];
    const previous = valueText[index - 1];
    if ((char === '"' || char === "'") && previous !== '\\') quote = quote === char ? null : quote || char;
    if (char === ',' && !quote) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}

function unquote(valueText) {
  return valueText.replace(/^["']|["']$/g, '');
}

function isDailyRaw(frontmatter) {
  return frontmatter.rawType === 'daily_report' || frontmatter.reportType === 'daily_report';
}

function normalizeRelative(status, file) {
  return path.relative(status.wikiPath, file).split(path.sep).join('/');
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value || 'unspecified', (counts.get(value || 'unspecified') || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function groupedAuthorRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.author}\0${row.team}`;
    grouped.set(key, { author: row.author, team: row.team, count: (grouped.get(key)?.count || 0) + 1 });
  }
  return [...grouped.values()].sort((a, b) => `${a.author} ${a.team}`.localeCompare(`${b.author} ${b.team}`));
}

function appendDailyDetails(lines, rows) {
  const blockers = rows.flatMap((row) => row.blockers.map((item) => ({ row, item }))).filter(({ item }) => !['- None', '- 없음', '없음'].includes(item));
  if (blockers.length > 0) {
    lines.push('', '## Blockers', '');
    for (const { row, item } of blockers) lines.push(`- ${row.date} ${row.author}: ${item}`);
  }
  const knowledge = rows.flatMap((row) => row.knowledge.map((item) => ({ row, item }))).filter(({ item }) => !item.includes('입력 예정'));
  if (knowledge.length > 0) {
    lines.push('', '## Knowledge Candidates', '');
    for (const { row, item } of knowledge) lines.push(`- ${row.date} ${row.author}: ${item}`);
  }
}

function sectionLines(body, heading) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const valueText = line.trim();
    if (valueText) collected.push(valueText);
  }
  return collected;
}

function validateFrontmatterFence(text) {
  if (!String(text || '').startsWith('---')) return '';
  if (!/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) return 'frontmatter closing marker missing';
  return '';
}
