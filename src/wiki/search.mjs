import { buildWikiStatus } from './contract.mjs';
import { scanSearchBackend } from './search/scan.mjs';
import { normalizeSearchRanking } from './search/shared.mjs';
import { ensureSqliteSearchIndex, sqliteSearchBackend } from './search/sqlite.mjs';

const SEARCH_BACKENDS = new Map([
  [scanSearchBackend.name, scanSearchBackend],
  [sqliteSearchBackend.name, sqliteSearchBackend],
]);
// Backends require a numeric LIMIT; use a practical upper bound when caller-side filters need all matches.
const ALL_MATCHES_LIMIT = 1_000_000_000;

export async function searchWiki({ config, query, limit = 20, backend = 'auto', filters = {}, sort = 'relevance' }) {
  const normalized = String(query || '').trim();
  if (!normalized) throw new Error('wiki search requires a query');
  const status = await buildWikiStatus(config);
  if (!status.configured || !status.wikiPath || !status.wikiExists) {
    throw new Error('Wiki is not configured or does not exist');
  }
  const selectedBackend = await resolveSearchBackend(backend);
  const rankingOverrides = status.search?.ranking || {};
  const backendLimit = requiresFullCandidateSet(filters, sort) ? ALL_MATCHES_LIMIT : limit;
  let result;
  try {
    result = await selectedBackend.search({
      wikiPath: status.wikiPath,
      searchRootPath: activeSearchRoot(status),
      excludeDirs: status.search?.excludeDirs || [],
      rankingOverrides,
      query: normalized,
      limit: backendLimit,
    });
  } catch (error) {
    if (backend !== 'auto' || selectedBackend.name !== sqliteSearchBackend.name) throw error;
    const fallbackResult = await scanSearchBackend.search({
      wikiPath: status.wikiPath,
      searchRootPath: activeSearchRoot(status),
      excludeDirs: status.search?.excludeDirs || [],
      rankingOverrides,
      query: normalized,
      limit: backendLimit,
    });
    result = {
      ...fallbackResult,
      fallbackReason: `sqlite backend failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const filtered = applySearchFilters(result.results, filters);
  const sorted = sortSearchResults(filtered, sort);
  return {
    ok: true,
    query,
    backend: result.backend || selectedBackend.name,
    total: sorted.length,
    unfilteredTotal: result.total,
    filters: normalizeFilters(filters),
    sort,
    results: sorted.slice(0, limit),
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
  };
}

export async function ensureWikiSearchIndex({ config }) {
  const status = await buildWikiStatus(config);
  if (!status.configured || !status.wikiPath || !status.wikiExists) {
    return {
      ok: false,
      indexPath: '',
      created: false,
      issues: ['Wiki is not configured or does not exist'],
    };
  }
  const rankingOverrides = status.search?.ranking || {};
  normalizeSearchRanking(rankingOverrides);
  try {
    const result = await ensureSqliteSearchIndex({ wikiPath: status.wikiPath, searchRootPath: activeSearchRoot(status), excludeDirs: status.search?.excludeDirs || [], rankingOverrides });
    return {
      ...result,
      issues: [],
    };
  } catch (error) {
    return {
      ok: true,
      indexPath: '',
      created: false,
      skipped: true,
      backend: 'scan',
      issues: [],
      message: `SQLite index skipped; scan search remains available: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function activeSearchRoot(status) {
  return status.search?.rootExists ? status.search.rootPath : status.wikiPath;
}

async function resolveSearchBackend(name) {
  if (name === 'auto') {
    if (await sqliteSearchBackend.available()) return sqliteSearchBackend;
    return scanSearchBackend;
  }
  const backend = SEARCH_BACKENDS.get(name || 'auto');
  if (!backend) {
    throw new Error(`Unknown wiki search backend: ${name}`);
  }
  if (backend.available && !(await backend.available())) {
    throw new Error(`Wiki search backend is not available: ${name}`);
  }
  return backend;
}

function hasSearchFilters(filters = {}) {
  return Object.values(normalizeFilters(filters)).some(Boolean);
}

function requiresFullCandidateSet(filters = {}, sort = 'relevance') {
  return hasSearchFilters(filters) || (sort && sort !== 'relevance');
}

function normalizeFilters(filters = {}) {
  return {
    type: String(filters.type || '').trim(),
    status: String(filters.status || '').trim(),
    path: String(filters.path || '').trim(),
  };
}

function applySearchFilters(results = [], filters = {}) {
  const normalized = normalizeFilters(filters);
  return results.filter((item) => {
    const signals = item.rankSignals || {};
    if (normalized.type && !matchesFilter(signals.noteType, normalized.type)) return false;
    if (normalized.status && !matchesFilter(signals.status, normalized.status)) return false;
    if (normalized.path && !matchesFilter(item.relativePath, normalized.path)) return false;
    return true;
  });
}

function matchesFilter(value, expected) {
  return String(value || '').toLowerCase().includes(String(expected || '').toLowerCase());
}

function sortSearchResults(results, sort) {
  const sorted = [...results];
  if (sort === 'path') {
    sorted.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return sorted;
  }
  if (sort === 'title') {
    sorted.sort((left, right) => left.title.localeCompare(right.title) || left.relativePath.localeCompare(right.relativePath));
    return sorted;
  }
  if (sort && sort !== 'relevance') {
    throw new Error(`Unknown wiki search sort: ${sort}`);
  }
  return sorted;
}
