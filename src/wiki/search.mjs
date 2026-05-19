import { buildWikiStatus } from './contract.mjs';
import { scanSearchBackend } from './search/scan.mjs';
import { normalizeSearchRanking } from './search/shared.mjs';
import { ensureSqliteSearchIndex, sqliteSearchBackend } from './search/sqlite.mjs';

const SEARCH_BACKENDS = new Map([
  [scanSearchBackend.name, scanSearchBackend],
  [sqliteSearchBackend.name, sqliteSearchBackend],
]);

export async function searchWiki({ config, query, limit = 20, backend = 'auto' }) {
  const normalized = String(query || '').trim();
  if (!normalized) throw new Error('wiki search requires a query');
  const status = await buildWikiStatus(config);
  if (!status.configured || !status.wikiPath || !status.wikiExists) {
    throw new Error('Wiki is not configured or does not exist');
  }
  const selectedBackend = await resolveSearchBackend(backend);
  const rankingOverrides = status.search?.ranking || {};
  let result;
  try {
    result = await selectedBackend.search({
      wikiPath: status.wikiPath,
      searchRootPath: activeSearchRoot(status),
      excludeDirs: status.search?.excludeDirs || [],
      rankingOverrides,
      query: normalized,
      limit,
    });
  } catch (error) {
    if (backend !== 'auto' || selectedBackend.name !== sqliteSearchBackend.name) throw error;
    const fallbackResult = await scanSearchBackend.search({
      wikiPath: status.wikiPath,
      searchRootPath: activeSearchRoot(status),
      excludeDirs: status.search?.excludeDirs || [],
      rankingOverrides,
      query: normalized,
      limit,
    });
    result = {
      ...fallbackResult,
      fallbackReason: `sqlite backend failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    query,
    backend: result.backend || selectedBackend.name,
    total: result.total,
    results: result.results,
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
