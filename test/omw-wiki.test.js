import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

function execFileWithInput(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { code, signal, stdout, stderr }));
    });
    child.stdin.end(options.input || '');
  });
}

async function setupIsolatedWiki(prefix, language = 'en', options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await cp(path.resolve('.wiki'), wiki, { recursive: true });
  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    language,
    '--no-hooks',
    '--codex-home',
    path.join(root, 'codex'),
    '--claude-home',
    path.join(root, 'claude'),
    '--omx-bin',
    options.omxBin || 'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
    ...(options.wikiAutoCapture ? ['--wiki-auto-capture'] : []),
  ], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  return { root, home, wiki, env: { ...process.env, OH_MY_WIKI_HOME: home } };
}

test('setup uses the repository base wiki by default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-setup-'));
  const home = path.join(root, 'state');
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ], { env: { ...process.env, OH_MY_WIKI_HOME: home } });
  assert.match(stdout, /OMW is ready/);

  const doctor = await execFileAsync(process.execPath, [cliPath, 'doctor', '--json'], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.match(report.config.wikiPath, /\.wiki$/);
});

test('init creates an idempotent base wiki without overwriting existing notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-init-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: home };

  const created = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'init',
    '--wiki',
    wiki,
    '--language',
    'en',
    '--json',
  ], { env })).stdout);
  assert.equal(created.ok, true);
  assert.equal(created.createdWiki, true);
  assert.equal(created.copiedBaseWiki, true);
  assert.match(created.contractPath, /\.omw\/contract\.json$/);
  assert.equal(await readFile(path.join(wiki, 'README.md'), 'utf8').then((text) => text.includes('OMW base wiki')), true);
  assert.equal(await readFile(path.join(wiki, 'AGENTS.md'), 'utf8').then((text) => text.includes('public base wiki')), true);
  assert.equal(await readFile(path.join(wiki, 'scripts/validate-wiki'), 'utf8').then((text) => text.startsWith('#!/usr/bin/env node')), true);

  const markerPath = path.join(wiki, 'en/03. Permanent Notes/03-01. User Note.md');
  await writeFile(markerPath, '# User Note\n\nDo not overwrite.\n');

  const again = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'init',
    '--wiki',
    wiki,
    '--language',
    'en',
    '--json',
  ], { env })).stdout);
  assert.equal(again.ok, true);
  assert.equal(again.createdWiki, false);
  assert.equal(again.copiedBaseWiki, false);
  assert.equal(await readFile(markerPath, 'utf8'), '# User Note\n\nDo not overwrite.\n');

  const status = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'status', '--json'], { env })).stdout);
  assert.equal(status.ok, true);
  assert.equal(status.wikiPath, wiki);
});

test('init connects non-empty markdown wikis without seeding base content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-init-existing-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting note.\n');

  const result = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'init',
    '--wiki',
    wiki,
    '--json',
  ], { env: { ...process.env, OH_MY_WIKI_HOME: home } })).stdout);
  assert.equal(result.ok, true);
  assert.equal(result.createdWiki, false);
  assert.equal(result.copiedBaseWiki, false);
  assert.equal(result.status.contract.source.profile, 'generic-markdown');
  assert.equal(await readFile(path.join(wiki, 'notes/alpha.md'), 'utf8'), '# Alpha\n\nExisting note.\n');
});

test('init does not overwrite hidden-only wiki directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-init-hidden-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(path.join(wiki, '.gitignore'), 'custom\n');

  const result = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'init',
    '--wiki',
    wiki,
    '--json',
  ], { env: { ...process.env, OH_MY_WIKI_HOME: home } })).stdout);
  assert.equal(result.ok, true);
  assert.equal(result.createdWiki, false);
  assert.equal(result.copiedBaseWiki, false);
  assert.equal(await readFile(path.join(wiki, '.gitignore'), 'utf8'), 'custom\n');
});

