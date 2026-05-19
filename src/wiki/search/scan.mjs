import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { excerptForTerms, markdownFiles, noteSearchMetadata, normalizeSearchRanking, queryTerms, scoreMatch, titleFromText } from './shared.mjs';

export const scanSearchBackend = {
  name: 'scan',
  async search({ wikiPath, searchRootPath, excludeDirs = [], rankingOverrides = {}, query, limit }) {
    const normalized = String(query || '').trim().toLowerCase();
    const ranking = normalizeSearchRanking(rankingOverrides);
    const terms = queryTerms(normalized);
    const root = searchRootPath || wikiPath;
    const files = await markdownFiles(root, { excludeDirs });
    const results = [];
    const batchSize = 256;
    for (let start = 0; start < files.length; start += batchSize) {
      const batch = files.slice(start, start + batchSize);
      const matches = await Promise.all(batch.map(async (file) => scanFile({ file, wikiPath, root, normalized, terms, ranking })));
      for (const match of matches) {
        if (match) results.push(match);
      }
    }
    results.sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath));
    return {
      backend: 'scan',
      total: results.length,
      totalExact: true,
      results: results.slice(0, limit),
    };
  },
};

async function scanFile({ file, wikiPath, root, normalized, terms, ranking }) {
  const text = await readFile(file, 'utf8').catch(() => '');
  const haystack = `${path.basename(file)}\n${text}`.toLowerCase();
  if (!matchesQuery(haystack, normalized, terms)) return null;
  const relativePath = path.relative(wikiPath, file);
  return {
    path: file,
    relativePath,
    title: titleFromText(text, file),
    score: scanScore(file, text, normalized, terms, ranking),
    rankSignals: {
      ...noteSearchMetadata(text, path.relative(root, file)),
      ranking,
    },
    excerpt: excerptForTerms(text, terms.length > 0 ? terms : [normalized]),
  };
}

function matchesQuery(haystack, normalizedQuery, terms) {
  if (!normalizedQuery) return false;
  if (haystack.includes(normalizedQuery)) return true;
  if (terms.length === 0) return false;
  return terms.every((term) => haystack.includes(term));
}

function scanScore(file, text, normalizedQuery, terms, ranking) {
  const matchedTerms = terms.length > 0 ? terms : [normalizedQuery];
  const termScore = matchedTerms.reduce((score, term) => score + scoreMatch(file, text, term, ranking), 0);
  if (!normalizedQuery || matchedTerms.length <= 1) return termScore;
  return termScore + scoreMatch(file, text, normalizedQuery, ranking);
}
