import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { normalizePath } from './text.mjs';

const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', '.omw', '.omx', '.obsidian', 'node_modules', '.DS_Store']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

export async function inventoryMarkdownFiles(wikiPath) {
  const out = [];
  await walk(wikiPath, wikiPath, out);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

export async function inventoryDirectories(wikiPath) {
  const out = [];
  await walkDirectories(wikiPath, wikiPath, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function walk(root, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, out);
      continue;
    }
    if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const text = await readFile(fullPath, 'utf8').catch(() => '');
    const relativePath = normalizePath(path.relative(root, fullPath));
    const signalText = stripFencedCodeBlocks(text);
    out.push({
      path: fullPath,
      relativePath,
      segments: relativePath.split('/'),
      text,
      frontmatter: parseFrontmatter(text),
      title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relativePath, path.extname(relativePath)),
      headings: [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim()),
      placeholders: new Set([...signalText.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((match) => match[1])),
    });
  }
}

async function walkDirectories(root, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    out.push(normalizePath(path.relative(root, fullPath)));
    await walkDirectories(root, fullPath, out);
  }
}

function stripFencedCodeBlocks(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opener) {
      fence = { marker: opener[1][0], length: opener[1].length };
      continue;
    }
    if (fence) {
      const closer = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1][0] === fence.marker && closer[1].length >= fence.length) fence = null;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (item) data[item[1].trim()] = item[2].trim();
  }
  return data;
}
