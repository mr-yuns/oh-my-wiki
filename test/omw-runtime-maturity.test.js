import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRawNoteSafety } from '../src/wiki/validation.mjs';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

const fakeSecrets = {
  openaiKey: ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-'),
  anthropicKey: ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-'),
  npmToken: ['npm', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_'),
  slackBotToken: ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
  slackAppToken: ['xapp', '1', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-'),
  awsAccessKey: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  slackWebhook: ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'abcdefghijklmnopqrstuvwxyz'].join('/'),
};

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

async function setupIsolatedWiki(prefix, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'state');
  const wiki = path.join(root, 'wiki');
  await cp(path.resolve('.wiki'), wiki, { recursive: true });
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    options.language || 'en',
    '--no-hooks',
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
    ...(options.wikiAutoCapture ? ['--wiki-auto-capture'] : []),
  ], {
    env: { ...process.env, OH_MY_WIKI_HOME: home },
  });
  return { root, home, wiki, codexHome, claudeHome, env: { ...process.env, OH_MY_WIKI_HOME: home } };
}

test('Stop hook captures a bounded redacted transcript tail', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-transcript-tail-', { wikiAutoCapture: true });
  const transcriptPath = path.join(root, 'transcript.jsonl');
  const earlyLine = JSON.stringify({ role: 'user', content: 'EARLY_TRANSCRIPT_SHOULD_NOT_APPEAR' });
  const filler = `${'x'.repeat(300 * 1024)}\n`;
  const lateLine = JSON.stringify({
    role: 'assistant',
    content: [
      'Durable late insight for the wiki',
      `OPENAI_API_KEY=${fakeSecrets.openaiKey}`,
      `AWS_ACCESS_KEY_ID=${fakeSecrets.awsAccessKey}`,
      'Cookie: session=secret-cookie-value',
      fakeSecrets.slackWebhook,
    ].join('\n'),
  });
  await writeFile(transcriptPath, `${earlyLine}\n${filler}${lateLine}\n`);

  await execFileWithInput(process.execPath, [cliPath, 'hook', 'Stop'], {
    env,
    input: JSON.stringify({
      cwd: path.join(wiki, 'workspace-alpha'),
      session_id: 'session-secret-123',
      transcript_path: transcriptPath,
    }),
  });

  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  const note = await readFile(queue.items[0].path, 'utf8');
  assert.match(note, /Transcript Excerpt/);
  assert.match(note, /Durable late insight for the wiki/);
  assert.doesNotMatch(note, /EARLY_TRANSCRIPT_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(note, /sk-proj-|AKIAIOSFODNN7EXAMPLE|secret-cookie-value|hooks\.slack\.com/);
  assert.doesNotMatch(note, new RegExp(escapeRegExp(transcriptPath)));
  assertRawNoteSafety(note, 'captured transcript note');
});

test('Claude Stop hook captures redacted transcript excerpts without blocking', async () => {
  const { root, env, wiki } = await setupIsolatedWiki('omw-claude-transcript-', { wikiAutoCapture: true });
  const transcriptPath = path.join(root, 'claude-transcript.jsonl');
  await writeFile(transcriptPath, `${JSON.stringify({
    type: 'message',
    message: { content: `Claude durable point with npm token ${fakeSecrets.npmToken}` },
  })}\n`);

  await execFileWithInput(process.execPath, [cliPath, 'claude-hook', 'Stop'], {
    env,
    input: JSON.stringify({ cwd: path.join(wiki, 'workspace-beta'), transcriptPath }),
  });

  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  const note = await readFile(queue.items[0].path, 'utf8');
  assert.match(note, /captureChannel: claude-code/);
  assert.match(note, /Claude durable point/);
  assert.doesNotMatch(note, /npm_abcdefghijklmnopqrstuvwxyz/);
  assertRawNoteSafety(note, 'captured claude transcript note');
});

