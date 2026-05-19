#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

export const BRANCH_TYPES = [
  'feat',
  'fix',
  'docs',
  'chore',
  'test',
  'refactor',
  'ci',
  'release',
  'hotfix',
];

const COMMIT_SUBJECT_PATTERN = new RegExp(
  `^(${COMMIT_TYPES.join('|')})(\\([a-z0-9][a-z0-9._-]*\\))?!?: .{1,100}$`,
);

const BRANCH_NAME_PATTERN = new RegExp(
  `^(main|develop|dev|release/[0-9]+\\.[0-9]+\\.[0-9]+|(${BRANCH_TYPES.filter((type) => type !== 'release').join('|')})/[a-z0-9]+([._-][a-z0-9]+)*)$`,
);

export function isValidCommitSubject(subject) {
  const value = String(subject || '').trim();
  return value.length <= 100 && COMMIT_SUBJECT_PATTERN.test(value) && !value.endsWith('.');
}

export function isValidBranchName(branchName) {
  return BRANCH_NAME_PATTERN.test(String(branchName || '').trim());
}

export function validateCommitSubjects(subjects) {
  return subjects.filter((subject) => !isValidCommitSubject(subject));
}

function gitLogSubjects(base, head) {
  const output = git(['log', '--format=%s', '--no-merges', `${base}..${head}`]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isZeroSha(value) {
  return !value || /^0+$/.test(value);
}

export function resolvePushBase({ before, refName, defaultBranch, head }) {
  if (!isZeroSha(before)) return before;
  if (refName === defaultBranch) return git(['rev-list', '--max-parents=0', head]).trim();
  git(['fetch', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
  return git(['merge-base', `origin/${defaultBranch}`, head]).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/git-policy.mjs branch <branch-name>',
    '  node scripts/git-policy.mjs subject <commit-subject>',
    '  node scripts/git-policy.mjs commit-range <base-ref> <head-ref>',
    '  node scripts/git-policy.mjs commit-range-for-push <before-sha> <ref-name> <default-branch> <head-ref>',
  ].join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'branch') {
    const branchName = args[0] || '';
    if (!isValidBranchName(branchName)) {
      fail(`Invalid branch name: ${branchName}\nExpected: main, develop, dev, release/x.y.z, or <type>/<slug>. Allowed types: ${BRANCH_TYPES.join(', ')}`);
    }
    process.exit(0);
  }

  if (command === 'subject') {
    const subject = args.join(' ');
    if (!isValidCommitSubject(subject)) {
      fail(`Invalid commit subject: ${subject}\nExpected: <type>(optional-scope)!: message. Allowed types: ${COMMIT_TYPES.join(', ')}`);
    }
    process.exit(0);
  }

  if (command === 'commit-range') {
    const [base, head] = args;
    if (!base || !head) fail('commit-range requires <base-ref> and <head-ref>.');
    const invalid = validateCommitSubjects(gitLogSubjects(base, head));
    if (invalid.length > 0) {
      fail([
        'Invalid commit subjects:',
        ...invalid.map((subject) => `- ${subject}`),
        `Expected: <type>(optional-scope)!: message. Allowed types: ${COMMIT_TYPES.join(', ')}`,
      ].join('\n'));
    }
    process.exit(0);
  }

  if (command === 'commit-range-for-push') {
    const [before, refName, defaultBranch, head] = args;
    if (!refName || !defaultBranch || !head) {
      fail('commit-range-for-push requires <before-sha> <ref-name> <default-branch> <head-ref>.');
    }
    const base = resolvePushBase({ before, refName, defaultBranch, head });
    const invalid = validateCommitSubjects(gitLogSubjects(base, head));
    if (invalid.length > 0) {
      fail([
        'Invalid commit subjects:',
        ...invalid.map((subject) => `- ${subject}`),
        `Expected: <type>(optional-scope)!: message. Allowed types: ${COMMIT_TYPES.join(', ')}`,
      ].join('\n'));
    }
    process.exit(0);
  }

  usage();
  process.exit(command ? 1 : 0);
}
