import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

async function updateWikiContract(wiki, update) {
  const contractPath = path.join(wiki, '.omw', 'contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  await writeFile(contractPath, `${JSON.stringify(update(contract), null, 2)}\n`);
}

async function snapshotUserMarkdown(root, relativeDir = '') {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const snapshot = {};
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (relativePath === '.omw' || relativePath.startsWith(`${path.sep}.omw${path.sep}`)) continue;
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotUserMarkdown(root, relativePath));
      continue;
    }
    if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      snapshot[relativePath.split(path.sep).join('/')] = await readFile(path.join(root, relativePath), 'utf8');
    }
  }
  return snapshot;
}

async function sqliteAvailable() {
  return import('node:sqlite').then(() => true, () => false);
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
  assert.match(stdout, /Registered wiki:/);
  assert.doesNotMatch(stdout, /Registered base wiki:/);

  const doctor = await execFileAsync(process.execPath, [cliPath, 'doctor', '--json'], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.match(report.config.wikiPath, /\.wiki$/);
  assert.equal(await readFile(path.resolve('.wiki/.omw/contract.json'), 'utf8').then((text) => text.includes('omw-contract-scanner')), true);
});

test('doctor reports configured wikiPath files as invalid directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-config-wiki-file-'));
  const home = path.join(root, 'state');
  const wikiFile = path.join(root, 'wiki.md');
  await mkdir(home, { recursive: true });
  await writeFile(wikiFile, '# Not A Wiki Directory\n');
  await writeFile(path.join(home, 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourcePath: path.resolve('.'),
    wikiPath: wikiFile,
    wikiLanguage: 'en',
    omxBin: 'omw-definitely-missing-command',
    omcBin: 'omw-definitely-missing-command',
  }, null, 2)}\n`);

  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'doctor', '--json'], {
          env: { ...process.env, OH_MY_WIKI_HOME: home },
        });
      } catch (error) {
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert(report.issues.some((issue) => issue.includes('wikiPath must be a real directory')));
        throw error;
      }
    },
    /Command failed/,
  );
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
  await assert.rejects(readFile(path.join(wiki, 'scripts/validate-wiki'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8').then((text) => text.includes('omw-contract-scanner')), true);

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

test('wiki validate uses contract-aware checks for generic markdown wikis', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-validate-generic-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting note without base-wiki frontmatter.\n');

  await execFileAsync(process.execPath, [
    cliPath,
    'init',
    '--wiki',
    wiki,
    '--json',
  ], { env });

  const plain = await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env });
  assert.match(plain.stdout, /OK: wiki contract validation passed/);

  const ok = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate', '--json'], { env })).stdout);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'contract');
  assert.equal(ok.profile, 'generic-markdown');
  assert.deepEqual(ok.failures, []);

  const secretPath = path.join(wiki, 'notes/secret.md');
  await writeFile(secretPath, `# Secret\n\nOPENAI_API_KEY=${['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'validate', '--json'], { env }),
    (error) => {
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert(report.failures.some((failure) => failure.includes('environment-style secrets must not be stored')));
      return true;
    },
  );
  await rm(secretPath, { force: true });

  await writeFile(path.join(wiki, 'notes/broken.md'), '---\ntitle: Broken\n# Missing closing fence\n');
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'validate', '--json'], { env }),
    (error) => {
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert(report.failures.some((failure) => failure.includes('notes/broken.md: frontmatter closing marker missing')));
      return true;
    },
  );
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

test('setup refuses symlinked .omw before writing managed contract assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-setup-omw-symlink-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const external = path.join(root, 'external-omw');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting personal note.\n');
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(wiki, '.omw'), 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [
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
    ], { env: { ...process.env, OH_MY_WIKI_HOME: home } }),
    /.omw directory must be a real directory/,
  );
  await assert.rejects(readFile(path.join(external, 'contract.json'), 'utf8'));
  await assert.rejects(readdir(path.join(external, 'raw')));
  await assert.rejects(readdir(path.join(external, 'templates')));
});

test('setup and status refuse symlinked wiki contract files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-setup-contract-symlink-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const external = path.join(root, 'external-contract.json');
  const contractLink = path.join(wiki, '.omw', 'contract.json');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await mkdir(path.join(wiki, '.omw'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting personal note.\n');
  await writeFile(external, '{"schemaVersion":2,"generatedBy":"external"}\n');
  await symlink(external, contractLink);

  await assert.rejects(
    execFileAsync(process.execPath, [
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
    ], { env: { ...process.env, OH_MY_WIKI_HOME: home } }),
    /Wiki contract must be a real file/,
  );
  assert.equal(await readFile(external, 'utf8'), '{"schemaVersion":2,"generatedBy":"external"}\n');
  await assert.rejects(readdir(path.join(wiki, '.omw', 'raw')));
  await assert.rejects(readdir(path.join(wiki, '.omw', 'templates')));

  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'status', '--json'], { env: { ...process.env, OH_MY_WIKI_HOME: home } });
      } catch (error) {
        assert.match(error.stdout, /Wiki contract must be a real file/);
        throw error;
      }
    },
    /Command failed/,
  );
});