test('omx wrapper supports env override and top-level passthrough', async () => {
  const { env } = await setupIsolatedWiki('omw-wrapper-', 'en', { omxBin: process.execPath });
  const wrapped = await execFileAsync(process.execPath, [
    cliPath,
    'omx',
    '--',
    '--eval',
    'console.log(process.env.OH_MY_WIKI_ACTIVE + ":" + process.env.OH_MY_WIKI_CONFIGURED)',
  ], { env });
  assert.equal(wrapped.stdout.trim(), '1:1');

  const topLevel = await execFileAsync(process.execPath, [
    cliPath,
    '--eval',
    'console.log(process.env.OH_MY_WIKI_HOME ? "home-ok" : "home-missing")',
  ], { env });
  assert.equal(topLevel.stdout.trim(), 'home-ok');

  const override = await execFileAsync(process.execPath, [
    cliPath,
    'paths',
  ], { env: { ...env, OMW_OMX_BIN: '/tmp/custom-omx' } });
  assert.equal(JSON.parse(override.stdout).omxBin, '/tmp/custom-omx');
});

test('wiki capture writes a redacted raw note', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-capture-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await cp(path.resolve('.wiki'), wiki, { recursive: true });
  await execFileAsync(process.execPath, [cliPath, 'setup', '--wiki', wiki, '--no-hooks', '--codex-home', path.join(root, 'codex'), '--claude-home', path.join(root, 'claude')], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  const result = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--type',
    'agent_session',
    '--title',
    'Generic session',
    '--body',
    'token: secret-value session_id: abc123 /Users/example/private',
  ], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  assert.match(result.stdout, /Captured Raw note/);
});

test('wiki capture and queue work for English and Korean base wikis', async () => {
  for (const language of ['en', 'ko']) {
    const { env } = await setupIsolatedWiki(`omw-queue-${language}-`, language);
    await execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'capture',
      '--type',
      'agent_session',
      '--title',
      `${language} session`,
      '--body',
      `body for ${language}`,
    ], { env });

    const queue = await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env });
    const report = JSON.parse(queue.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.total, 1);
    assert.match(report.items[0].relativePath, new RegExp(`^${language}/01\\. Inbox/01-01\\. Raw/`));
    assert.equal(report.items[0].state, language === 'en' ? 'captured' : '수집됨');
  }
});

