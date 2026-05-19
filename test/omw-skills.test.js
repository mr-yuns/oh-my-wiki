import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

test('managed wiki skill prompts target the configured wiki, not only the base wiki', async () => {
  for (const platform of ['codex', 'claude']) {
    const root = path.join('skills', platform);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(root, entry.name, 'SKILL.md');
      const content = await readFile(skillPath, 'utf8');
      assert.doesNotMatch(content, /configured base wiki/i, `${skillPath} must not steer agents toward only the bundled base wiki`);
      assert.match(content, /configured wiki|wiki knowledge|Raw note|contract/i, `${skillPath} should describe a connected-wiki-safe workflow`);
    }
  }
});

test('structure-dependent managed skills gate workflows on contract understanding', async () => {
  const writeSkillNames = ['wiki-autopilot', 'wiki-capture', 'wiki-daily-report', 'wiki-ingest'];
  for (const platform of ['codex', 'claude']) {
    for (const name of writeSkillNames) {
      const skillPath = path.join('skills', platform, name, 'SKILL.md');
      const content = await readFile(skillPath, 'utf8');
      assert.match(content, /omw wiki contract --explain --json/, `${skillPath} must inspect the active contract before writes`);
      assert.match(content, /understanding\.score/, `${skillPath} must check contract understanding score`);
      assert.match(content, /wiki-deep-interview/, `${skillPath} must route unfamiliar wikis through Deep Interview handoff`);
      assert.match(content, /before (?:.*writes?|writing)/i, `${skillPath} must state the write boundary`);
    }
  }
});

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