test('setup refuses symlinked managed fallback raw root before writing assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-setup-raw-root-symlink-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const external = path.join(root, 'external-raw');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting personal note.\n');
  await mkdir(path.join(wiki, '.omw'), { recursive: true });
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(wiki, '.omw/raw'), 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [
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
    ], { env: { ...process.env, OH_MY_WIKI_HOME: home } }),
    /Raw root must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('setup refuses symlinked managed fallback template directory before writing assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-setup-template-symlink-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const external = path.join(root, 'external-templates');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting personal note.\n');
  await mkdir(path.join(wiki, '.omw'), { recursive: true });
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(wiki, '.omw/templates'), 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [
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
    ], { env: { ...process.env, OH_MY_WIKI_HOME: home } }),
    /Raw template directory must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('setup refuses broken symlinked managed fallback templates before replacing them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-setup-template-broken-symlink-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const templateDir = path.join(wiki, '.omw/templates');
  const external = path.join(root, 'missing-template.md');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await mkdir(templateDir, { recursive: true });
  await writeFile(path.join(wiki, 'notes/index.md'), '# Personal Wiki\n');
  await symlink(external, path.join(templateDir, 'agent_session.md'));

  await assert.rejects(
    execFileAsync(process.execPath, [
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
    ], { env: { ...process.env, OH_MY_WIKI_HOME: home } }),
    /Raw template must be a real file/,
  );
  await assert.rejects(readFile(external, 'utf8'));
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
    [
      'token: secret-value session_id: abc123 /Users/example/private',
      'Authorization: Bearer header.payload.signature',
      'github token ghp_abcdefghijklmnopqrstuvwxyz123456',
      'jwt abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz',
      'signed https://example.com/file?X-Amz-Signature=abc123&token=secret',
      '-----BEGIN PRIVATE KEY-----',
      'secret-key-material',
      '-----END PRIVATE KEY-----',
    ].join('\n'),
    '--json',
  ], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  const captured = JSON.parse(result.stdout);
  const note = await readFile(captured.path, 'utf8');
  assert.match(note, /\[REDACTED\]/);
  assert.match(note, /\[REDACTED_SESSION\]/);
  assert.match(note, /\[REDACTED_LOCAL_PATH\]/);
  assert.match(note, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(note, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(note, /\[REDACTED_JWT\]/);
  assert.doesNotMatch(note, /secret-value|abc123|ghp_|secret-key-material|header\.payload\.signature/);
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

test('wiki capture allocates unique raw note paths under concurrent writes', async () => {
  const { env } = await setupIsolatedWiki('omw-capture-concurrent-', 'en');
  const captures = await Promise.all(Array.from({ length: 6 }, (_, index) => execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--type',
    'agent_session',
    '--title',
    'Concurrent session',
    '--body',
    `body ${index}`,
    '--json',
  ], { env })));
  const paths = captures.map((result) => JSON.parse(result.stdout).path);
  assert.equal(new Set(paths).size, captures.length);

  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, captures.length);
});

test('wiki capture refuses symlinked Raw type folders before writing', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-capture-raw-symlink-', 'en');
  const external = path.join(root, 'external-raw');
  const rawFolder = path.join(wiki, 'en/01. Inbox/01-01. Raw/01-01-03. Agent Sessions');
  await mkdir(external, { recursive: true });
  await rm(rawFolder, { recursive: true, force: true });
  await symlink(external, rawFolder, 'dir');

  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'status', '--json'], { env });
      } catch (error) {
        const status = JSON.parse(error.stdout);
        assert.equal(status.raw.types.find((entry) => entry.key === 'agent_session').exists, false);
        assert(status.issues.some((issue) => /Raw type folder must be a real directory/.test(issue)));
        throw error;
      }
    },
    /Command failed/,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'capture',
      '--title',
      'Blocked symlink capture',
      '--body',
      'This must not be written outside the wiki.',
    ], { env }),
    /Raw type folder must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('wiki capture dry-run refuses symlinked Raw type folders before listing', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-capture-dry-raw-symlink-', 'en');
  const rawFolder = path.join(wiki, 'en/01. Inbox/01-01. Raw/01-01-03. Agent Sessions');
  const external = path.join(root, 'external-raw');
  await rm(rawFolder, { recursive: true, force: true });
  await mkdir(external, { recursive: true });
  await symlink(external, rawFolder, 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'capture',
      '--title',
      'Blocked dry-run capture',
      '--body',
      'Dry-run must not inspect external raw folders.',
      '--dry-run',
    ], { env }),
    /Raw type folder must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('wiki capture refuses symlinked intermediate Raw type ancestors before mkdir', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-capture-raw-ancestor-symlink-', 'en');
  const rawRoot = path.join(wiki, 'en/01. Inbox/01-01. Raw');
  const external = path.join(root, 'external-raw-ancestor');
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(rawRoot, 'linked'), 'dir');
  await updateWikiContract(wiki, (contract) => {
    contract.raw.types.agent_session.folder = 'linked/agent_sessions';
    return contract;
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'capture',
      '--title',
      'Blocked ancestor capture',
      '--body',
      'Recursive mkdir must not create folders outside the wiki.',
    ], { env }),
    /Raw type folder ancestor must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('wiki capture refuses symlinked Raw templates before reading', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-capture-template-symlink-', 'en');
  const external = path.join(root, 'external-template.md');
  const templatePath = path.join(wiki, 'en/08. Templates/08-01. Inbox/08-01-02. Human/08-01-02-02. Agent Session Raw Template.md');
  await writeFile(external, [
    '---',
    'type: Raw',
    'rawType: agent_session',
    '---',
    '',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n'));
  await rm(templatePath, { force: true });
  await symlink(external, templatePath);

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'capture',
      '--title',
      'Blocked template capture',
      '--body',
      'This template must not be read through a symlink.',
    ], { env }),
    /Raw template must be a real file/,
  );
  assert.match(await readFile(external, 'utf8'), /# \{\{title\}\}/);
});