test('wiki daily writes localized raw reports for English and Korean base wikis', async () => {
  for (const language of ['en', 'ko']) {
    const { env } = await setupIsolatedWiki(`omw-daily-${language}-`, language);
    const result = await execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'daily',
      '--author',
      'Alex',
      '--team',
      'Docs',
      '--date',
      '2026-05-18',
      '--body',
      '- Documented multilingual wiki behavior',
      '--json',
    ], { env });
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.match(report.relativePath, new RegExp(`^${language}/01\\. Inbox/01-01\\. Raw/01-01-02\\.`));
    const note = await readFile(report.path, 'utf8');
    if (language === 'en') {
      assert.match(note, /reportType: daily_report/);
      assert.match(note, /reportDate: 2026-05-18/);
      assert.match(note, /author: Alex/);
      assert.match(note, /team: Docs/);
      assert.match(note, /# 2026-05-18 Alex Daily Report/);
      assert.match(note, /## Work Completed/);
      assert.match(note, /sensitivityCheck: completed/);
    } else {
      assert.match(note, /# 2026-05-18 Alex 일간 리포트/);
      assert.match(note, /민감정보검사: 완료/);
    }
  }
});

test('wiki daily updates English reports using English sections', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-daily-update-en-', 'en');
  const args = [
    cliPath,
    'wiki',
    'daily',
    '--author',
    'Alex',
    '--team',
    'Docs',
    '--date',
    '2026-05-18',
  ];
  await execFileAsync(process.execPath, [...args, '--body', '- Initial work'], { env });
  const update = await execFileAsync(process.execPath, [
    ...args,
    '--body',
    ['## Blockers', '- Waiting for review', '## Knowledge Candidates', '- Daily reports need localized sections'].join('\n'),
    '--json',
  ], { env });
  const report = JSON.parse(update.stdout);
  const note = await readFile(report.path, 'utf8');
  assert.match(note, /## Blockers \/ Support Needed/);
  assert.match(note, /Waiting for review/);
  assert.match(note, /## Knowledge Candidates/);
  assert.match(note, /Daily reports need localized sections/);
  assert.doesNotMatch(note, /## 막힌 점 \/ 지원 필요/);

  await execFileAsync(path.join(wiki, 'scripts/validate-wiki'), []);
});

test('base wiki report scripts accept spaced language options and localize headings', async () => {
  const english = await setupIsolatedWiki('omw-scripts-en-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--type',
    'agent_session',
    '--title',
    'Script session',
    '--body',
    'script raw body',
  ], { env: english.env });
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'daily',
    '--author',
    'Alex',
    '--team',
    'Docs',
    '--date',
    '2026-05-18',
    '--body',
    '- Script daily body',
  ], { env: english.env });

  const englishRaw = await execFileAsync(path.join(english.wiki, 'scripts/report-raw-ingest'), ['--language', 'en']);
  assert.match(englishRaw.stdout, /# Raw Ingest Report/);
  assert.match(englishRaw.stdout, /\| State \| Target \| Processed at \| Note \|/);
  assert.match(englishRaw.stdout, /captured: 2/);

  const englishDaily = await execFileAsync(path.join(english.wiki, 'scripts/report-daily'), ['--language', 'en']);
  assert.match(englishDaily.stdout, /# Daily Report Summary/);
  assert.match(englishDaily.stdout, /\| Report date \| Author \| Team \| Ingest state \| Related projects \| Note \|/);

  const cliRaw = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-raw-ingest', '--language', 'en'], { env: english.env });
  assert.match(cliRaw.stdout, /# Raw Ingest Report/);
  assert.match(cliRaw.stdout, /captured: 2/);

  const cliDaily = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-daily', '--language', 'en'], { env: english.env });
  assert.match(cliDaily.stdout, /# Daily Report Summary/);
  assert.match(cliDaily.stdout, /\| Report date \| Author \| Team \| Ingest state \| Related projects \| Note \|/);

  const cliValidate = await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env: english.env });
  assert.match(cliValidate.stdout, /OK: base wiki validation passed/);

  const korean = await setupIsolatedWiki('omw-scripts-ko-', 'ko');
  const koreanDaily = await execFileAsync(path.join(korean.wiki, 'scripts/report-daily'), ['--language=ko']);
  assert.match(koreanDaily.stdout, /# 일간 리포트 요약/);
  assert.match(koreanDaily.stdout, /\| 보고일 \| 작성자 \| 팀 \| ingest상태 \| 관련프로젝트 \| 노트 \|/);
});

test('wiki report parser handles inline values, YAML comments, and flow arrays', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-report-yaml-', 'en');
  const created = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'daily',
    '--author=Alex=Lead',
    '--team',
    'Docs',
    '--date',
    '2026-05-18',
    '--body',
    '- Parser coverage',
    '--json',
  ], { env });
  const report = JSON.parse(created.stdout);
  const original = await readFile(report.path, 'utf8');
  const withYamlVariants = original
    .replace('relatedProjects: []', 'relatedProjects: ["Alpha, Beta", Gamma] # inline comment')
    .replace('ingestState: captured', 'ingestState: captured # reviewed');
  await writeFile(report.path, withYamlVariants);

  const summary = await execFileAsync(path.join(wiki, 'scripts/report-daily'), ['--language=en', '--author=Alex=Lead']);
  assert.match(summary.stdout, /\| Alex=Lead \| Docs \| 1 \|/);
  assert.match(summary.stdout, /Alpha, Beta, Gamma/);

  const validation = await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env });
  assert.match(validation.stdout, /OK: base wiki validation passed/);
});

test('wiki search indexes only the active language notes and excludes templates', async () => {
  const english = await setupIsolatedWiki('omw-search-en-', 'en');
  const englishResult = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json', '--limit', '20'], {
    env: english.env,
  });
  const englishSearch = JSON.parse(englishResult.stdout);
  assert.equal(englishSearch.ok, true);
  assert(englishSearch.results.length > 0);
  assert(englishSearch.results.every((item) => item.relativePath.startsWith('en/')));
  assert(englishSearch.results.every((item) => !item.relativePath.includes('/08. Templates/')));
  if (englishSearch.results[0].rankSignals) {
    assert.equal(englishSearch.results[0].rankSignals.paraSection, '06. Resources');
    assert.equal(englishSearch.results[0].rankSignals.maturity, 'stable');
  }

  const korean = await setupIsolatedWiki('omw-search-ko-', 'ko');
  const koreanResult = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', '지식 지도', '--json', '--limit', '20'], {
    env: korean.env,
  });
  const koreanSearch = JSON.parse(koreanResult.stdout);
  assert.equal(koreanSearch.ok, true);
  assert(koreanSearch.results.length > 0);
  assert(koreanSearch.results.every((item) => item.relativePath.startsWith('ko/')));
  assert(koreanSearch.results.every((item) => !item.relativePath.includes('/08. Templates/')));
  if (koreanSearch.results[0].rankSignals) {
    assert.equal(koreanSearch.results[0].rankSignals.paraSection, '06. Resources');
  }
});

