import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

test('managed skills install, report status, and uninstall for both platforms', async () => {
  for (const platform of ['codex', 'claude']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `omw-skills-${platform}-`));
    const homeFlag = platform === 'codex' ? '--codex-home' : '--claude-home';

    const list = JSON.parse((await execFileAsync(process.execPath, [cliPath, 'skills', 'list', platform])).stdout);
    assert(list.some((skill) => skill.name === 'wiki-search'));

    const install = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      'skills',
      'install',
      platform,
      '--name',
      'wiki-search',
      homeFlag,
      root,
    ])).stdout);
    assert.equal(install.installed.length, 1);
    assert.equal(install.installed[0].name, 'wiki-search');

    const marker = JSON.parse(await readFile(path.join(root, 'skills/wiki-search/.omw-managed-skill.json'), 'utf8'));
    assert.equal(marker.owner, 'oh-my-wiki');
    assert.equal(marker.platform, platform);

    const status = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      'skills',
      'status',
      platform,
      homeFlag,
      root,
    ])).stdout);
    assert.equal(status.skills.find((skill) => skill.name === 'wiki-search')?.installed, true);

    const uninstall = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      'skills',
      'uninstall',
      platform,
      '--name',
      'wiki-search',
      homeFlag,
      root,
    ])).stdout);
    assert.equal(uninstall.removed.length, 1);
  }
});

test('managed skills refuse to overwrite unmanaged user skills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-skills-unmanaged-'));
  const userSkill = path.join(root, 'skills/wiki-search');
  await mkdir(userSkill, { recursive: true });
  await writeFile(path.join(userSkill, 'SKILL.md'), '# User skill\n');

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      'skills',
      'install',
      'codex',
      '--name',
      'wiki-search',
      '--codex-home',
      root,
    ]),
    /Refusing to overwrite unmanaged skill/,
  );

  const content = await readFile(path.join(userSkill, 'SKILL.md'), 'utf8');
  assert.equal(content, '# User skill\n');
});