test('wiki capture refuses broken symlinked Raw templates before treating them as missing', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-capture-template-broken-symlink-', 'en');
  const missingExternal = path.join(root, 'missing-template.md');
  const templatePath = path.join(wiki, 'en/08. Templates/08-01. Inbox/08-01-02. Human/08-01-02-02. Agent Session Raw Template.md');
  await rm(templatePath, { force: true });
  await symlink(missingExternal, templatePath);

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'capture',
      '--title',
      'Blocked broken template capture',
      '--body',
      'This template must not be ignored as a missing file.',
    ], { env }),
    /Raw template must be a real file/,
  );
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

test('wiki daily refuses symlinked Raw member folders before writing', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-daily-raw-symlink-', 'en');
  const external = path.join(root, 'external-daily');
  const dailyRoot = path.join(wiki, 'en/01. Inbox/01-01. Raw/01-01-02. Daily Reports');
  const memberFolder = path.join(dailyRoot, 'Alex');
  await mkdir(external, { recursive: true });
  await symlink(external, memberFolder, 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [
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
      'This must not be written outside the wiki.',
    ], { env }),
    /Daily report member folder must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('wiki daily refuses symlinked intermediate member ancestors before mkdir', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-daily-member-ancestor-symlink-', 'en');
  const dailyRoot = path.join(wiki, 'en/01. Inbox/01-01. Raw/01-01-02. Daily Reports');
  const external = path.join(root, 'external-daily-ancestor');
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(dailyRoot, 'linked'), 'dir');
  await updateWikiContract(wiki, (contract) => {
    contract.raw.types.daily_report.naming.memberFolderPattern = 'linked/{author}';
    return contract;
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
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
      'Recursive mkdir must not create folders outside the wiki.',
    ], { env }),
    /Daily report member folder ancestor must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('wiki daily refuses contract member folder traversal patterns', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-daily-member-traversal-', 'en');
  await updateWikiContract(wiki, (contract) => {
    contract.raw.types.daily_report.naming.memberFolderPattern = '../outside/{author}';
    return contract;
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
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
      'Traversal pattern must not be accepted.',
    ], { env }),
    /memberFolderPattern must be a safe relative pattern/,
  );
});

test('wiki daily refuses contract report file traversal patterns', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-daily-file-traversal-', 'en');
  await updateWikiContract(wiki, (contract) => {
    contract.raw.types.daily_report.naming.reportFilePattern = '../outside.md';
    return contract;
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
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
      'Traversal file pattern must not be accepted.',
    ], { env }),
    /reportFilePattern must be a safe relative pattern/,
  );
});

test('wiki daily dry-run refuses symlinked Raw type folders before listing members', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-daily-dry-raw-symlink-', 'en');
  const dailyRoot = path.join(wiki, 'en/01. Inbox/01-01. Raw/01-01-02. Daily Reports');
  const external = path.join(root, 'external-daily-root');
  await rm(dailyRoot, { recursive: true, force: true });
  await mkdir(external, { recursive: true });
  await symlink(external, dailyRoot, 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [
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
      'Dry-run must not inspect external daily folders.',
      '--dry-run',
    ], { env }),
    /Raw type folder must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
});

test('wiki daily refuses symlinked existing daily report files before reading', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-daily-note-symlink-', 'en');
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
  const created = JSON.parse((await execFileAsync(process.execPath, [
    ...args,
    '--body',
    '- Initial work',
    '--json',
  ], { env })).stdout);
  const external = path.join(root, 'external-daily-note.md');
  await writeFile(external, '# External Daily\n\nDo not read this external note.\n');
  await rm(created.path, { force: true });
  await symlink(external, created.path);

  await assert.rejects(
    execFileAsync(process.execPath, [
      ...args,
      '--body',
      '- Follow-up work',
    ], { env }),
    /Daily report note must be a real file/,
  );
  assert.equal(await readFile(external, 'utf8'), '# External Daily\n\nDo not read this external note.\n');
  await assert.rejects(readFile(path.join(wiki, '.omw', 'external-daily-note.md'), 'utf8'));
});

test('wiki daily refuses broken symlinked report files before replacing them', async () => {
  const { root, env } = await setupIsolatedWiki('omw-daily-broken-note-symlink-', 'en');
  const dryRun = JSON.parse((await execFileAsync(process.execPath, [
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
    '- Planned work',
    '--dry-run',
    '--json',
  ], { env })).stdout);
  const external = path.join(root, 'missing-daily-note.md');
  await mkdir(path.dirname(dryRun.path), { recursive: true });
  await symlink(external, dryRun.path);

  await assert.rejects(
    execFileAsync(process.execPath, [
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
      '- Follow-up work',
    ], { env }),
    /Daily report note must be a real file/,
  );
  await assert.rejects(readFile(external, 'utf8'));
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

  const validation = await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env });
  assert.match(validation.stdout, /OK: base wiki validation passed/);
});

