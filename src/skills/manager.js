import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';

const OWNER = 'oh-my-wiki';
const MARKER_FILE = '.omw-managed-skill.json';
const PLATFORM_CONFIG = {
  codex: {
    envHome: 'CODEX_HOME',
    defaultHome: '.codex',
    targetSubdir: 'skills',
  },
  claude: {
    envHome: 'CLAUDE_HOME',
    defaultHome: '.claude',
    targetSubdir: 'skills',
  },
};

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export function defaultCodexHome(input) {
  return defaultPlatformHome('codex', input);
}

export async function listSkills({ platform = 'codex' } = {}) {
  const root = skillsRoot(platform);
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(root, entry.name);
    const skillFile = path.join(skillPath, 'SKILL.md');
    if (!(await pathExists(skillFile))) {
      continue;
    }
    const metadata = parseSkillMetadata(await readFile(skillFile, 'utf8'));
    skills.push({
      name: metadata.name || entry.name,
      directory: entry.name,
      description: metadata.description || '',
      sourcePath: skillPath,
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function installSkills({ platform = 'codex', codexHome, claudeHome, platformHome, name } = {}) {
  assertPlatform(platform);
  const available = await listSkills({ platform });
  const selected = filterSkills(available, name);
  const targetRoot = targetSkillsRoot({ platform, codexHome, claudeHome, platformHome });
  await mkdir(targetRoot, { recursive: true });

  const installed = [];
  for (const skill of selected) {
    const targetPath = path.join(targetRoot, skill.directory);
    const marker = await readMarker(targetPath);
    if ((await pathExists(targetPath)) && marker?.owner !== OWNER) {
      throw new Error(`Refusing to overwrite unmanaged skill: ${targetPath}`);
    }
    await rm(targetPath, { recursive: true, force: true });
    await cp(skill.sourcePath, targetPath, { recursive: true });
    await writeMarker(targetPath, { platform, skill });
    installed.push({
      name: skill.name,
      directory: skill.directory,
      targetPath,
    });
  }

  return {
    platform,
    targetRoot,
    installed,
  };
}

export async function uninstallSkills({ platform = 'codex', codexHome, claudeHome, platformHome, name } = {}) {
  assertPlatform(platform);
  const targetRoot = targetSkillsRoot({ platform, codexHome, claudeHome, platformHome });
  const available = await listSkills({ platform });
  const installedManaged = await listInstalledManagedSkills(targetRoot);
  const selected = filterSkillsForRemoval(available, installedManaged, name);
  const removed = [];
  const skipped = [];

  for (const skill of selected) {
    const targetPath = path.join(targetRoot, skill.directory);
    const marker = await readMarker(targetPath);
    if (marker?.owner !== OWNER) {
      skipped.push({
        name: skill.name,
        directory: skill.directory,
        reason: 'not managed by OMW',
      });
      continue;
    }
    await rm(targetPath, { recursive: true, force: true });
    removed.push({
      name: skill.name,
      directory: skill.directory,
      targetPath,
    });
  }

  return {
    platform,
    targetRoot,
    removed,
    skipped,
  };
}

export async function skillStatus({ platform = 'codex', codexHome, claudeHome, platformHome } = {}) {
  assertPlatform(platform);
  const available = await listSkills({ platform });
  const targetRoot = targetSkillsRoot({ platform, codexHome, claudeHome, platformHome });
  const skills = [];

  for (const skill of available) {
    const targetPath = path.join(targetRoot, skill.directory);
    const marker = await readMarker(targetPath);
    skills.push({
      name: skill.name,
      directory: skill.directory,
      description: skill.description,
      installed: Boolean(marker?.owner === OWNER),
      targetPath,
      installedAt: marker?.installedAt || null,
    });
  }

  return {
    platform,
    targetRoot,
    skills,
  };
}

function skillsRoot(platform) {
  assertPlatform(platform);
  return path.join(repoRoot(), 'skills', platform);
}

function targetSkillsRoot({ platform, codexHome, claudeHome, platformHome }) {
  assertPlatform(platform);
  const config = PLATFORM_CONFIG[platform];
  return path.join(defaultPlatformHome(platform, platformHome || homeForPlatform({ platform, codexHome, claudeHome })), config.targetSubdir);
}

function assertPlatform(platform) {
  if (!PLATFORM_CONFIG[platform]) {
    throw new Error(`Unsupported skill platform: ${platform}`);
  }
}

function defaultPlatformHome(platform, explicitHome) {
  const config = PLATFORM_CONFIG[platform];
  return explicitHome || process.env[config.envHome] || path.join(process.env.HOME || '', config.defaultHome);
}

function homeForPlatform({ platform, codexHome, claudeHome }) {
  if (platform === 'codex') {
    return codexHome;
  }
  if (platform === 'claude') {
    return claudeHome;
  }
  return null;
}

function filterSkills(skills, name) {
  if (!name || name === 'all') {
    return skills;
  }
  const selected = skills.filter((skill) => skill.name === name || skill.directory === name);
  if (selected.length === 0) {
    throw new Error(`Unknown OMW skill: ${name}`);
  }
  return selected;
}

function filterSkillsForRemoval(available, installedManaged, name) {
  const skillsByDirectory = new Map();
  for (const skill of [...available, ...installedManaged]) {
    skillsByDirectory.set(skill.directory, skill);
  }
  const skills = [...skillsByDirectory.values()];
  return filterSkills(skills, name);
}

async function listInstalledManagedSkills(targetRoot) {
  if (!(await pathExists(targetRoot))) {
    return [];
  }

  const entries = await readdir(targetRoot, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const targetPath = path.join(targetRoot, entry.name);
    const marker = await readMarker(targetPath);
    if (marker?.owner !== OWNER) {
      continue;
    }
    skills.push({
      name: marker.name || entry.name,
      directory: marker.directory || entry.name,
      description: '',
      sourcePath: marker.sourcePath || null,
    });
  }
  return skills;
}

function parseSkillMetadata(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) {
      continue;
    }
    metadata[item[1]] = item[2].replace(/^["']|["']$/g, '');
  }
  return metadata;
}

async function writeMarker(targetPath, { platform, skill }) {
  await writeJsonFile(path.join(targetPath, MARKER_FILE), {
    owner: OWNER,
    platform,
    name: skill.name,
    directory: skill.directory,
    sourcePath: skill.sourcePath,
    installedAt: new Date().toISOString(),
  });
}

async function readMarker(targetPath) {
  return readJsonFile(path.join(targetPath, MARKER_FILE), null);
}
