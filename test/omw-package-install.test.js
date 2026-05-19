import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('npm package installs working omw and wiki-agent bins with packaged runtime assets', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'omw-package-install-'));
  try {
    const packDir = path.join(tempRoot, 'pack');
    const installPrefix = path.join(tempRoot, 'install');
    const runCwd = path.join(tempRoot, 'run');
    const home = path.join(tempRoot, 'home');
    const stateHome = path.join(tempRoot, 'state');
    const codexHome = path.join(tempRoot, 'codex');
    const claudeHome = path.join(tempRoot, 'claude');
    const npmCache = path.join(tempRoot, 'npm-cache');
    const wikiPath = path.join(tempRoot, 'wiki');
    await Promise.all([packDir, installPrefix, runCwd, home, stateHome, codexHome, claudeHome, npmCache].map((dir) => mkdir(dir, { recursive: true })));

    const env = {
      ...process.env,
      HOME: home,
      OH_MY_WIKI_HOME: stateHome,
      CODEX_HOME: codexHome,
      CLAUDE_HOME: claudeHome,
      npm_config_cache: npmCache,
    };

    const pack = await execFileAsync('npm', ['pack', '--json', '--pack-destination', packDir], { env });
    const [packed] = JSON.parse(pack.stdout);
    assert(packed, 'npm pack should report a package entry');
    const packedFiles = new Set(packed.files.map((file) => file.path));
    for (const required of requiredPackedFiles()) {
      assert(packedFiles.has(required), `packed artifact should include ${required}`);
    }
    assert(![...packedFiles].some((file) => file.startsWith('.wiki/.omw/')), 'packed artifact should not include base wiki runtime state');
    assert(![...packedFiles].some((file) => file.startsWith('.wiki/scripts/')), 'packed artifact should not include base wiki scripts');
    const tarballPath = path.join(packDir, packed.filename);
    assert(await fileExists(tarballPath), `tarball should exist at ${tarballPath}`);
    const extractDir = path.join(tempRoot, 'extract');
    await mkdir(extractDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir, 'package/package.json'], { env });
    const packagedPackage = JSON.parse(await readFile(path.join(extractDir, 'package', 'package.json'), 'utf8'));
    assert.equal(packagedPackage.bin.omw, 'src/cli/omw.js');
    assert.equal(packagedPackage.bin['wiki-agent'], 'src/cli/omw.js');

    await execFileAsync('npm', ['install', '--prefix', installPrefix, tarballPath], { env, cwd: runCwd });

    const binDir = path.join(installPrefix, 'node_modules', '.bin');
    const omwBin = path.join(binDir, 'omw');
    const wikiAgentBin = path.join(binDir, 'wiki-agent');
    await access(omwBin);
    await access(wikiAgentBin);

    await execFileAsync(omwBin, ['--help'], { env, cwd: runCwd });
    await execFileAsync(wikiAgentBin, ['--help'], { env, cwd: runCwd });

    const init = JSON.parse((await execFileAsync(wikiAgentBin, ['init', '--wiki', wikiPath, '--language', 'en', '--json'], { env, cwd: runCwd })).stdout);
    assert.equal(init.ok, true);
    assert.equal(init.wikiPath, wikiPath);
    assert.equal(init.createdWiki, true);

    const setup = await execFileAsync(omwBin, [
      'setup',
      '--wiki',
      wikiPath,
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
    ], { env, cwd: runCwd });
    assert.match(setup.stdout, /OMW is ready/);

    const doctor = JSON.parse((await execFileAsync(omwBin, ['doctor', '--json', '--codex-home', codexHome, '--claude-home', claudeHome], { env, cwd: runCwd })).stdout);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.config.wikiPath, wikiPath);
    assert.equal(doctor.state.root, stateHome);

    const status = JSON.parse((await execFileAsync(wikiAgentBin, ['wiki', 'status', '--json'], { env, cwd: runCwd })).stdout);
    assert.equal(status.ok, true);
    assert.equal(status.wikiPath, wikiPath);

    const capture = JSON.parse((await execFileAsync(omwBin, ['capture', '--title', 'Installed package session', '--body', 'Packaged install smoke body', '--json'], { env, cwd: runCwd })).stdout);
    assert.equal(capture.ok, true);
    assert(capture.path.startsWith(wikiPath), 'captured note should be written under the temp wiki');

    const search = JSON.parse((await execFileAsync(wikiAgentBin, ['search', 'Knowledge Map', '--backend', 'scan', '--json'], { env, cwd: runCwd })).stdout);
    assert.equal(search.ok, true);
    assert(search.results.some((item) => item.relativePath.includes('Knowledge Map')));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function requiredPackedFiles() {
  return [
    'package.json',
    'src/cli/omw.js',
    'src/commands/init.mjs',
    'src/commands/wiki.mjs',
    'src/wiki/base-tools.mjs',
    'src/wiki/search/scan.mjs',
    '.wiki/README.md',
    'skills/codex/README.md',
    'skills/codex/wiki-search/SKILL.md',
    'skills/claude/wiki-search/SKILL.md',
  ];
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