test('base wiki reports accept spaced language options and localize headings', async () => {
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

  await assert.rejects(readFile(path.join(english.wiki, 'scripts/report-raw-ingest'), 'utf8'), { code: 'ENOENT' });

  const englishRaw = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-raw-ingest', '--language', 'en'], { env: english.env });
  assert.match(englishRaw.stdout, /# Raw Ingest Report/);
  assert.match(englishRaw.stdout, /\| State \| Target \| Processed at \| Note \|/);
  assert.match(englishRaw.stdout, /captured: 2/);

  const englishDaily = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-daily', '--language', 'en'], { env: english.env });
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
  const koreanDaily = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-daily', '--language=ko'], { env: korean.env });
  assert.match(koreanDaily.stdout, /# 일간 리포트 요약/);
  assert.match(koreanDaily.stdout, /\| 보고일 \| 작성자 \| 팀 \| ingest상태 \| 관련프로젝트 \| 노트 \|/);
});

test('base wiki reports refuse symlinked report roots before reading external notes', async () => {
  const rawFixture = await setupIsolatedWiki('omw-base-report-raw-symlink-', 'en');
  const rawRoot = path.join(rawFixture.wiki, 'en', '01. Inbox', '01-01. Raw');
  const externalRaw = path.join(rawFixture.root, 'external-raw-root');
  await mkdir(externalRaw, { recursive: true });
  await writeFile(path.join(externalRaw, 'external.md'), '# External Raw\n\nexternal-base-raw-needle\n');
  await rm(rawRoot, { recursive: true, force: true });
  await symlink(externalRaw, rawRoot, 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'report-raw-ingest', '--language', 'en'], { env: rawFixture.env }),
    /Raw root must be a real directory/,
  );

  const dailyFixture = await setupIsolatedWiki('omw-base-report-daily-symlink-', 'en');
  const dailyRoot = path.join(dailyFixture.wiki, 'en', '01. Inbox', '01-01. Raw', '01-01-02. Daily Reports');
  const externalDaily = path.join(dailyFixture.root, 'external-daily-root');
  await mkdir(externalDaily, { recursive: true });
  await writeFile(path.join(externalDaily, 'external.md'), '# External Daily\n\nexternal-base-daily-needle\n');
  await rm(dailyRoot, { recursive: true, force: true });
  await symlink(externalDaily, dailyRoot, 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'report-daily', '--language', 'en'], { env: dailyFixture.env }),
    /Daily report root must be a real directory/,
  );
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

  const summary = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-daily', '--language=en', '--author=Alex=Lead'], { env });
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
  assert(['sqlite', 'scan'].includes(englishSearch.backend));
  assert.deepEqual(englishSearch.filters, { type: '', status: '', path: '' });
  if (englishSearch.results[0].rankSignals) {
    assert.equal(englishSearch.results[0].rankSignals.paraSection, '06. Resources');
    assert.equal(englishSearch.results[0].rankSignals.maturity, 'stable');
  }

  const filteredResult = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'search',
    'Knowledge Map',
    '--backend',
    'scan',
    '--type',
    'Map',
    '--status',
    'active',
    '--path',
    '06-02',
    '--sort',
    'path',
    '--json',
  ], { env: english.env });
  const filteredSearch = JSON.parse(filteredResult.stdout);
  assert.equal(filteredSearch.total, 1);
  assert.equal(filteredSearch.unfilteredTotal >= filteredSearch.total, true);
  assert.equal(filteredSearch.sort, 'path');
  assert.equal(filteredSearch.results[0].relativePath, 'en/06. Resources/06-02. Maps/06-02-01. Knowledge Map.md');

  const textSearch = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'search',
    'Knowledge Map',
    '--backend',
    'scan',
    '--type',
    'Map',
  ], { env: english.env });
  assert.match(textSearch.stdout, /- backend: scan/);
  assert.match(textSearch.stdout, /- filters: type=Map/);

  const indexRefresh = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'refresh',
    '--target',
    'index',
    '--json',
  ], { env: english.env })).stdout);
  assert.equal(indexRefresh.ok, true);
  if (indexRefresh.index.backend === 'sqlite') {
    assert.equal(indexRefresh.index.created, false);
    assert.equal(indexRefresh.index.indexedFiles > 0, true);
    assert.equal(indexRefresh.index.scannedFiles, indexRefresh.index.indexedFiles);
    assert.equal(indexRefresh.index.deletedFiles, 0);
    assert.equal(indexRefresh.index.changedFiles >= 0, true);
    assert.equal(indexRefresh.index.unchangedFiles >= 0, true);
  } else {
    assert.equal(indexRefresh.index.backend, 'scan');
    assert.equal(indexRefresh.index.skipped, true);
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

test('wiki search and validation refuse symlinked search roots before reading', async () => {
  const { root, wiki, env } = await setupIsolatedWiki('omw-search-root-symlink-', 'en');
  const external = path.join(root, 'external-search-root');
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, 'external.md'), '# External Secret\n\noutside-only-needle\n');
  await symlink(external, path.join(wiki, 'linked-search-root'), 'dir');
  const contractPath = path.join(wiki, '.omw/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.source.profile = 'generic-markdown';
  contract.search.root = 'linked-search-root';
  contract.search.excludeDirs = [];
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'status', '--json'], { env });
      } catch (error) {
        const status = JSON.parse(error.stdout);
        assert.equal(status.search.rootExists, false);
        assert(status.issues.some((issue) => /Search root must be a real directory/.test(issue)));
        throw error;
      }
    },
    /Command failed/,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'outside-only-needle', '--backend', 'scan'], { env }),
    /Search root must be a real directory/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'refresh', '--target', 'index'], { env }),
    /Search root must be a real directory/,
  );
  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env });
      } catch (error) {
        assert.match(error.stdout, /Search root must be a real directory/);
        throw error;
      }
    },
    /Command failed/,
  );
});

test('wiki search refuses missing contract search roots instead of falling back to the whole wiki', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-search-missing-root-', 'en');
  await writeFile(path.join(wiki, 'en/03. Permanent Notes/searchable.md'), '# Searchable Outside Root\n\nmissing-root-needle\n');
  await updateWikiContract(wiki, (contract) => {
    contract.search.root = 'missing-search-root';
    return contract;
  });

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'missing-root-needle', '--backend', 'scan', '--json'], { env }),
    /wiki search root does not exist/,
  );
});