test('Stop hook records transcript read failures without failing the hook', async () => {
  const { env, home, wiki } = await setupIsolatedWiki('omw-transcript-missing-', { wikiAutoCapture: true });
  await execFileWithInput(process.execPath, [cliPath, 'hook', 'Stop'], {
    env,
    input: JSON.stringify({ cwd: path.join(wiki, 'workspace-gamma'), transcript_path: path.join(wiki, 'missing.jsonl') }),
  });

  const queue = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'wiki', 'queue', '--json'], { env })).stdout);
  assert.equal(queue.total, 1);
  const note = await readFile(queue.items[0].path, 'utf8');
  assert.match(note, /transcript-read-failed/);

  const events = await import('node:fs/promises').then((fs) => fs.readdir(path.join(home, 'events')));
  const event = JSON.parse(await readFile(path.join(home, 'events', events.find((name) => name.endsWith('-Stop.json'))), 'utf8'));
  assert.equal(event.transcriptPath, '[present]');
  assert.equal(event.sessionId, null);
  assert.equal(event.capture.ok, true);
  assert.equal(event.capture.transcript.reason, 'transcript-read-failed');
  assert.equal(event.capture.transcript.error, 'ENOENT');
  assert.doesNotMatch(JSON.stringify(event), new RegExp(escapeRegExp(path.join(wiki, 'missing.jsonl'))));
});

test('Raw capture redacts expanded secret formats and validation rejects unredacted fixtures', async () => {
  const { env } = await setupIsolatedWiki('omw-redaction-expanded-');
  const body = [
    `OPENAI_API_KEY=${fakeSecrets.openaiKey}`,
    `ANTHROPIC_API_KEY=${fakeSecrets.anthropicKey}`,
    `NPM_TOKEN=${fakeSecrets.npmToken}`,
    `SLACK_BOT_TOKEN=${fakeSecrets.slackBotToken}`,
    `SLACK_APP_TOKEN=${fakeSecrets.slackAppToken}`,
    `AWS_ACCESS_KEY_ID=${fakeSecrets.awsAccessKey}`,
    'INTERNAL_SECRET="quoted-secret-value"',
    "CLIENT_SECRET='single-quoted-secret-value'",
    'Cookie: session=secret-cookie-value; theme=dark',
    `webhook ${fakeSecrets.slackWebhook}`,
  ].join('\n');
  const result = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'wiki',
    'capture',
    '--title',
    'Expanded secret capture',
    '--body',
    body,
    '--json',
  ], { env })).stdout);
  const note = await readFile(result.path, 'utf8');
  assert.doesNotMatch(note, /sk-proj-|sk-ant-|npm_|xoxb-|xapp-|AKIAIOSFODNN7EXAMPLE|quoted-secret-value|single-quoted-secret-value|secret-cookie-value|hooks\.slack\.com/);
  assert.match(note, /\[REDACTED_OPENAI_KEY\]/);
  assert.match(note, /\[REDACTED_ANTHROPIC_KEY\]/);
  assert.match(note, /\[REDACTED_NPM_TOKEN\]/);
  assert.match(note, /\[REDACTED_SLACK_TOKEN\]/);
  assert.match(note, /\[REDACTED_AWS_ACCESS_KEY\]/);
  assert.match(note, /\[REDACTED_COOKIE\]/);
  assertRawNoteSafety(note, 'expanded redaction note');

  assert.throws(
    () => assertRawNoteSafety(`---
type: Raw
rawType: agent_session
sensitivityCheck: completed
---
${body}
`, 'unsafe fixture'),
    /must not be stored|environment-style secrets/,
  );
});

