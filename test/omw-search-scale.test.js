import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureWikiSearchIndex, searchWiki } from '../src/wiki/search.mjs';
import { DEFAULT_EXCERPT_VISIBLE_LIMIT } from '../src/wiki/search/shared.mjs';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');
const NOTE_COUNT = 10_000;
const SEEDED_QUERY_COUNT = 20;
const MIN_AVERAGE_NOTE_SIZE = 1024;
const INDEXED_P95_LIMIT_MS = 750;
const SCAN_P95_LIMIT_MS = 8_000;

test('wiki search scale, accuracy, and token discipline gates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-search-scale-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const notesDir = path.join(wiki, 'notes');
  await mkdir(notesDir, { recursive: true });

  const fixture = await writeLargeSearchFixture(notesDir);
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    'en',
    '--no-hooks',
    '--codex-home',
    path.join(root, 'codex'),
    '--claude-home',
    path.join(root, 'claude'),
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ], { env });

  const config = { wikiPath: wiki, wikiLanguage: 'en' };
  const indexed = await runIndexedBenchmark(config, fixture);
  const scan = await runScanBenchmark(config, { ...fixture, seeded: fixture.seeded.slice(0, 5) });
  const cliOutput = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'commonterm', '--backend', 'scan'], { env });
  const renderedResults = cliOutput.stdout.split('\n').filter((line) => line.startsWith('- notes/'));
  const renderedExcerpts = cliOutput.stdout.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim());

  assert.equal(indexed.backend, 'sqlite');
  assert(indexed.environment.node.startsWith('v'));
  assert.equal(indexed.fixture.noteCount, NOTE_COUNT);
  assert(indexed.fixture.averageNoteSize >= MIN_AVERAGE_NOTE_SIZE);
  assert(indexed.p95Ms <= INDEXED_P95_LIMIT_MS, benchmarkFailure('indexed', indexed, INDEXED_P95_LIMIT_MS));
  assert(indexed.top5Recall >= 0.90, `indexed top-5 recall ${indexed.top5Recall} < 0.90`);
  assert(indexed.top1Precision >= 0.75, `indexed top-1 precision ${indexed.top1Precision} < 0.75`);
  assert(indexed.excerptLengths.every((length) => length <= DEFAULT_EXCERPT_VISIBLE_LIMIT));
  assert(indexed.excerptsContainTerms);

  assert(scan.p95Ms <= SCAN_P95_LIMIT_MS, benchmarkFailure('scan', scan, SCAN_P95_LIMIT_MS));
  assert(scan.top5Recall >= 0.90, `scan top-5 recall ${scan.top5Recall} < 0.90`);
  assert(scan.top1Precision >= 0.75, `scan top-1 precision ${scan.top1Precision} < 0.75`);
  assert(scan.excerptLengths.every((length) => length <= DEFAULT_EXCERPT_VISIBLE_LIMIT));
  assert(scan.excerptsContainTerms);

  assert(renderedResults.length <= 20);
  assert(renderedExcerpts.every((excerpt) => excerpt.length <= DEFAULT_EXCERPT_VISIBLE_LIMIT));
});

async function writeLargeSearchFixture(notesDir) {
  const filler = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu commonterm '.repeat(15);
  const seeded = [];
  let totalSize = 0;
  const batchSize = 250;
  for (let start = 0; start < NOTE_COUNT; start += batchSize) {
    const writes = [];
    for (let index = start; index < Math.min(start + batchSize, NOTE_COUNT); index += 1) {
      const seededIndex = index < SEEDED_QUERY_COUNT ? index : -1;
      const query = seededIndex === -1 ? '' : `atlasanswer${String(seededIndex).padStart(2, '0')}`;
      const relativePath = `notes/note-${String(index).padStart(5, '0')}.md`;
      const body = [
        '---',
        'type: Permanent Note',
        'status: active',
        '---',
        `# ${query ? `Search Target ${seededIndex}` : `Scale Note ${index}`}`,
        '',
        query ? `${query} is the deterministic known answer for query ${seededIndex}.` : 'This generic scale note has no seeded answer token.',
        filler,
        `sequence ${index}`,
        '',
      ].join('\n');
      totalSize += Buffer.byteLength(body);
      if (query) seeded.push({ query, expectedPath: relativePath });
      writes.push(writeFile(path.join(notesDir, `note-${String(index).padStart(5, '0')}.md`), body));
    }
    await Promise.all(writes);
  }
  return { seeded, noteCount: NOTE_COUNT, averageNoteSize: totalSize / NOTE_COUNT };
}

async function runIndexedBenchmark(config, fixture) {
  const buildStart = performance.now();
  const index = await ensureWikiSearchIndex({ config });
  const coldIndexBuildMs = performance.now() - buildStart;
  if (index.skipped || index.backend !== 'sqlite') {
    assert.fail(`SQLite indexed benchmark unavailable; scan fallback remains available but PRD indexed gate requires node:sqlite. ${index.message || ''}`);
  }
  return runSearchBenchmark({ config, fixture, backend: 'sqlite', coldIndexBuildMs });
}

async function runScanBenchmark(config, fixture) {
  return runSearchBenchmark({ config, fixture, backend: 'scan', coldIndexBuildMs: 0 });
}

async function runSearchBenchmark({ config, fixture, backend, coldIndexBuildMs }) {
  const durations = [];
  const top5Hits = [];
  const top1Hits = [];
  const excerptLengths = [];
  const failures = [];
  let excerptsContainTerms = true;
  for (const item of fixture.seeded) {
    const start = performance.now();
    const result = await searchWiki({ config, query: item.query, backend, limit: 5 });
    durations.push(performance.now() - start);
    const top5 = result.results.map((entry) => entry.relativePath);
    const top1 = top5[0] || '';
    const top5Hit = top5.includes(item.expectedPath);
    const top1Hit = top1 === item.expectedPath;
    top5Hits.push(top5Hit);
    top1Hits.push(top1Hit);
    for (const entry of result.results) {
      if (entry.excerpt) excerptLengths.push(entry.excerpt.length);
    }
    const expected = result.results.find((entry) => entry.relativePath === item.expectedPath);
    if (!expected?.excerpt?.toLowerCase().includes(item.query)) excerptsContainTerms = false;
    if (!top5Hit || !top1Hit) failures.push({ query: item.query, expected: item.expectedPath, actualTop5: top5, backend });
  }
  return {
    backend,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model || 'unknown',
    },
    fixture: {
      noteCount: fixture.noteCount,
      averageNoteSize: fixture.averageNoteSize,
    },
    coldIndexBuildMs,
    durations,
    p50Ms: percentile(durations, 0.50),
    p95Ms: percentile(durations, 0.95),
    top5Recall: ratio(top5Hits),
    top1Precision: ratio(top1Hits),
    excerptLengths,
    excerptsContainTerms,
    failures,
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
}

function ratio(values) {
  return values.filter(Boolean).length / values.length;
}

function benchmarkFailure(label, benchmark, limit) {
  return [
    `${label} p95 ${benchmark.p95Ms.toFixed(1)}ms > ${limit}ms`,
    `p50=${benchmark.p50Ms.toFixed(1)}ms`,
    `durations=${benchmark.durations.map((value) => value.toFixed(1)).join(',')}`,
    `coldIndexBuild=${benchmark.coldIndexBuildMs.toFixed(1)}ms`,
    `env=${benchmark.environment.node} ${benchmark.environment.platform} ${benchmark.environment.cpu}`,
    `failures=${JSON.stringify(benchmark.failures)}`,
  ].join('\n');
}