test('wiki search refuses broken symlinked contract search roots', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-search-broken-root-', 'en');
  const external = path.join(root, 'missing-search-root');
  await symlink(external, path.join(wiki, 'linked-search-root'), 'dir');
  await updateWikiContract(wiki, (contract) => {
    contract.search.root = 'linked-search-root';
    return contract;
  });

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--backend', 'scan', '--json'], { env }),
    /Search root must be a real directory/,
  );
  await assert.rejects(readdir(external));
});

test('wiki validate reports unsafe contract raw roots and rule notes', async () => {
  const rawFixture = await setupIsolatedWiki('omw-validate-raw-root-symlink-', 'en');
  const rawRoot = path.join(rawFixture.wiki, 'en', '01. Inbox', '01-01. Raw');
  const externalRaw = path.join(rawFixture.root, 'external-raw-root');
  for (const folder of [
    '01-01-01. Web Clipper',
    '01-01-02. Daily Reports',
    '01-01-03. Agent Sessions',
    '01-01-04. Discussions',
  ]) {
    await mkdir(path.join(externalRaw, folder), { recursive: true });
  }
  await rm(rawRoot, { recursive: true, force: true });
  await symlink(externalRaw, rawRoot, 'dir');
  const rawContractPath = path.join(rawFixture.wiki, '.omw/contract.json');
  const rawContract = JSON.parse(await readFile(rawContractPath, 'utf8'));
  rawContract.source.profile = 'generic-markdown';
  await writeFile(rawContractPath, `${JSON.stringify(rawContract, null, 2)}\n`);

  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env: rawFixture.env });
      } catch (error) {
        assert.match(error.stdout, /Raw root must be a real directory/);
        throw error;
      }
    },
    /Command failed/,
  );

  const ruleFixture = await setupIsolatedWiki('omw-validate-rule-symlink-', 'en');
  const ruleContractPath = path.join(ruleFixture.wiki, '.omw/contract.json');
  const ruleContract = JSON.parse(await readFile(ruleContractPath, 'utf8'));
  ruleContract.source.profile = 'generic-markdown';
  await writeFile(ruleContractPath, `${JSON.stringify(ruleContract, null, 2)}\n`);
  const externalRule = path.join(ruleFixture.root, 'external-rule.md');
  const rulePath = path.join(ruleFixture.wiki, 'en/06. Resources/06-01. Guides/06-01-02. Note Writing Rules.md');
  await writeFile(externalRule, '# External Rule\n\nDo not read this rule through validate.\n');
  await rm(rulePath, { force: true });
  await symlink(externalRule, rulePath);

  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env: ruleFixture.env });
      } catch (error) {
        assert.match(error.stdout, /Wiki rule note must be a real file/);
        throw error;
      }
    },
    /Command failed/,
  );
});

test('wiki contract explain summarizes contract shape and schema is valid JSON', async () => {
  const { env } = await setupIsolatedWiki('omw-contract-explain-', 'en');
  const explained = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'contract',
    '--explain',
    '--json',
  ], { env })).stdout);
  assert.equal(explained.ok, true);
  assert.equal(explained.schemaVersion, 2);
  assert.equal(explained.language, 'en');
  assert.equal(explained.search.root, 'en');
  assert(explained.raw.types.some((type) => type.key === 'agent_session'));
  assert.equal(explained.understanding.score, 100);
  assert.equal(explained.understanding.complete, true);
  assert.equal(explained.understanding.handoff.recommended, false);

  const valid = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'contract',
    '--validate',
    '--json',
  ], { env })).stdout);
  assert.equal(valid.ok, true);
  assert.equal(valid.validation.ok, true);

  const invalid = await setupIsolatedWiki('omw-contract-invalid-', 'en');
  const contractPath = path.join(invalid.wiki, '.omw/contract.json');
  const invalidContract = JSON.parse(await readFile(contractPath, 'utf8'));
  delete invalidContract.raw.types;
  await writeFile(contractPath, `${JSON.stringify(invalidContract, null, 2)}\n`);
  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'contract', '--validate', '--json'], { env: invalid.env });
      } catch (error) {
        assert.match(error.stdout, /raw\.types is required/);
        throw error;
      }
    },
    /Command failed/,
  );

  invalidContract.raw.types = {};
  invalidContract.raw.root = '../outside';
  invalidContract.raw.types.agent_session = {
    folder: 'sessions',
    agentTemplate: '/tmp/template.md',
  };
  invalidContract.rules = {
    noteWriting: { label: 'Rules', path: '../rules.md' },
  };
  invalidContract.search.root = '../notes';
  invalidContract.ingest.candidateTargets = ['/tmp/promoted.md'];
  await writeFile(contractPath, `${JSON.stringify(invalidContract, null, 2)}\n`);
  await assert.rejects(
    async () => {
      try {
        await execFileAsync(process.execPath, [cliPath, 'wiki', 'contract', '--validate', '--json'], { env: invalid.env });
      } catch (error) {
        assert.match(error.stdout, /raw\.root must be a wiki-relative path/);
        assert.match(error.stdout, /raw\.types\.agent_session\.agentTemplate must be a wiki-relative path/);
        assert.match(error.stdout, /rules\.noteWriting\.path must be a wiki-relative path/);
        assert.match(error.stdout, /search\.root must be a wiki-relative path/);
        assert.match(error.stdout, /ingest\.candidateTargets\[0\] must be a wiki-relative path/);
        throw error;
      }
    },
    /Command failed/,
  );

  const schema = JSON.parse(await readFile('docs/wiki-contract.schema.json', 'utf8'));
  assert.equal(schema.title, 'Oh My Wiki Contract');
  assert(schema.required.includes('raw'));
  assert.equal(schema.properties.understanding.properties.score.maximum, 100);
  assert(schema.properties.search.required.includes('excludeDirs'));
  assert.equal(schema.properties.raw.properties.root.$ref, '#/$defs/wikiRelativePath');
});