test('wiki search accepts contract ranking overrides and rejects invalid keys', async () => {
  const { wiki, env } = await setupIsolatedWiki('omw-search-ranking-', 'en');
  const contractPath = path.join(wiki, '.omw/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.search.ranking = { title: 40, path: 2, bodyTerm: 3 };
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const search = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json', '--backend', 'scan'], { env });
  const result = JSON.parse(search.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].rankSignals.ranking.title, 40);
  assert.equal(result.results[0].rankSignals.ranking.path, 2);
  assert.equal(result.results[0].rankSignals.ranking.bodyTerm, 3);

  contract.search.ranking = { title: -1 };
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--backend', 'scan'], { env }),
    /must be a non-negative number/,
  );

  contract.search.ranking = { title: null };
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'refresh', '--target', 'index'], { env }),
    /must be a non-negative number/,
  );
});

test('scan search matches separated query terms and preserves raw exclusions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-search-scan-terms-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await mkdir(path.join(wiki, 'raw/sessions'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/multi-term.md'), '# Searchable Planning\n\nAlpha notes include a separate beta decision later.\n');
  await writeFile(path.join(wiki, 'notes/partial.md'), '# Alpha Only\n\nThis note intentionally lacks the other term.\n');
  await writeFile(path.join(wiki, 'raw/sessions/raw.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: captured',
    '---',
    '# Raw Terms',
    '',
    'alpha beta raw queue text',
    '',
  ].join('\n'));

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

  const search = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'search',
    'alpha beta',
    '--backend',
    'scan',
    '--json',
  ], { env })).stdout);
  assert.equal(search.ok, true);
  assert.equal(search.backend, 'scan');
  assert(search.results.some((item) => item.relativePath === 'notes/multi-term.md'));
  assert(search.results.every((item) => item.relativePath !== 'notes/partial.md'));
  assert(search.results.every((item) => !item.relativePath.startsWith('raw/')));
});

test('sqlite search keeps legacy default ranking unless contract overrides it', async () => {
  const { wiki, env } = await setupIsolatedWiki('omw-search-sqlite-ranking-', 'en');
  const sqliteSearch = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json', '--backend', 'sqlite'], { env }).catch((error) => {
    if (/sqlite search backend requires node:sqlite support|Wiki search backend is not available: sqlite/.test(error.stderr || error.message)) return null;
    throw error;
  });
  if (!sqliteSearch) return;

  const defaultResult = JSON.parse(sqliteSearch.stdout);
  assert.equal(defaultResult.results[0].rankSignals.ranking.title, 8);

  const contractPath = path.join(wiki, '.omw/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.search.ranking = { title: 40 };
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const overridden = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json', '--backend', 'sqlite'], { env })).stdout);
  assert.equal(overridden.results[0].rankSignals.ranking.title, 40);
});

test('setup regenerates scanner-owned contract sections from the connected wiki', async () => {
  const { wiki, env } = await setupIsolatedWiki('omw-contract-regenerate-', 'en');
  const contractPath = path.join(wiki, '.omw/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  delete contract.rules.aiPlatform;
  contract.rules.noteWriting.path = 'stale-seed/path.md';
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    'en',
    '--no-hooks',
    '--codex-home',
    path.join(path.dirname(wiki), 'codex'),
    '--claude-home',
    path.join(path.dirname(wiki), 'claude'),
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ], { env });

  const updated = JSON.parse(await readFile(contractPath, 'utf8'));
  assert.equal(updated.language, 'en');
  assert.equal(updated.generatedBy, 'omw-contract-scanner');
  assert.equal(updated.rules.noteWriting.path, 'en/06. Resources/06-01. Guides/06-01-02. Note Writing Rules.md');
  assert.equal(updated.rules.aiPlatform.path, 'en/06. Resources/06-01. Guides/06-01-04. AI Tool Integration Principles.md');
});