test('doctor reports hook warnings without changing core readiness', async () => {
  const disabled = await setupIsolatedWiki('omw-doctor-hooks-disabled-');
  const disabledReport = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--json',
    '--codex-home',
    disabled.codexHome,
    '--claude-home',
    disabled.claudeHome,
  ], { env: disabled.env })).stdout);
  assert.equal(disabledReport.ok, true);
  assert.equal(disabledReport.warnings.length, 0);
  assert.equal(disabledReport.hooks.codex.events.Stop.installed, false);

  const enabled = await setupIsolatedWiki('omw-doctor-hooks-enabled-', { wikiAutoCapture: true });
  const enabledDoctor = await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--json',
    '--codex-home',
    enabled.codexHome,
    '--claude-home',
    enabled.claudeHome,
  ], { env: enabled.env });
  const enabledReport = JSON.parse(enabledDoctor.stdout);
  assert.equal(enabledReport.ok, true);
  assert(enabledReport.warnings.some((warning) => warning.includes('Codex Stop hook is not installed')));
  assert(enabledReport.warnings.some((warning) => warning.includes('Claude Stop hook is not installed')));

  const plain = await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--codex-home',
    enabled.codexHome,
    '--claude-home',
    enabled.claudeHome,
  ], { env: enabled.env });
  assert.match(plain.stdout, /Hook warnings:/);
  assert.match(plain.stdout, /OMW core is ready/);
});

test('doctor reports stale hook state-root drift as a warning', async () => {
  const { env, home, codexHome } = await setupIsolatedWiki('omw-doctor-state-root-', { wikiAutoCapture: true });
  await mkdir(codexHome, { recursive: true });
  const cliAbsolutePath = path.resolve(cliPath);
  await writeFile(path.join(codexHome, 'config.toml'), '[features]\ncodex_hooks = true\n');
  await writeFile(path.join(codexHome, 'hooks.json'), `${JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `OH_MY_WIKI_HOME="/tmp/stale-omw-state" node "${cliAbsolutePath}" hook Stop --owner oh-my-wiki`,
            },
          ],
        },
      ],
    },
  }, null, 2)}\n`);

  const report = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--json',
    '--codex-home',
    codexHome,
  ], { env })).stdout);
  assert.equal(report.ok, true);
  assert.equal(report.hooks.codex.events.Stop.installed, true);
  assert.equal(report.hooks.codex.events.Stop.stateRoot, '/tmp/stale-omw-state');
  assert.equal(report.hooks.codex.events.Stop.expectedStateRoot, home);
  assert.equal(report.hooks.codex.events.Stop.stateRootMatches, false);
  assert(report.warnings.some((warning) => warning.includes('stale OMW state root')));
});

test('hook install repairs stale OMW hook entries and state-root drift', async () => {
  const { env, home, codexHome, claudeHome } = await setupIsolatedWiki('omw-hook-repair-', { wikiAutoCapture: true });
  const cliAbsolutePath = path.resolve(cliPath);
  await mkdir(codexHome, { recursive: true });
  await mkdir(claudeHome, { recursive: true });
  await writeFile(path.join(codexHome, 'hooks.json'), `${JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `OH_MY_WIKI_HOME="/tmp/stale-omw-state" node "${cliAbsolutePath}" hook Stop --owner oh-my-wiki`,
            },
          ],
        },
        {
          hooks: [
            {
              type: 'command',
              command: 'OH_MY_WIKI_HOME="/tmp/old" node "/tmp/old/omw.js" hook Stop --owner oh-my-wiki',
            },
          ],
        },
      ],
    },
  }, null, 2)}\n`);
  await writeFile(path.join(claudeHome, 'settings.json'), `${JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `OH_MY_WIKI_HOME="/tmp/stale-omw-state" node "${cliAbsolutePath}" claude-hook Stop --owner oh-my-wiki`,
            },
          ],
        },
        {
          hooks: [
            {
              type: 'command',
              command: 'OH_MY_WIKI_HOME="/tmp/old" node "/tmp/old/omw.js" claude-hook Stop --owner oh-my-wiki',
            },
          ],
        },
      ],
    },
  }, null, 2)}\n`);

  const staleDoctor = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--json',
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
  ], { env })).stdout);
  assert(staleDoctor.warnings.some((warning) => warning.includes('stale OMW-like hook')));
  assert(staleDoctor.warnings.some((warning) => warning.includes('stale OMW state root')));

  const codexInstall = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'codex-hooks',
    'install',
    '--codex-home',
    codexHome,
  ], { env })).stdout);
  const claudeInstall = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'claude-hooks',
    'install',
    '--claude-home',
    claudeHome,
  ], { env })).stdout);
  assert.equal(codexInstall.events.Stop.installed, true);
  assert.equal(codexInstall.events.Stop.omwLikeEntries, 1);
  assert.equal(codexInstall.events.Stop.staleOmwLikeEntries, 0);
  assert.equal(codexInstall.events.Stop.stateRoot, home);
  assert.equal(codexInstall.events.Stop.stateRootMatches, true);
  assert.equal(claudeInstall.events.Stop.installed, true);
  assert.equal(claudeInstall.events.Stop.omwLikeEntries, 1);
  assert.equal(claudeInstall.events.Stop.staleOmwLikeEntries, 0);
  assert.equal(claudeInstall.events.Stop.stateRoot, home);
  assert.equal(claudeInstall.events.Stop.stateRootMatches, true);

  const repairedDoctor = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--json',
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
  ], { env })).stdout);
  assert.equal(repairedDoctor.ok, true);
  assert.equal(repairedDoctor.warnings.some((warning) => warning.includes('stale OMW')), false);
});

