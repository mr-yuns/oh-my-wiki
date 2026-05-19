import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const IGNORE_DIRS = new Set(['.git', '.omw', '.omx', '.obsidian', 'node_modules']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
export const DEFAULT_SEARCH_RANKING = Object.freeze({
  title: 20,
  path: 10,
  bodyTerm: 1,
  noteType: 1,
  maturity: 1,
  status: 0.5,
  lens: 0.5,
});
export const DEFAULT_SQLITE_SEARCH_RANKING = Object.freeze({
  ...DEFAULT_SEARCH_RANKING,
  title: 8,
});

export function normalizeSearchRanking(input = {}, defaults = DEFAULT_SEARCH_RANKING) {
  const ranking = { ...defaults };
  for (const [key, value] of Object.entries(input || {})) {
    if (!Object.hasOwn(ranking, key)) {
      throw new Error(`Unknown wiki search ranking key: ${key}`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Wiki search ranking "${key}" must be a non-negative number`);
    }
    ranking[key] = value;
  }
  return ranking;
}

export async function markdownFiles(root, options = {}) {
  const out = [];
  const ignoreDirNames = new Set([...IGNORE_DIRS].map(normalizePath));
  const excludeDirs = new Set([...(options.excludeDirs || [])].map(normalizePath));
  await walk(root, out, { ignoreDirNames, excludeDirs, root });
  return out;
}

async function walk(dir, out, options) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(child, entry.name, options)) continue;
      await walk(child, out, options);
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(child);
    }
  }
}

function shouldIgnoreDirectory(dir, name, options) {
  if (options.ignoreDirNames.has(normalizePath(name))) return true;
  const relativePath = normalizePath(path.relative(options.root, dir));
  return Boolean(relativePath && options.excludeDirs.has(relativePath));
}

function normalizePath(value) {
  return String(value || '').split(path.sep).join('/');
}

export async function noteFileMetadata(file) {
  const fileStat = await stat(file);
  return {
    mtimeMs: Math.trunc(fileStat.mtimeMs),
    size: fileStat.size,
  };
}

export function titleFromText(text, file) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file));
}

export function noteSearchMetadata(text, relativePath) {
  const frontmatter = parseFrontmatter(text);
  return {
    noteType: frontmatter['유형'] || frontmatter.type || '',
    status: frontmatter['상태'] || frontmatter.status || '',
    maturity: frontmatter['지식성숙도'] || frontmatter.knowledgeMaturity || frontmatter.maturity || '',
    lens: frontmatter['문서화렌즈'] || frontmatter.documentationLens || frontmatter.lens || '',
    paraSection: paraSection(relativePath),
  };
}

export function scoreMatch(file, text, query, ranking = DEFAULT_SEARCH_RANKING) {
  let score = 0;
  if (path.basename(file).toLowerCase().includes(query)) score += ranking.path;
  const title = titleFromText(text, file).toLowerCase();
  if (title.includes(query)) score += ranking.title;
  score += (text.toLowerCase().match(new RegExp(escapeRegExp(query), 'g')) || []).length * ranking.bodyTerm;
  return score;
}

export function excerpt(text, query) {
  return excerptForTerms(text, [query]);
}

export function excerptForTerms(text, terms) {
  const normalized = text.toLowerCase();
  const needles = terms.map((term) => String(term || '').trim().toLowerCase()).filter(Boolean);
  let index = -1;
  let length = 0;
  for (const needle of needles) {
    const found = normalized.indexOf(needle);
    if (found !== -1 && (index === -1 || found < index)) {
      index = found;
      length = needle.length;
    }
  }
  if (index === -1) return '';
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 160);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!field) continue;
    out[field[1].trim()] = field[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function paraSection(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/);
  return parts[0] || '';
}