test('wiki contract explains partial understanding for unfamiliar personal wikis', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-contract-understanding-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nA personal wiki note.\n');

  await execFileAsync(process.execPath, [cliPath, 'init', '--wiki', wiki, '--json'], { env });
  const explained = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'contract',
    '--explain',
    '--json',
  ], { env })).stdout);

  assert.equal(explained.ok, true);
  assert.equal(explained.profile, 'generic-markdown');
  assert(explained.understanding.score > 0);
  assert(explained.understanding.score < 100);
  assert.equal(explained.understanding.complete, false);
  assert.equal(explained.understanding.handoff.recommended, true);
  assert.equal(explained.understanding.handoff.workflow, 'wiki-deep-interview');
  assert(explained.understanding.missingDimensions.some((item) => item.key === 'rules'));
  assert(explained.understanding.missingDimensions.some((item) => item.key === 'templates'));
  assert.match(explained.understanding.handoff.prompt, /Deep Interview/);

  const contract = JSON.parse(await readFile(path.join(wiki, '.omw/contract.json'), 'utf8'));
  assert.equal(contract.understanding.score, explained.understanding.score);
  assert.equal(contract.understanding.policy, 'conservative-adaptation');
});

test('read-only wiki commands do not mutate connected personal wiki markdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-personal-readonly-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nSearchable personal wiki note.\n');
  await writeFile(path.join(wiki, 'notes/beta.md'), '# Beta\n\nAnother personal note.\n');
  await execFileAsync(process.execPath, [cliPath, 'init', '--wiki', wiki, '--json'], { env });

  const before = await snapshotUserMarkdown(wiki);
  const commands = [
    ['wiki', 'status', '--json'],
    ['wiki', 'contract', '--explain', '--json'],
    ['wiki', 'contract', '--validate', '--json'],
    ['wiki', 'validate', '--json'],
    ['wiki', 'search', 'personal', '--json', '--backend', 'scan'],
    ['wiki', 'refresh', '--target', 'contract', '--dry-run', '--json'],
  ];
  for (const command of commands) {
    await execFileAsync(process.execPath, [cliPath, ...command], { env });
  }
  assert.deepEqual(await snapshotUserMarkdown(wiki), before);
});

test('wiki contract refresh dry-run previews scanner changes without writing', async () => {
  const { wiki, env } = await setupIsolatedWiki('omw-contract-dry-run-', 'en');
  const contractPath = path.join(wiki, '.omw/contract.json');
  const stale = JSON.parse(await readFile(contractPath, 'utf8'));
  stale.search.root = 'stale';
  await writeFile(contractPath, `${JSON.stringify(stale, null, 2)}\n`);
  const staleText = await readFile(contractPath, 'utf8');

  const preview = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'contract',
    '--refresh',
    '--dry-run',
    '--json',
  ], { env })).stdout);
  assert.equal(preview.refresh.dryRun, true);
  assert.equal(preview.refresh.refreshed, false);
  assert.equal(preview.refresh.changed, true);
  assert(preview.refresh.changes.some((change) => change.path === 'search.root' && change.previous === 'stale' && change.next === 'en'));
  assert.equal(await readFile(contractPath, 'utf8'), staleText);

  const refresh = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'refresh',
    '--target',
    'all',
    '--dry-run',
    '--json',
  ], { env })).stdout);
  assert.equal(refresh.dryRun, true);
  assert.equal(refresh.refreshed.contract, false);
  assert.equal(refresh.refreshed.index, false);
  assert.equal(refresh.contract.changed, true);
  assert.equal(refresh.index.dryRun, true);
  assert.equal(await readFile(contractPath, 'utf8'), staleText);
});

test('wiki contract refresh dry-run does not create managed fallback assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-contract-dry-run-assets-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: home };
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes/alpha.md'), '# Alpha\n\nExisting note.\n');
  await execFileAsync(process.execPath, [cliPath, 'init', '--wiki', wiki, '--json'], { env });
  await rm(path.join(wiki, '.omw/raw'), { recursive: true, force: true });
  await rm(path.join(wiki, '.omw/templates'), { recursive: true, force: true });

  const preview = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'contract',
    '--refresh',
    '--dry-run',
    '--json',
  ], { env })).stdout);
  assert.equal(preview.refresh.dryRun, true);
  assert.equal(preview.ok, true);
  assert(preview.issues.some((issue) => issue.includes('wiki raw root does not exist')));
  await assert.rejects(readdir(path.join(wiki, '.omw/raw')));
  await assert.rejects(readdir(path.join(wiki, '.omw/templates')));

  const refresh = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'refresh',
    '--target',
    'all',
    '--dry-run',
    '--json',
  ], { env })).stdout);
  assert.equal(refresh.ok, true);
  assert.equal(refresh.dryRun, true);
  assert(refresh.issues.some((issue) => issue.includes('wiki raw root does not exist')));
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