test('scanner generates a working contract for a custom external wiki without base structure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-custom-wiki-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'knowledge/raw/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'knowledge/templates'), { recursive: true });
  await mkdir(path.join(wiki, 'knowledge/rules'), { recursive: true });
  await mkdir(path.join(wiki, 'knowledge/notes'), { recursive: true });
  await writeFile(path.join(wiki, 'knowledge/templates/session.md'), [
    '---',
    'type: CustomRaw',
    'rawType: {{rawType}}',
    'ingestState: new',
    'sensitivityCheck: {{sensitivityCheck}}',
    '---',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'knowledge/rules/operations.md'), '# Operations\n\nUse the custom wiki contract.\n');
  await writeFile(path.join(wiki, 'knowledge/notes/map.md'), '# Unique Custom Map\n\nSearchable custom wiki note.\n');

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
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.source.profile, 'generic-markdown');
  assert.equal(contract.raw.root, 'knowledge/raw');
  assert.equal(contract.raw.noteTypes[0], 'CustomRaw');
  assert.equal(contract.raw.types.agent_session.folder, 'sessions');
  assert.equal(contract.raw.types.agent_session.agentTemplate, 'knowledge/templates/session.md');

  const capture = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--type',
    'agent_session',
    '--title',
    'External wiki session',
    '--body',
    'custom body',
    '--json',
  ], { env });
  const captured = JSON.parse(capture.stdout);
  assert.match(captured.path, /knowledge\/raw\/sessions\/01\. /);
  const note = await readFile(captured.path, 'utf8');
  assert.match(note, /type: CustomRaw/);
  assert.match(note, /sensitivityCheck: completed/);

  const queue = await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env });
  const queued = JSON.parse(queue.stdout);
  assert.equal(queued.total, 1);
  assert.equal(queued.items[0].state, 'new');
  assert.equal(queued.items[0].target, '');

  const search = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Unique Custom Map', '--json'], { env });
  const results = JSON.parse(search.stdout);
  assert.equal(results.ok, true);
  assert(results.results.some((item) => item.relativePath === 'knowledge/notes/map.md'));
  assert(results.results.every((item) => !item.relativePath.includes('/templates/')));
});

test('scanner supports Karpathy-style LLM wiki layout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-karpathy-wiki-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'sources'), { recursive: true });
  await mkdir(path.join(wiki, 'wiki'), { recursive: true });
  await writeFile(path.join(wiki, 'AGENTS.md'), '# Wiki Schema\n\nMaintain the LLM wiki carefully.\n');
  await writeFile(path.join(wiki, 'sources/article.md'), '# Source Article\n\nRaw source material.\n');
  await writeFile(path.join(wiki, 'wiki/index.md'), '# Index\n\n- [[Topic A]]\n');
  await writeFile(path.join(wiki, 'wiki/log.md'), '# Log\n\n## [2026-05-18] ingest | Source Article\n');
  await writeFile(path.join(wiki, 'wiki/topic-a.md'), '# Topic A\n\nCompiled durable knowledge about alpha synthesis.\n');

  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
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
  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.source.profile, 'karpathy-llm-wiki');
  assert.equal(contract.search.root, 'wiki');
  assert(!contract.search.excludeDirs.includes('sources'));
  assert.equal(contract.rules.agentKnowledge.path, 'AGENTS.md');
  assert.equal(contract.rules.knowledgeMap.path, 'wiki/index.md');

  const search = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'alpha synthesis', '--json'], { env });
  const results = JSON.parse(search.stdout);
  assert.equal(results.ok, true);
  assert(results.results.some((item) => item.relativePath === 'wiki/topic-a.md'));
  assert(results.results.every((item) => !item.relativePath.startsWith('sources/')));
  const sourceSearch = await execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Raw source material', '--json'], { env });
  assert.equal(JSON.parse(sourceSearch.stdout).total, 0);
});

test('scanner and queue support raw notes that use status frontmatter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-status-wiki-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'knowledge/raw/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'knowledge/notes'), { recursive: true });
  await writeFile(path.join(wiki, 'knowledge/raw/sessions/session.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'status: new',
    '---',
    '# Existing Status Raw',
    '',
    'Raw body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'knowledge/notes/index.md'), '# Index\n\nDurable knowledge.\n');

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

  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.deepEqual(contract.ingest.pendingStates, ['new']);

  const queue = await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env });
  const queued = JSON.parse(queue.stdout);
  assert.equal(queued.total, 1);
  assert.equal(queued.items[0].state, 'new');
  assert.equal(queued.items[0].relativePath, 'knowledge/raw/sessions/session.md');
});

