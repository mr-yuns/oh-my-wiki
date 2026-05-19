import path from 'node:path';
import { configPath, ensureStateDirs } from '../runtime/state.js';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';

export const SETUP_COMMAND_HINT = 'omw setup [--wiki <path>] [--language en|ko]';

export async function readConfig() {
  return (await readConfigWithSource()).config;
}

export async function readConfigWithSource() {
  const configuredConfigPath = configPath();
  const configured = await readConfigCandidate(configuredConfigPath);
  if (configured.exists) {
    return {
      config: normalizeConfigPaths(configured.config, configuredConfigPath),
      configPath: configuredConfigPath,
      issues: configured.issues,
    };
  }

  const dirs = await ensureStateDirs();
  const fallback = await readConfigCandidate(dirs.configPath);
  return {
    config: normalizeConfigPaths(fallback.config, dirs.configPath),
    configPath: dirs.configPath,
    issues: fallback.issues,
  };
}

export async function writeConfig(input) {
  const dirs = await ensureStateDirs();
  const wikiPath = input.wikiPath;
  const pythonBin = input.pythonBin;
  const config = {
    schemaVersion: 1,
    sourcePath: input.sourcePath ? path.resolve(input.sourcePath) : input.previousConfig?.sourcePath || null,
    wikiPath: wikiPath ? path.resolve(wikiPath) : input.previousConfig?.wikiPath || null,
    wikiAutoCapture: input.wikiAutoCapture ?? input.previousConfig?.wikiAutoCapture ?? false,
    wikiLanguage: input.wikiLanguage || input.previousConfig?.wikiLanguage || 'en',
    omxBin: input.omxBin || input.previousConfig?.omxBin || 'omx',
    omcBin: input.omcBin || input.previousConfig?.omcBin || process.env.OMW_OMC_BIN || 'omc',
    pythonBin: pythonBin || input.previousConfig?.pythonBin || 'python3',
    createdAt: input.createdAt || input.previousConfig?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(dirs.configPath, config);
  return config;
}

export async function validateConfig(config) {
  const issues = [];
  if (!config) {
    return {
      ok: false,
      issues: [`OMW is not configured. Run \`${SETUP_COMMAND_HINT}\`.`],
    };
  }
  await validateRequiredDirectory(issues, 'wikiPath', resolveWikiPath(config));
  return { ok: issues.length === 0, issues };
}

export function resolveWikiPath(config) {
  return config?.wikiPath || null;
}

export function normalizeConfigPaths(config, sourceConfigPath = '') {
  if (!config) return null;
  const configDir = sourceConfigPath ? path.dirname(sourceConfigPath) : process.cwd();
  const sourcePath = resolveConfiguredPath(config.sourcePath, configDir);
  const baseDir = sourcePath || configDir;
  return {
    ...config,
    sourcePath,
    wikiPath: resolveConfiguredPath(config.wikiPath, baseDir),
  };
}

function resolveConfiguredPath(value, baseDir) {
  if (!value) return value ?? null;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

async function validateRequiredDirectory(issues, name, configuredPath) {
  if (!configuredPath) {
    issues.push(`${name} is required. Run \`${SETUP_COMMAND_HINT}\` or set OMW_WIKI_PATH.`);
    return;
  }
  if (!(await pathExists(configuredPath))) {
    issues.push(`${name} does not exist: ${configuredPath}`);
  }
}

async function readConfigCandidate(filePath) {
  if (!(await pathExists(filePath))) {
    return { exists: false, config: null, issues: [] };
  }
  try {
    return { exists: true, config: await readJsonFile(filePath, null), issues: [] };
  } catch (error) {
    return {
      exists: true,
      config: null,
      issues: [`OMW config is not valid JSON (${filePath}): ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