test('wiki search filters are applied before final limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-search-filter-window-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  for (let index = 0; index < 120; index += 1) {
    await writeFile(path.join(wiki, 'notes', `common-${String(index).padStart(3, '0')}.md`), `# Common ${index}\n\ncommon body\n`);
  }
  await writeFile(path.join(wiki, 'notes', 'zzz-map.md'), [
    '---',
    'type: Map',
    'status: active',
    '---',
    '# Common Filtered Map',
    '',
    'common body',
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

  const filtered = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'search',
    'common',
    '--backend',
    'scan',
    '--type',
    'Map',
    '--limit',
    '1',
    '--json',
  ], { env })).stdout);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.results[0].relativePath, 'notes/zzz-map.md');
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

test('sqlite search refuses symlinked index files before opening the database', async () => {
  const { root, wiki, env } = await setupIsolatedWiki('omw-search-sqlite-symlink-', 'en');
  const external = path.join(root, 'external-index.sqlite');
  await writeFile(external, '');
  await symlink(external, path.join(wiki, '.omw/index.sqlite'));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json', '--backend', 'sqlite'], { env }),
    (error) => {
      const text = `${error.stderr || ''}\n${error.message || ''}`;
      if (/sqlite search backend requires node:sqlite support|Wiki search backend is not available: sqlite/.test(text)) return true;
      return /SQLite index must be a real file/.test(text);
    },
  );
});

test('auto search surfaces symlinked sqlite index safety errors instead of falling back', async () => {
  if (!(await sqliteAvailable())) return;
  const { root, wiki, env } = await setupIsolatedWiki('omw-search-auto-sqlite-symlink-', 'en');
  const external = path.join(root, 'external-auto-index.sqlite');
  await writeFile(external, '');
  await symlink(external, path.join(wiki, '.omw/index.sqlite'));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json'], { env }),
    (error) => {
      const text = `${error.stderr || ''}\n${error.message || ''}`;
      return /SQLite index must be a real file/.test(text);
    },
  );
});

test('auto search refuses broken symlinked sqlite indexes before creating external targets', async () => {
  if (!(await sqliteAvailable())) return;
  const { root, wiki, env } = await setupIsolatedWiki('omw-search-broken-sqlite-symlink-', 'en');
  const external = path.join(root, 'missing-auto-index.sqlite');
  await symlink(external, path.join(wiki, '.omw/index.sqlite'));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'search', 'Knowledge Map', '--json'], { env }),
    (error) => {
      const text = `${error.stderr || ''}\n${error.message || ''}`;
      return /SQLite index must be a real file/.test(text);
    },
  );
  await assert.rejects(readFile(external, 'utf8'));
});

test('wiki refresh index surfaces symlinked sqlite index safety errors', async () => {
  if (!(await sqliteAvailable())) return;
  const { root, wiki, env } = await setupIsolatedWiki('omw-refresh-sqlite-symlink-', 'en');
  const external = path.join(root, 'external-refresh-index.sqlite');
  await writeFile(external, '');
  await symlink(external, path.join(wiki, '.omw/index.sqlite'));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'refresh', '--target', 'index', '--json'], { env }),
    (error) => {
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert(report.issues.some((issue) => /SQLite index must be a real file/.test(issue)));
      return true;
    },
  );
});

test('sqlite search notices new markdown in a previously empty scanned directory within recent-sync TTL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-sqlite-fresh-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'notes', 'empty'), { recursive: true });
  await writeFile(path.join(wiki, 'notes', 'existing.md'), '# Existing\n\ninitial searchable note\n');
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
  ], { env: { ...process.env, OH_MY_WIKI_HOME: home } });

  const { searchWiki } = await import('../src/wiki/search.mjs');
  const config = { wikiPath: wiki, wikiLanguage: 'en' };
  const before = await searchWiki({ config, query: 'freshneedle', backend: 'sqlite', limit: 5 });
  assert.equal(before.total, 0);

  await writeFile(path.join(wiki, 'notes', 'empty', 'fresh.md'), '# Fresh\n\nfreshneedle appears inside a formerly empty directory.\n');
  const after = await searchWiki({ config, query: 'freshneedle', backend: 'sqlite', limit: 5 });
  assert.equal(after.total, 1);
  assert.equal(after.results[0].relativePath, 'notes/empty/fresh.md');
});