test('wiki ingest writes review drafts only with explicit opt-in', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-draft-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Draft Source',
    '--body',
    'Draftable raw body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;

  const preview = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--json'], { env })).stdout);
  assert.equal(preview.writePerformed, false);
  assert.equal(preview.relativePath, null);

  const draft = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft', '--json'], { env })).stdout);
  assert.equal(draft.writePerformed, true);
  assert.match(draft.relativePath, /^\.omw\/ingest-drafts\//);
  const draftText = await readFile(path.join(wiki, draft.relativePath), 'utf8');
  assert.match(draftText, /status: review/);
  assert.match(draftText, /Draftable raw body/);

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft'], { env }),
    /Use --overwrite-draft/,
  );
});

test('wiki ingest refuses symlinked review draft targets', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-draft-symlink-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Symlink Source',
    '--body',
    'Symlink raw body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;
  const external = path.join(path.dirname(wiki), 'external-drafts');
  await mkdir(external, { recursive: true });
  await mkdir(path.join(wiki, '.omw'), { recursive: true });
  await symlink(external, path.join(wiki, '.omw', 'ingest-drafts'), 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft'], { env }),
    /draft root must be a real directory|draft root must stay inside the wiki/i,
  );
});

test('wiki ingest refuses symlinked .omw before creating draft directories outside the wiki', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-omw-symlink-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'OMW Symlink Source',
    '--body',
    'OMW symlink raw body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;
  const external = path.join(path.dirname(wiki), 'external-omw');
  await cp(path.join(wiki, '.omw'), external, { recursive: true });
  await rm(path.join(wiki, '.omw'), { recursive: true, force: true });
  await symlink(external, path.join(wiki, '.omw'), 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--json'], { env }),
    /\.omw directory must be a real directory/i,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft'], { env }),
    /\.omw directory must be a real directory/i,
  );
  await assert.rejects(readFile(path.join(external, 'ingest-drafts', 'OMW Symlink Source.md'), 'utf8'));
});

test('wiki ingest refuses symlinked review draft files on overwrite', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-draft-file-symlink-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Link Draft',
    '--body',
    'Linked draft body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;
  const draftRoot = path.join(wiki, '.omw', 'ingest-drafts');
  const external = path.join(path.dirname(wiki), 'external-draft.md');
  await mkdir(draftRoot, { recursive: true });
  await writeFile(external, 'outside');
  await symlink(external, path.join(draftRoot, 'Link Draft.md'));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--write-draft', '--overwrite-draft'], { env }),
    /overwrite requires a regular file/i,
  );
  assert.equal(await readFile(external, 'utf8'), 'outside');
});

test('wiki ingest refuses symlinked Raw notes before writing review drafts', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-raw-symlink-', 'en');
  const rawRoot = path.join(wiki, 'en', '01. Inbox', '01-01. Raw', '01-01-03. Agent Sessions');
  const external = path.join(path.dirname(wiki), 'external-raw.md');
  const rawLink = path.join(rawRoot, 'external-link.md');
  await writeFile(external, [
    '---',
    'type: Raw',
    'status: captured',
    '---',
    '',
    '# External Link',
    '',
    'External secret body.',
    '',
  ].join('\n'));
  await symlink(external, rawLink);

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', path.relative(wiki, rawLink), '--write-draft'], { env }),
    /Raw note must be a real file/i,
  );
  await assert.rejects(readFile(path.join(wiki, '.omw', 'ingest-drafts', 'External Link.md'), 'utf8'));
});

test('scanner ignores sensitivity-only durable notes and template placeholders for raw inference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-raw-inference-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'knowledge/raw/sessions'), { recursive: true });
  await mkdir(path.join(wiki, 'knowledge/templates'), { recursive: true });
  await mkdir(path.join(wiki, 'knowledge/notes'), { recursive: true });
  await writeFile(path.join(wiki, 'knowledge/templates/session.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'ingestState: {{ingestState}}',
    '---',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'knowledge/raw/sessions/session.md'), [
    '---',
    'type: Raw',
    'rawType: agent_session',
    'status: new',
    '---',
    '# Existing Status Raw',
    '',
    'Raw body.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'knowledge/notes/article.md'), [
    '---',
    'type: Article',
    'status: stable',
    'sensitivityCheck: reviewed',
    '---',
    '# Durable Article',
    '',
    'Durable article body.',
    '',
  ].join('\n'));

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

  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.deepEqual(contract.ingest.pendingStates, ['new']);
});

