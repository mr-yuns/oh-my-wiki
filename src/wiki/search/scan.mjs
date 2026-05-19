import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { excerpt, markdownFiles, noteSearchMetadata, normalizeSearchRanking, scoreMatch, titleFromText } from './shared.mjs';

export const scanSearchBackend = {
  name: 'scan',
  async search({ wikiPath, searchRootPath, excludeDirs = [], rankingOverrides = {}, query, limit }) {
    const normalized = String(query || '').trim().toLowerCase();
    const ranking = normalizeSearchRanking(rankingOverrides);
    const files = await markdownFiles(searchRootPath || wikiPath, { excludeDirs });
    const results = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(() => '');
      const haystack = `${path.basename(file)}\n${text}`.toLowerCase();
      const index = haystack.indexOf(normalized);
      if (index === -1) continue;
      results.push({
        path: file,
        relativePath: path.relative(wikiPath, file),
        title: titleFromText(text, file),
        score: scoreMatch(file, text, normalized, ranking),
        rankSignals: {
          ...noteSearchMetadata(text, path.relative(searchRootPath || wikiPath, file)),
          ranking,
        },
        excerpt: excerpt(text, normalized),
      });
    }
    results.sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath));
    return {
      backend: 'scan',
      total: results.length,
      results: results.slice(0, limit),
    };
  },
};