test('sqlite CLI search exits promptly after installing recent-sync watchers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-sqlite-watch-exit-'));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await mkdir(path.join(wiki, 'notes'), { recursive: true });
  await writeFile(path.join(wiki, 'notes', 'existing.md'), '# Existing\n\nprompt exit searchable note\n');
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

  const search = await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'search',
    'searchable',
    '--backend',
    'sqlite',
    '--json',
  ], { env, timeout: 3500 }).catch((error) => {
    if (/sqlite search backend requires node:sqlite support|Wiki search backend is not available: sqlite/.test(error.stderr || error.message)) return null;
    throw error;
  });
  if (!search) return;

  const result = JSON.parse(search.stdout);
  assert.equal(result.total, 1);
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
  assert.equal(updated.rules.rawOperation.path, 'en/06. Resources/06-01. Guides/06-01-05. Raw Note Operating Rules.md');
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

  const rawReport = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-raw-ingest'], { env });
  assert.match(rawReport.stdout, /# Raw Ingest Report/);
  assert.match(rawReport.stdout, /new: 1/);
  assert.match(rawReport.stdout, /knowledge\/raw\/sessions\//);

  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'daily',
    '--author',
    'Dana',
    '--team',
    'Platform',
    '--date',
    '2026-05-18',
    '--body',
    '- Custom wiki daily report.',
  ], { env });
  const dailyReport = await execFileAsync(process.execPath, [cliPath, 'wiki', 'report-daily', '--date', '2026-05-18'], { env });
  assert.match(dailyReport.stdout, /# Daily Report Summary/);
  assert.match(dailyReport.stdout, /\| 2026-05-18 \| Dana \| Platform \| new \|/);

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

test('wiki ingest promotes to an explicit durable target and updates raw state', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-promote-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Promotable Source',
    '--body',
    'Promotable raw body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;

  const promoted = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'ingest',
    rawRef,
    '--promote',
    '--target',
    'en/03. Permanent Notes/03-promoted-source.md',
    '--json',
  ], { env })).stdout);
  assert.equal(promoted.promotion.writePerformed, true);
  assert.equal(promoted.promotion.relativePath, 'en/03. Permanent Notes/03-promoted-source.md');
  assert.equal(promoted.promotion.rawStateUpdated, true);
  assert.equal(promoted.promotion.template, 'base-wiki-permanent-note');

  const note = await readFile(path.join(wiki, promoted.promotion.relativePath), 'utf8');
  assert.match(note, /sourceRaw:/);
  assert.match(note, /type: Permanent Note/);
  assert.match(note, /documentationLens: promoted-note/);
  assert.match(note, /parentHub: \[\[06-02-01\. Knowledge Map\]\]/);
  assert.match(note, /Promotable raw body/);
  const raw = await readFile(path.join(wiki, rawRef), 'utf8');
  assert.match(raw, /ingestState: promoted/);
  const afterQueue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(afterQueue.total, 0);

  const validation = await execFileAsync(process.execPath, [cliPath, 'wiki', 'validate'], { env });
  assert.match(validation.stdout, /OK: base wiki validation passed/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'ingest',
      rawRef,
      '--promote',
      '--target',
      'en/03. Permanent Notes/03-promoted-source.md',
    ], { env }),
    /Use --overwrite-promote/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'ingest',
      rawRef,
      '--promote',
      '--target',
      '../outside.md',
    ], { env }),
    /must stay inside the wiki/,
  );
});

test('wiki ingest refuses promotion through symlinked parent directories before mkdir', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-ingest-promote-parent-symlink-', 'en');
  const external = path.join(root, 'external-promote-parent');
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(wiki, 'linked-promotions'), 'dir');

  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Parent Symlink Source',
    '--body',
    'Parent symlink raw body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'wiki',
      'ingest',
      rawRef,
      '--promote',
      '--target',
      'linked-promotions/nested/promoted.md',
      '--json',
    ], { env }),
    /promotion target directory ancestor must be a real directory/,
  );
  assert.equal((await readdir(external)).length, 0);
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

test('wiki queue refuses symlinked Raw roots before listing external notes', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-queue-raw-root-symlink-', 'en');
  const rawRoot = path.join(wiki, 'en', '01. Inbox', '01-01. Raw');
  const external = path.join(root, 'external-raw-root');
  const externalSession = path.join(external, '01-01-03. Agent Sessions');
  for (const folder of [
    '01-01-01. Web Clipper',
    '01-01-02. Daily Reports',
    '01-01-03. Agent Sessions',
    '01-01-04. Discussions',
  ]) {
    await mkdir(path.join(external, folder), { recursive: true });
  }
  await writeFile(path.join(externalSession, 'external.md'), [
    '---',
    'type: Raw',
    'status: captured',
    '---',
    '',
    '# External Queue Source',
    '',
    'external-queue-only-needle',
    '',
  ].join('\n'));
  await rm(rawRoot, { recursive: true, force: true });
  await symlink(external, rawRoot, 'dir');

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env }),
    /Raw root must be a real directory/i,
  );
});

test('wiki ingest refuses symlinked rule notes before reading summaries', async () => {
  const { env, wiki } = await setupIsolatedWiki('omw-ingest-rule-symlink-', 'en');
  await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Rule Symlink Source',
    '--body',
    'Rule symlink raw body.',
  ], { env });
  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  const rawRef = queue.items[0].relativePath;
  const external = path.join(path.dirname(wiki), 'external-rule.md');
  const rulePath = path.join(wiki, 'en/06. Resources/06-01. Guides/06-01-02. Note Writing Rules.md');
  await writeFile(external, '# External Rule\n\nThis rule must not be read through a symlink.\n');
  await rm(rulePath, { force: true });
  await symlink(external, rulePath);

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'wiki', 'ingest', rawRef, '--json'], { env }),
    /Wiki rule note must be a real file/,
  );
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

test('hook auto capture records best-effort capture failures in event logs', async () => {
  const { env, home } = await setupIsolatedWiki('omw-hook-failure-', 'en', { wikiAutoCapture: true });
  const configPath = path.join(home, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.wikiPath = path.join(path.dirname(config.wikiPath), 'missing-wiki');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  await execFileWithInput(process.execPath, [cliPath, 'hook', 'Stop'], {
    env,
    input: JSON.stringify({ cwd: '/tmp/workspace-beta', transcript_path: '/tmp/transcript.jsonl' }),
  });

  const eventFiles = (await readdir(path.join(home, 'events'))).filter((name) => name.endsWith('-Stop.json'));
  assert.equal(eventFiles.length, 1);
  const event = JSON.parse(await readFile(path.join(home, 'events', eventFiles[0]), 'utf8'));
  assert.equal(event.capture.attempted, true);
  assert.equal(event.capture.ok, false);
  assert.match(event.capture.error, /Wiki is not ready|wikiPath does not exist/);
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