test('doctor reports corrupt config JSON and setup can repair it', async () => {
  const { env, home, wiki, codexHome, claudeHome } = await setupIsolatedWiki('omw-corrupt-config-');
  await writeFile(path.join(home, 'config.json'), '{not-json');

  let doctorError;
  try {
    await execFileAsync(process.execPath, [cliPath, 'doctor', '--json', '--codex-home', codexHome, '--claude-home', claudeHome], { env });
  } catch (error) {
    doctorError = error;
  }
  assert(doctorError);
  const report = JSON.parse(doctorError.stdout);
  assert.equal(report.ok, false);
  assert(report.issues.some((issue) => issue.includes('OMW config is not valid JSON')));

  await execFileAsync(process.execPath, [
    cliPath,
    'setup',
    '--wiki',
    wiki,
    '--language',
    'en',
    '--no-hooks',
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--omx-bin',
    'omw-definitely-missing-command',
    '--omc-bin',
    'omw-definitely-missing-command',
  ], { env });
  const repaired = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(repaired.wikiPath, wiki);
});

test('hook status reports corrupt hook JSON and install repairs it', async () => {
  const { env, codexHome, claudeHome } = await setupIsolatedWiki('omw-corrupt-hooks-');
  await writeFile(path.join(codexHome, 'hooks.json'), '{not-json');
  await writeFile(path.join(claudeHome, 'settings.json'), '{not-json');

  const doctor = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'doctor',
    '--json',
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
  ], { env })).stdout);
  assert.equal(doctor.ok, true);
  assert(doctor.warnings.some((warning) => warning.includes('Codex hooks file is not valid JSON')));
  assert(doctor.warnings.some((warning) => warning.includes('Claude settings file is not valid JSON')));

  const codexInstall = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'codex-hooks',
    'install',
    '--codex-home',
    codexHome,
  ], { env })).stdout);
  const claudeInstall = JSON.parse((await execFileAsync(process.execPath, [
    cliPath,
    'claude-hooks',
    'install',
    '--claude-home',
    claudeHome,
  ], { env })).stdout);
  assert.deepEqual(codexInstall.issues, []);
  assert.deepEqual(claudeInstall.issues, []);
  assert.equal(JSON.parse(await readFile(path.join(codexHome, 'hooks.json'), 'utf8')).hooks.Stop.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(claudeHome, 'settings.json'), 'utf8')).hooks.Stop.length, 1);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
