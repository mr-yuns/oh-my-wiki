import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp } from 'node:fs/promises';
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

test('documented demo workflow runs against a disposable base wiki', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-demo-'));
  const wiki = path.join(root, 'wiki');
  const env = { ...process.env, OH_MY_WIKI_HOME: path.join(root, 'state') };
  await cp(path.resolve('.wiki'), wiki, { recursive: true });

  const setup = await execFileAsync(process.execPath, [
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
  assert.match(setup.stdout, /OMW is ready/);

  const doctor = await execFileAsync(process.execPath, [cliPath, 'doctor'], { env });
  assert.match(doctor.stdout, /OMW core is ready/);

  const status = await execFileAsync(process.execPath, [cliPath, 'wiki', 'status'], { env });
  assert.match(status.stdout, /OMW Wiki status/);

  const capture = await execFileWithInput(process.execPath, [cliPath, 'capture', '--title', 'Demo session', '--stdin'], {
    env,
    input: 'Captured from the public demo workflow.',
  });
  assert.match(capture.stdout, /Captured Raw note/);

  const daily = await execFileWithInput(process.execPath, [
    cliPath,
    'daily',
    '--author',
    'Alex',
    '--team',
    'Docs',
    '--date',
    '2026-05-18',
    '--stdin',
  ], {
    env,
    input: '- Verified the public demo workflow',
  });
  assert.match(daily.stdout, /daily report Raw/);

  const queue = await execFileAsync(process.execPath, [cliPath, 'queue', '--json'], { env });
  const queued = JSON.parse(queue.stdout);
  assert.equal(queued.total, 2);

  const ingest = await execFileAsync(process.execPath, [cliPath, 'ingest', queued.items[0].relativePath], { env });
  assert.match(ingest.stdout, /Wiki ingest preview/);
  assert.match(ingest.stdout, /write performed: no/);

  const search = await execFileAsync(process.execPath, [cliPath, 'search', 'Knowledge Map'], { env });
  assert.match(search.stdout, /Wiki search: Knowledge Map/);

  const rawReport = await execFileAsync(process.execPath, [cliPath, 'report-raw-ingest'], { env });
  assert.match(rawReport.stdout, /# Raw Ingest Report/);
  assert.match(rawReport.stdout, /captured: 2/);

  const dailyReport = await execFileAsync(process.execPath, [cliPath, 'report-daily', '--date', '2026-05-18'], { env });
  assert.match(dailyReport.stdout, /# Daily Report Summary/);
  assert.match(dailyReport.stdout, /Alex/);

  const validate = await execFileAsync(process.execPath, [cliPath, 'validate'], { env });
  assert.match(validate.stdout, /OK: base wiki validation passed/);
});

