import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../../utils/fs.js';
import { DEFAULT_SQLITE_SEARCH_RANKING, excerptForTerms, markdownFiles, noteFileMetadata, noteSearchMetadata, normalizeSearchRanking, queryTerms, titleFromText } from './shared.mjs';

const INDEX_RELATIVE_PATH = path.join('.omw', 'index.sqlite');

export const sqliteSearchBackend = {
  name: 'sqlite',
  async available() {
    return Boolean(await loadSqlite());
  },
  async search({ wikiPath, searchRootPath, excludeDirs = [], rankingOverrides = {}, query, limit }) {
    const sqlite = await loadSqlite();
    if (!sqlite) {
      throw new Error('sqlite search backend requires node:sqlite support');
    }
    const dbPath = path.join(wikiPath, INDEX_RELATIVE_PATH);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      prepareSchema(db);
      await syncIndex({ db, wikiPath, searchRootPath: searchRootPath || wikiPath, excludeDirs });
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
  await mkdir(path.dirname(dbPath), { recursive: true });
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

async function syncIndex({ db, wikiPath, searchRootPath, excludeDirs }) {
  const root = searchRootPath || wikiPath;
  const files = await markdownFiles(root, { excludeDirs });
  const seen = new Set();
  const select = db.prepare('SELECT mtime_ms, size, para_section FROM notes WHERE relative_path = ?');
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
  const indexedPaths = db.prepare('SELECT relative_path FROM notes').all().map((row) => row.relative_path);
  const deleteNote = db.prepare('DELETE FROM notes WHERE relative_path = ?');

  const updates = [];
  let unchanged = 0;
  for (const file of files) {
    const relativePath = path.relative(wikiPath, file);
    seen.add(relativePath);
    const metadata = await noteFileMetadata(file);
    const current = select.get(relativePath);
    if (current && current.mtime_ms === metadata.mtimeMs && current.size === metadata.size && current.para_section) {
      unchanged += 1;
      continue;
    }
    const body = await readFile(file, 'utf8').catch(() => '');
    const searchMetadata = noteSearchMetadata(body, path.relative(root, file));
    updates.push({
      relativePath,
      file,
      title: titleFromText(body, file),
      body,
      ...searchMetadata,
      ...metadata,
    });
  }
  for (const relativePath of indexedPaths) {
    if (!seen.has(relativePath)) updates.push({ relativePath, delete: true });
  }
  const deleted = updates.filter((item) => item.delete).length;
  const indexed = updates.length - deleted;
  if (updates.length > 0) {
    db.exec('BEGIN');
    try {
      for (const item of updates) {
        if (item.delete) {
          deleteNote.run(item.relativePath);
        } else {
          upsert.run(
            item.relativePath,
            item.file,
            item.title,
            item.body,
            item.noteType,
            item.status,
            item.maturity,
            item.lens,
            item.paraSection,
            item.mtimeMs,
            item.size,
          );
        }
      }
      db.exec("INSERT INTO note_fts(note_fts) VALUES('rebuild')");
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    scannedFiles: files.length,
    indexedFiles: files.length,
    changedFiles: indexed,
    deletedFiles: deleted,
    unchangedFiles: unchanged,
  };
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
  const count = db.prepare('SELECT count(*) AS total FROM note_fts WHERE note_fts MATCH ?').get(ftsQuery)?.total || 0;
  return {
    backend: 'sqlite',
    total: count,
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
