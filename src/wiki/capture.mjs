import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWikiStatus } from './contract.mjs';
import { frontmatterScalar, redactSensitiveText } from './redaction.mjs';
import { renderWikiTemplate } from './template.mjs';
import { assertRawNoteSafety } from './validation.mjs';

const DEFAULT_TYPE = 'agent_session';

export async function captureRawNote({ config, type = DEFAULT_TYPE, title, body = '', options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.ok) {
    throw new Error(`Wiki is not ready: ${status.issues.join('; ')}`);
  }
  const rawType = status.raw.types.find((entry) => entry.key === type);
  if (!rawType) {
    throw new Error(`Unknown raw type: ${type}`);
  }
  if (type === 'daily_report') {
    throw new Error('daily_report Raw notes must be created with `omw wiki daily`');
  }
  if (!title?.trim()) {
    throw new Error('wiki capture requires --title');
  }

  const now = parseCaptureDate(options);
  const folderPath = rawType.folderPath;
  if (!options.dryRun) {
    await mkdir(folderPath, { recursive: true });
  }
  const prefix = notePrefix(rawType, status.contract?.raw?.naming);
  const sequence = await nextSequence(folderPath, prefix);
  const fileName = `${prefix ? `${prefix}-` : ''}${sequence}. ${dateTitlePrefix(now, type)} - ${sanitizeTitle(title)}.md`;
  const notePath = path.join(folderPath, fileName);
  const note = await renderRawNote({
    status,
    rawType,
    title,
    body,
    now,
    platform: options.platform || 'manual',
    workspace: options.workspace || '',
    branch: options.branch || '',
  });
  assertRawNoteSafety(note, 'wiki capture note');

  if (!options.dryRun) {
    await writeFile(notePath, note);
  }

  return {
    ok: true,
    dryRun: Boolean(options.dryRun),
    path: notePath,
    type,
    title,
    content: options.includeContent ? note : undefined,
  };
}

function parseCaptureDate(options) {
  if (options.capturedAt) {
    const parsed = new Date(options.capturedAt);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function notePrefix(rawType = {}, rawNaming = {}) {
  return rawType.naming?.filePrefix || rawNaming.filePrefix || String(rawType.folder || '').match(/^(\d{2}(?:-\d{2})*)\. /)?.[1] || '';
}

async function nextSequence(folderPath, prefix) {
  const pattern = prefix ? new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.`) : /^(\d+)\./;
  const entries = await readdir(folderPath, { withFileTypes: true }).catch(() => []);
  const numbers = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.match(pattern)?.[1])
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite);
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return String(next).padStart(2, '0');
}

function dateTitlePrefix(date, type) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  if (type === 'discussion') return `${yyyy}-${mm}-${dd}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}${mi}`;
}

function sanitizeTitle(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

async function renderRawNote({ status, rawType, title, body, now, platform, workspace, branch }) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rawConfig = status.contract?.raw || {};
  return renderWikiTemplate({
    wikiPath: status.wikiPath,
    template: rawType.template,
    values: {
      title: sanitizeTitle(title),
      rawType: frontmatterScalar(rawType?.label || rawType?.key || ''),
      date,
      capturedAt: formatDateTime(now),
      platform: frontmatterScalar(platform),
      workspace: frontmatterScalar(workspace),
      branch: frontmatterScalar(branch),
      body: redactSensitiveText(body) || placeholderText(rawConfig),
      sensitivityCheck: sensitivityCheckValue(rawConfig),
    },
  });
}

function placeholderText(rawConfig = {}) {
  return rawConfig.placeholder || '- To be filled';
}

function sensitivityCheckValue(rawConfig = {}) {
  return rawConfig.sensitivityCheck || 'completed';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatDateTime(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
