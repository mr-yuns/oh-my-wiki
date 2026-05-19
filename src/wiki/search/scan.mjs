import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { excerptForTerms, markdownFiles, noteSearchMetadata, normalizeSearchRanking, queryTerms, scoreMatch, titleFromText } from './shared.mjs';

export const scanSearchBackend = {
  name: 'scan',
  async search({ wikiPath, searchRootPath, excludeDirs = [], rankingOverrides = {}, query, limit }) {
    const normalized = String(query || '').trim().toLowerCase();
    const ranking = normalizeSearchRanking(rankingOverrides);
    const terms = queryTerms(normalized);
    const files = await markdownFiles(searchRootPath || wikiPath, { excludeDirs });
    const results = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(() => '');
      const haystack = `${path.basename(file)}\n${text}`.toLowerCase();
      if (!matchesQuery(haystack, normalized, terms)) continue;
      results.push({
        path: file,
        relativePath: path.relative(wikiPath, file),
        title: titleFromText(text, file),
        score: scanScore(file, text, normalized, terms, ranking),
        rankSignals: {
          ...noteSearchMetadata(text, path.relative(searchRootPath || wikiPath, file)),
          ranking,
        },
        excerpt: excerptForTerms(text, terms.length > 0 ? terms : [normalized]),
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
