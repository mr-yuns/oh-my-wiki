import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../../utils/fs.js';
import { assertSafeExistingDirectory, assertSafeExistingFile, assertSafeOptionalOwmDirectory, ensureSafeDirectory } from '../safety.mjs';
import { DEFAULT_SQLITE_SEARCH_RANKING, excerptForTerms, markdownFiles, noteFileMetadata, noteSearchMetadata, normalizeSearchRanking, queryTerms, titleFromText } from './shared.mjs';

const INDEX_RELATIVE_PATH = path.join('.omw', 'index.sqlite');
const RECENT_SYNC_TTL_MS = 5_000;
const recentSyncs = new Map();

export const sqliteSearchBackend = {
  name: 'sqlite',
  async available() {
    return Boolean(await loadSqlite());
  },
  async search({ wikiPath, searchRootPath, excludeDirs = [], rankingOverrides = {}, query, limit, refreshIndex = true }) {
    const sqlite = await loadSqlite();
    if (!sqlite) {
      throw new Error('sqlite search backend requires node:sqlite support');
    }
    const dbPath = path.join(wikiPath, INDEX_RELATIVE_PATH);
    await prepareSafeIndexPath(wikiPath, dbPath);
    await ensureSafeDirectory({ wikiPath }, path.dirname(dbPath), 'SQLite index directory');
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      prepareSchema(db);
      if (refreshIndex) await syncIndex({ db, wikiPath, searchRootPath: searchRootPath || wikiPath, excludeDirs, allowRecent: true });
      return queryIndex({ db, wikiPath, query, limit, ranking: normalizeSearchRanking(rankingOverrides, DEFAULT_SQLITE_SEARCH_RANKING) });
    } finally {
      db.close();
    }
  },
};

export async function ensureSqliteSearchIndex({ wikiPath, searchRootPath, excludeDirs = [] }) {
  const sqlite = await loadSqlite();
  if (!sqlite) {
    throw new Error('sqlite search backend requires node:sqlite support');
  }
  const dbPath = path.join(wikiPath, INDEX_RELATIVE_PATH);
  const existed = await pathExists(dbPath);
  await prepareSafeIndexPath(wikiPath, dbPath);
  await ensureSafeDirectory({ wikiPath }, path.dirname(dbPath), 'SQLite index directory');
  const db = new sqlite.DatabaseSync(dbPath);
  let stats;
  try {
    prepareSchema(db);
    stats = await syncIndex({ db, wikiPath, searchRootPath: searchRootPath || wikiPath, excludeDirs });
  } finally {
    db.close();
  }
  return {
    ok: true,
    backend: 'sqlite',
    indexPath: dbPath,
    created: !existed,
    ...stats,
  };
}

async function prepareSafeIndexPath(wikiPath, dbPath) {
  const status = { wikiPath };
  await assertSafeOptionalOwmDirectory(wikiPath);
  const dbDir = path.dirname(dbPath);
  if (await pathExists(dbDir)) {
    await assertSafeExistingDirectory(status, dbDir, 'SQLite index directory');
  }
  if (await pathExists(dbPath)) {
    await assertSafeExistingFile(status, dbPath, 'SQLite index');
  }
}

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}

function prepareSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      relative_path TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      maturity TEXT NOT NULL DEFAULT '',
      lens TEXT NOT NULL DEFAULT '',
      para_section TEXT NOT NULL DEFAULT '',
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
      relative_path UNINDEXED,
      title,
      body,
      content='notes',
      content_rowid='rowid'
    );
  `);
  ensureNoteMetadataColumns(db);
}

async function syncIndex({ db, wikiPath, searchRootPath, excludeDirs, allowRecent = false }) {
  const root = searchRootPath || wikiPath;
  const cacheKey = syncCacheKey({ wikiPath, root, excludeDirs });
  const cached = recentSyncs.get(cacheKey);
  if (allowRecent && cached && !cached.dirty && Date.now() - cached.syncedAt < RECENT_SYNC_TTL_MS) {
    if (await recentSyncStillFresh(cached)) {
      const indexedFiles = db.prepare('SELECT count(*) AS count FROM notes').get()?.count || 0;
      return {
        scannedFiles: indexedFiles,
        indexedFiles,
        changedFiles: 0,
        deletedFiles: 0,
        unchangedFiles: indexedFiles,
        reusedRecentSync: true,
      };
    }
    cached.dirty = true;
  }
  const directories = new Set();
  const files = await markdownFiles(root, { excludeDirs, directories });
  const seen = new Set();
  const upsert = db.prepare(`
    INSERT INTO notes (relative_path, path, title, body, note_type, status, maturity, lens, para_section, mtime_ms, size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relative_path) DO UPDATE SET
      path = excluded.path,
      title = excluded.title,
      body = excluded.body,
      note_type = excluded.note_type,
      status = excluded.status,
      maturity = excluded.maturity,
      lens = excluded.lens,
      para_section = excluded.para_section,
      mtime_ms = excluded.mtime_ms,
      size = excluded.size
  `);
  const indexedRows = db.prepare('SELECT relative_path, mtime_ms, size, para_section FROM notes').all();
  const indexedByPath = new Map(indexedRows.map((row) => [row.relative_path, row]));
  const indexedPaths = indexedRows.map((row) => row.relative_path);
  const deleteNote = db.prepare('DELETE FROM notes WHERE relative_path = ?');

  let unchanged = 0;
  let indexed = 0;
  let deleted = 0;
  let hasChanges = false;
  const batchSize = 4096;
  db.exec('BEGIN');
  try {
    for (let start = 0; start < files.length; start += batchSize) {
      const batch = files.slice(start, start + batchSize);
      const metadataItems = await Promise.all(batch.map(async (file) => ({
        file,
        relativePath: path.relative(wikiPath, file),
        metadata: await noteFileMetadata(file),
      })));
      const changed = [];
      for (const item of metadataItems) {
        seen.add(item.relativePath);
        const current = indexedByPath.get(item.relativePath);
        if (current && current.mtime_ms === item.metadata.mtimeMs && current.size === item.metadata.size && current.para_section) {
          unchanged += 1;
          continue;
        }
        changed.push(item);
      }
      const bodies = await Promise.all(changed.map((item) => readFile(item.file, 'utf8').catch(() => '')));
      for (let index = 0; index < changed.length; index += 1) {
        const item = changed[index];
        const body = bodies[index];
        const searchMetadata = noteSearchMetadata(body, path.relative(root, item.file));
        upsert.run(
          item.relativePath,
          item.file,
          titleFromText(body, item.file),
          body,
          searchMetadata.noteType,
          searchMetadata.status,
          searchMetadata.maturity,
          searchMetadata.lens,
          searchMetadata.paraSection,
          item.metadata.mtimeMs,
          item.metadata.size,
        );
        indexed += 1;
        hasChanges = true;
      }
    }
    for (const relativePath of indexedPaths) {
      if (!seen.has(relativePath)) {
        deleteNote.run(relativePath);
        deleted += 1;
        hasChanges = true;
      }
    }
    if (hasChanges) {
      db.exec("INSERT INTO note_fts(note_fts) VALUES('rebuild')");
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  await rememberRecentSync(cacheKey, root, files, directories);
  return {
    scannedFiles: files.length,
    indexedFiles: files.length,
    changedFiles: indexed,
    deletedFiles: deleted,
    unchangedFiles: unchanged,
  };
}

function syncCacheKey({ wikiPath, root, excludeDirs }) {
  return JSON.stringify({
    wikiPath: path.resolve(wikiPath),
    root: path.resolve(root),
    excludeDirs: [...(excludeDirs || [])].sort(),
  });
}

async function rememberRecentSync(cacheKey, root, files, directories) {
  const previous = recentSyncs.get(cacheKey);
  if (previous?.watchers) {
    for (const watcher of previous.watchers) watcher.close();
  }
  if (previous?.timer) clearTimeout(previous.timer);
  const wikiPath = JSON.parse(cacheKey).wikiPath;
  for (const [key, value] of recentSyncs) {
    if (key !== cacheKey && value.wikiPath === wikiPath) {
      for (const watcher of value.watchers) watcher.close();
      if (value.timer) clearTimeout(value.timer);
      recentSyncs.delete(key);
    }
  }
  const entry = { syncedAt: Date.now(), dirty: false, watchers: [], timer: null, wikiPath, directoryFingerprints: new Map() };
  const watchedFromScan = [...directories].filter((dir) => !isRuntimeDirectory(root, dir));
  const watchDirsAll = watchedFromScan.length > 0 ? watchedFromScan : [...new Set(files.map((file) => path.dirname(file)))];
  const watchDirs = watchDirsAll.slice(0, 128);
  if (watchDirs.length < watchDirsAll.length) entry.dirty = true;
  for (const dir of watchDirs) {
    const fingerprint = await directoryFingerprint(dir);
    if (fingerprint) entry.directoryFingerprints.set(dir, fingerprint);
    else entry.dirty = true;
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (shouldIgnoreWatchEvent(filename)) return;
        entry.dirty = true;
      });
      watcher.on('error', () => {
        entry.dirty = true;
      });
      if (watcher.unref) watcher.unref();
      entry.watchers.push(watcher);
    } catch {
      entry.dirty = true;
    }
  }
  entry.timer = setTimeout(() => {
    for (const watcher of entry.watchers) watcher.close();
    recentSyncs.delete(cacheKey);
  }, RECENT_SYNC_TTL_MS);
  if (entry.timer.unref) entry.timer.unref();
  recentSyncs.set(cacheKey, entry);
}

async function recentSyncStillFresh(entry) {
  if (entry.directoryFingerprints.size === 0) return !entry.dirty;
  const current = await Promise.all([...entry.directoryFingerprints].map(async ([dir, expected]) => ({
    expected,
    actual: await directoryFingerprint(dir),
  })));
  return current.every((item) => item.actual && item.actual === item.expected);
}

async function directoryFingerprint(dir) {
  try {
    const info = await stat(dir, { bigint: true });
    return `${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

function shouldIgnoreWatchEvent(filename) {
  if (!filename) return false;
  const normalized = String(filename || '').split(path.sep).join('/');
  return normalized === '.omw' || normalized.startsWith('.omw/');
}

function isRuntimeDirectory(root, dir) {
  return path.relative(root, dir).split(path.sep).includes('.omw');
}

function queryIndex({ db, wikiPath, query, limit, ranking }) {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return { backend: 'sqlite', total: 0, results: [] };
  }
  const ftsQuery = terms.map((term) => `${escapeFtsTerm(term)}*`).join(' AND ');
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const rows = db
    .prepare(
      `
      SELECT
        notes.path,
        notes.relative_path,
        notes.title,
        notes.body,
        notes.note_type,
        notes.status,
        notes.maturity,
        notes.lens,
        notes.para_section,
        bm25(note_fts) AS base_rank,
        (
          bm25(note_fts)
          - CASE WHEN instr(lower(notes.title), ?) > 0 THEN ? ELSE 0 END
          - CASE WHEN notes.note_type <> '' THEN ? ELSE 0 END
          - CASE WHEN notes.maturity <> '' THEN ? ELSE 0 END
          - CASE WHEN notes.status <> '' THEN ? ELSE 0 END
          - CASE WHEN notes.lens <> '' THEN ? ELSE 0 END
        ) AS rank
      FROM note_fts
      JOIN notes ON notes.rowid = note_fts.rowid
      WHERE note_fts MATCH ?
      ORDER BY rank ASC, notes.relative_path ASC
      LIMIT ?
    `,
    )
    .all(normalizedQuery, ranking.title, ranking.noteType, ranking.maturity, ranking.status, ranking.lens, ftsQuery, limit);
  return {
    backend: 'sqlite',
    total: rows.length,
    totalExact: false,
    results: rows.map((row) => ({
      path: row.path || path.join(wikiPath, row.relative_path),
      relativePath: row.relative_path,
      title: row.title,
      score: Number(row.rank),
      rankSignals: {
        baseScore: Number(row.base_rank),
        noteType: row.note_type,
        status: row.status,
        maturity: row.maturity,
        lens: row.lens,
        paraSection: row.para_section,
        ranking,
      },
      excerpt: excerptForTerms(row.body, terms),
    })),
  };
}

function escapeFtsTerm(term) {
  return `"${String(term).replaceAll('"', '""')}"`;
}

function ensureNoteMetadataColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(notes)').all().map((column) => column.name));
  const additions = [
    ['note_type', "TEXT NOT NULL DEFAULT ''"],
    ['status', "TEXT NOT NULL DEFAULT ''"],
    ['maturity', "TEXT NOT NULL DEFAULT ''"],
    ['lens', "TEXT NOT NULL DEFAULT ''"],
    ['para_section', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE notes ADD COLUMN ${name} ${definition}`);
  }
}
