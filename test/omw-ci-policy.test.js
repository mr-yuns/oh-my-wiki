import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isValidBranchName,
  isValidCommitSubject,
  validateCommitSubjects,
} from '../scripts/git-policy.mjs';

test('CI docs-only policy includes all public documentation files consistently', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const patterns = [...workflow.matchAll(/docs_only_pattern='([^']+)'/g)].map((match) => match[1]);
  assert.equal(patterns.length, 2);
  assert.equal(new Set(patterns).size, 1);
  for (const entry of ['README\\.md', 'CONTRIBUTING\\.md', 'SECURITY\\.md', 'LICENSE', 'docs/', 'examples/']) {
    assert.ok(patterns[0].includes(entry), `missing docs-only entry: ${entry}`);
  }
});

test('CI commit policy scopes new branch pushes to default-branch merge-base', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /commit-range-for-push/);
});

test('git policy validates only topic commits on new branch pushes after default branch advanced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-git-policy-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await mkdir(root, { recursive: true });
  git(['init', '--bare', remote]);
  git(['clone', remote, work]);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test User'], work);
  git(['checkout', '-b', 'main'], work);
  await writeFixture(path.join(work, 'file.txt'), 'a\n');
  git(['add', 'file.txt'], work);
  git(['commit', '-m', 'Old non conventional root'], work);
  await writeFixture(path.join(work, 'file.txt'), 'b\n');
  git(['commit', '-am', 'docs: establish base'], work);
  git(['push', '-u', 'origin', 'main'], work);

  git(['checkout', '-b', 'fix/topic'], work);
  await writeFixture(path.join(work, 'topic.txt'), 'topic\n');
  git(['add', 'topic.txt'], work);
  git(['commit', '-m', 'fix: topic change'], work);
  const topicHead = git(['rev-parse', 'HEAD'], work).trim();

  git(['checkout', 'main'], work);
  await writeFixture(path.join(work, 'main.txt'), 'main advanced\n');
  git(['add', 'main.txt'], work);
  git(['commit', '-m', 'docs: advance main'], work);
  git(['push', 'origin', 'main'], work);
  git(['checkout', 'fix/topic'], work);

  execFileSync(process.execPath, [
    path.resolve('scripts/git-policy.mjs'),
    'commit-range-for-push',
    '0',
    'fix/topic',
    'main',
    topicHead,
  ], { cwd: work });
});

async function writeFixture(filePath, value) {
  await writeFile(filePath, value);
}

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('git policy validates Conventional Commit subjects', () => {
  for (const subject of [
    'feat: add wiki init command',
    'fix(search): skip sqlite-only test without node:sqlite',
    'ci(release)!: require npm trusted publishing',
    'docs: describe branch naming',
  ]) {
    assert.equal(isValidCommitSubject(subject), true, subject);
  }

  for (const subject of [
    'Add wiki init command',
    'feature: add wiki init command',
    'fix(Search): uppercase scope is rejected',
    'fix: ',
    'fix: reject trailing period.',
    `feat: ${'a'.repeat(100)}`,
  ]) {
    assert.equal(isValidCommitSubject(subject), false, subject);
  }

  assert.deepEqual(validateCommitSubjects(['feat: add x', 'bad commit']), ['bad commit']);
});

test('git policy validates branch names', () => {
  for (const branchName of [
    'main',
    'develop',
    'dev',
    'feat/wiki-init',
    'fix/sqlite-node20',
    'ci/npm-publish',
    'release/0.3.9',
    'hotfix/publish-auth',
  ]) {
    assert.equal(isValidBranchName(branchName), true, branchName);
  }

  for (const branchName of [
    'feature/wiki-init',
    'fix/SQLite',
    'docs/',
    'release/latest',
  ]) {
    assert.equal(isValidBranchName(branchName), false, branchName);
  }
});