test('scanner enables generated fallback raw capture for a generic markdown wiki', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-generic-wiki-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await mkdir(path.join(wiki, 'docs'), { recursive: true });
  await writeFile(path.join(wiki, 'README.md'), '# Personal Wiki\n\nA simple markdown knowledge base.\n');
  await writeFile(path.join(wiki, 'notes/a.md'), [
    '---',
    'type: Article',
    'status: stable',
    '---',
    '# Alpha Note',
    '',
    'Reusable alpha knowledge.',
    '',
  ].join('\n'));
  await writeFile(path.join(wiki, 'docs/b.md'), '# Beta Doc\n\nBeta documentation.\n');

  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
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

  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.source.profile, 'generic-markdown');
  assert.equal(contract.raw.root, '.omw/raw');
  assert.deepEqual(contract.raw.noteTypes, ['Raw']);
  assert.equal(contract.capabilities.capture.ready, true);
  assert.equal(contract.raw.types.agent_session.agentTemplate, '.omw/templates/agent_session.md');

  const capture = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Generic fallback session',
    '--body',
    'fallback body',
    '--json',
  ], { env });
  const captured = JSON.parse(capture.stdout);
  assert.match(captured.path, /\.omw\/raw\/agent_sessions\/01\. /);
  const note = await readFile(captured.path, 'utf8');
  assert.match(note, /type: Raw/);

  const queue = await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env });
  const queued = JSON.parse(queue.stdout);
  assert.equal(queued.total, 1);
  assert.equal(queued.items[0].state, 'captured');
});

test('queue keeps schema v1 contracts usable with default raw note types', async () => {
  const { wiki, env } = await setupIsolatedWiki('omw-v1-queue-', 'en');
  const contractPath = path.join(wiki, '.omw/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  delete contract.raw.noteTypes;
  contract.schemaVersion = 1;
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Schema v1 queue session',
    '--body',
    'v1 body',
  ], { env });

  const queue = await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env });
  const queued = JSON.parse(queue.stdout);
  assert.equal(queued.total, 1);
  assert.equal(queued.items[0].state, 'captured');
});

test('hook auto capture writes localized stop-session raw notes', async () => {
  for (const language of ['en', 'ko']) {
    const { env, wiki } = await setupIsolatedWiki(`omw-hook-${language}-`, language, { wikiAutoCapture: true });
    await execFileWithInput(process.execPath, [cliPath, 'hook', 'Stop'], {
      env,
      input: JSON.stringify({ cwd: path.join(wiki, 'workspace-alpha'), transcript_path: '/tmp/transcript.jsonl' }),
    });
    const queue = await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env });
    const report = JSON.parse(queue.stdout);
    assert.equal(report.total, 1);
    const note = await readFile(report.items[0].path, 'utf8');
    if (language === 'en') {
      assert.match(note, /# AI session raw capture - workspace-alpha/);
      assert.match(note, /Session Raw captured at platform stop time/);
      assert.doesNotMatch(note, /플랫폼 작업 종료/);
    } else {
      assert.match(note, /# AI 세션 Raw 축적 - workspace-alpha/);
      assert.match(note, /플랫폼 작업 종료 시점/);
    }
  }
});


test('setup language updates contract paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-language-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await cp(path.resolve('.wiki'), wiki, { recursive: true });

  const commonArgs = [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--no-hooks',
    '--codex-home',
    path.join(root, 'codex'),
    '--claude-home',
    path.join(root, 'claude'),
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ];

  await execFileAsync(process.execPath, [...commonArgs, '--language', 'en'], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  let contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.language, 'en');
  assert.equal(contract.rules.noteWriting.path, 'en/06. Resources/06-01. Guides/06-01-02. Note Writing Rules.md');

  await execFileAsync(process.execPath, [...commonArgs, '--language', 'ko'], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.language, 'ko');
  assert.equal(contract.rules.noteWriting.path, 'ko/06. Resources/06-01. 가이드/06-01-02. 노트 작성 규칙.md');
});
