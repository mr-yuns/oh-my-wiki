import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { scanWikiContract } from './scanner.mjs';
import { assertSafeExistingAncestor, assertSafeExistingFile, assertSafeOptionalFile, assertSafeOptionalOwmDirectory, ensureSafeDirectory, isWikiSafetyError } from './safety.mjs';

export const CONTRACT_RELATIVE_PATH = path.join('.omw', 'contract.json');
export const DEFAULT_WIKI_LANGUAGE = 'en';

export function normalizeWikiLanguage(value) {
  const language = String(value || DEFAULT_WIKI_LANGUAGE).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(language)) {
    throw new Error(`Unsupported wiki language: ${value}`);
  }
  return language;
}

export function wikiContractPath(wikiPath) {
  return wikiPath ? path.join(wikiPath, CONTRACT_RELATIVE_PATH) : '';
}

export async function loadWikiContract(wikiPath) {
  const contractPath = wikiContractPath(wikiPath);
  if (!wikiPath) {
    return { ok: false, configured: false, wikiPath: '', contractPath: '', contractExists: false, contract: null, issues: ['wikiPath is not configured'] };
  }
  const wikiExists = await pathExists(wikiPath);
  const issues = [];
  if (!wikiExists) issues.push(`wikiPath does not exist: ${wikiPath}`);
  const contractStatus = contractPath ? await safeOptionalContractStatus(wikiPath, contractPath) : { exists: false, issue: null };
  const contractExists = contractStatus.exists;
  if (wikiExists && !contractExists) issues.push(`wiki contract does not exist: ${contractPath}`);
  if (contractStatus.issue) issues.push(contractStatus.issue);
  let contract = null;
  if (contractExists && !contractStatus.issue) {
    try {
      contract = await readJsonFile(contractPath, null);
    } catch (error) {
      issues.push(`wiki contract is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const validation = contract ? validateWikiContractShape(contract) : { ok: false, issues: [] };
  if (contract) issues.push(...validation.issues);
  return { ok: issues.length === 0, configured: true, wikiPath, contractPath, wikiExists, contractExists, contract, contractValidation: validation, issues };
}

export async function ensureWikiContract(wikiPath, options = {}) {
  const contractPath = wikiContractPath(wikiPath);
  if (!wikiPath) return { ok: false, created: false, updated: false, contractPath: '', issues: ['wikiPath is not configured'] };
  if (!(await pathExists(wikiPath))) return { ok: false, created: false, updated: false, contractPath, issues: [`wikiPath does not exist: ${wikiPath}`] };
  const language = normalizeWikiLanguage(options.language || options.wikiLanguage);
  await assertSafeOptionalOwmDirectory(wikiPath);
  const contractExists = await assertSafeOptionalFile({ wikiPath }, contractPath, 'Wiki contract');
  const scanned = await scanWikiContract(wikiPath, { ...options, language, writeManaged: true });
  if (contractExists) {
    const current = await readJsonFile(contractPath, null);
    const next = current?.language === language ? mergeScannerOwnedContract(current, scanned) : scanned;
    if (scannerContractsEquivalent(current, next)) return { ok: true, created: false, updated: false, contractPath, issues: [] };
    await writeJsonFile(contractPath, next);
    return { ok: true, created: false, updated: true, contractPath, issues: [] };
  }
  await ensureSafeDirectory({ wikiPath }, path.dirname(contractPath), '.omw directory');
  await writeJsonFile(contractPath, scanned);
  return { ok: true, created: true, updated: false, contractPath, issues: [] };
}

export async function refreshWikiContract(wikiPath, options = {}) {
  const contractPath = wikiContractPath(wikiPath);
  if (!wikiPath) return { ok: false, refreshed: false, contractPath: '', issues: ['wikiPath is not configured'] };
  if (!(await pathExists(wikiPath))) return { ok: false, refreshed: false, contractPath, issues: [`wikiPath does not exist: ${wikiPath}`] };
  const language = normalizeWikiLanguage(options.language || options.wikiLanguage);
  if (!options.dryRun) await assertSafeOptionalOwmDirectory(wikiPath);
  await assertSafeOptionalFile({ wikiPath }, contractPath, 'Wiki contract');
  const scanned = await scanWikiContract(wikiPath, { ...options, language, writeManaged: !options.dryRun });
  const current = await readJsonFile(contractPath, null);
  const next = current?.language === language ? mergeScannerOwnedContract(current, scanned) : scanned;
  const changed = !scannerContractsEquivalent(current, next);
  if (options.dryRun) {
    return {
      ok: true,
      refreshed: false,
      changed,
      dryRun: true,
      contractPath,
      changes: changed ? summarizeContractChanges(current, next) : [],
      current,
      next,
      issues: [],
    };
  }
  if (!changed) return { ok: true, refreshed: false, changed: false, dryRun: false, contractPath, issues: [] };
  await ensureSafeDirectory({ wikiPath }, path.dirname(contractPath), '.omw directory');
  await writeJsonFile(contractPath, next);
  return { ok: true, refreshed: true, changed: true, dryRun: false, contractPath, changes: summarizeContractChanges(current, next), issues: [] };
}

export async function buildWikiStatus(config) {
  const wikiPath = config?.wikiPath || '';
  const status = await loadWikiContract(wikiPath);
  const language = status.contract?.language || config?.wikiLanguage || DEFAULT_WIKI_LANGUAGE;
  const searchRoot = status.contract?.search?.root || '';
  const searchRootPath = wikiPath && searchRoot ? path.join(wikiPath, searchRoot) : wikiPath;
  const searchRootExists = searchRootPath ? await pathExists(searchRootPath) : false;
  const rawRoot = status.contract?.raw?.root || '';
  const rawRootPath = wikiPath && rawRoot ? path.join(wikiPath, rawRoot) : '';
  const rawRootExists = rawRootPath ? await pathExists(rawRootPath) : false;
  const typeEntries = Object.entries(status.contract?.raw?.types || {});
  const ruleEntries = Object.entries(status.contract?.rules || {});
  const rules = [];
  for (const [key, value] of ruleEntries) {
    const rulePath = typeof value === 'string' ? value : value?.path || '';
    const label = typeof value === 'string' ? key : value?.label || key;
    const fullPath = wikiPath && rulePath ? path.join(wikiPath, rulePath) : '';
    rules.push({ key, label, path: rulePath, fullPath, exists: fullPath ? await pathExists(fullPath) : false });
  }
  const types = [];
  for (const [key, value] of typeEntries) {
    const folderPath = rawRootPath && value.folder ? path.join(rawRootPath, value.folder) : '';
    const template = value.agentTemplate || value.template || value.humanTemplate || '';
    const templatePath = template ? path.join(wikiPath, template) : '';
    types.push({ key, label: value.label || key, folder: value.folder || '', folderPath, exists: folderPath ? await pathExists(folderPath) : false, template, templatePath, templateExists: templatePath ? await pathExists(templatePath) : false, naming: value.naming || {} });
  }
  const issues = [...status.issues];
  if (status.ok && rawRoot && !rawRootExists) {
    issues.push(await missingWikiPathIssue(status, rawRootPath, 'Raw root', `wiki raw root does not exist: ${rawRootPath}`));
  }
  if (status.ok) {
    for (const type of types) {
      if (type.folderPath && !type.exists) {
        issues.push(await missingWikiPathIssue(status, type.folderPath, 'Raw type folder', `wiki raw type folder does not exist (${type.key}): ${type.folderPath}`));
      }
      if (type.template && !type.templateExists) issues.push(`wiki raw type template does not exist (${type.key}): ${type.template}`);
    }
    for (const rule of rules) {
      if (!rule.path) issues.push(`wiki rule path is required (${rule.key})`);
      else if (!rule.exists) issues.push(`wiki rule note does not exist (${rule.key}): ${rule.path}`);
    }
  }
  return { ...status, ok: issues.length === 0, language, understanding: status.contract?.understanding || null, capabilities: status.contract?.capabilities || {}, search: { ...(status.contract?.search || {}), root: searchRoot, rootPath: searchRootPath, rootExists: searchRootExists }, raw: { root: rawRoot, rootPath: rawRootPath, rootExists: rawRootExists, types }, rules, issues };
}

async function missingWikiPathIssue(status, targetPath, label, fallbackIssue) {
  try {
    await assertSafeExistingAncestor(status, targetPath, label);
    return fallbackIssue;
  } catch (error) {
    if (isWikiSafetyError(error)) return error.message;
    throw error;
  }
}

async function safeOptionalContractStatus(wikiPath, contractPath) {
  try {
    return {
      exists: await assertSafeOptionalFile({ wikiPath }, contractPath, 'Wiki contract'),
      issue: null,
    };
  } catch (error) {
    return {
      exists: true,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadWikiRuleSummaries(status, keys = []) {
  const wanted = new Set(keys);
  const rules = (status.rules || []).filter((rule) => wanted.size === 0 || wanted.has(rule.key));
  const summaries = [];
  for (const rule of rules) {
    let text = '';
    if (rule.fullPath && rule.exists) {
      await assertSafeExistingFile(status, rule.fullPath, 'Wiki rule');
      text = await readFile(rule.fullPath, 'utf8').catch(() => '');
    }
    summaries.push({ key: rule.key, label: rule.label, path: rule.path, exists: rule.exists, title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || rule.label, excerpt: summarizeRuleText(text) });
  }
  return summaries;
}

export function validateWikiContractShape(contract) {
  const issues = [];
  if (!isPlainObject(contract)) return { ok: false, issues: ['wiki contract must be a JSON object'] };
  requireIntegerEnum(contract, 'schemaVersion', [1, 2], issues);
  requireString(contract, 'generatedBy', issues);
  requireString(contract, 'language', issues);
  requireObject(contract, 'raw', issues);
  requireObject(contract, 'ingest', issues);
  requireObject(contract, 'search', issues);
  if (isPlainObject(contract.raw)) {
    requireString(contract.raw, 'root', issues, 'raw.root');
    requireWikiRelativePath(contract.raw, 'root', issues, 'raw.root');
    requireObject(contract.raw, 'types', issues, 'raw.types');
    requireStringArray(contract.raw, 'noteTypes', issues, 'raw.noteTypes', { optional: true });
    requireStringArray(contract.raw, 'ingestStates', issues, 'raw.ingestStates', { optional: true });
    if (isPlainObject(contract.raw.types)) {
      for (const [key, type] of Object.entries(contract.raw.types)) {
        if (!isPlainObject(type)) {
          issues.push(`raw.types.${key} must be an object`);
          continue;
        }
        requireString(type, 'folder', issues, `raw.types.${key}.folder`);
        requireWikiRelativePath(type, 'folder', issues, `raw.types.${key}.folder`);
        requireOptionalWikiRelativePath(type, 'agentTemplate', issues, `raw.types.${key}.agentTemplate`);
        requireOptionalWikiRelativePath(type, 'humanTemplate', issues, `raw.types.${key}.humanTemplate`);
        requireOptionalWikiRelativePath(type, 'template', issues, `raw.types.${key}.template`);
        if (key === 'daily_report') validateDailyReportNaming(type.naming, issues, `raw.types.${key}.naming`);
      }
    }
  }
  if (isPlainObject(contract.ingest)) {
    requireStringArray(contract.ingest, 'pendingStates', issues, 'ingest.pendingStates', { optional: true });
    requireStringArray(contract.ingest, 'candidateTargets', issues, 'ingest.candidateTargets', { optional: true });
    requireWikiRelativePathArray(contract.ingest, 'candidateTargets', issues, 'ingest.candidateTargets');
    requireStringArray(contract.ingest, 'ruleKeys', issues, 'ingest.ruleKeys', { optional: true });
    if (Object.hasOwn(contract.ingest, 'approvalRequiredForPromotedNotes') && typeof contract.ingest.approvalRequiredForPromotedNotes !== 'boolean') {
      issues.push('ingest.approvalRequiredForPromotedNotes must be a boolean');
    }
  }
  if (isPlainObject(contract.search)) {
    requireStringArray(contract.search, 'excludeDirs', issues, 'search.excludeDirs');
    requireWikiRelativePathArray(contract.search, 'excludeDirs', issues, 'search.excludeDirs');
    if (Object.hasOwn(contract.search, 'root') && typeof contract.search.root !== 'string') issues.push('search.root must be a string');
    requireOptionalWikiRelativePath(contract.search, 'root', issues, 'search.root', { allowEmpty: true });
    if (Object.hasOwn(contract.search, 'ranking')) {
      if (!isPlainObject(contract.search.ranking)) {
        issues.push('search.ranking must be an object');
      } else {
        for (const [key, value] of Object.entries(contract.search.ranking)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            issues.push(`search.ranking.${key} must be a non-negative number`);
          }
        }
      }
    }
  }
  if (Object.hasOwn(contract, 'rules')) validateRulesSection(contract.rules, issues);
  if (Object.hasOwn(contract, 'understanding')) validateUnderstanding(contract.understanding, issues);
  return { ok: issues.length === 0, issues };
}

function validateRulesSection(value, issues) {
  if (!isPlainObject(value)) {
    issues.push('rules must be an object');
    return;
  }
  for (const [key, rule] of Object.entries(value)) {
    if (typeof rule === 'string') {
      if (!isWikiRelativePath(rule)) issues.push(`rules.${key} must be a wiki-relative path`);
      continue;
    }
    if (!isPlainObject(rule)) {
      issues.push(`rules.${key} must be a string or object`);
      continue;
    }
    requireString(rule, 'path', issues, `rules.${key}.path`);
    requireWikiRelativePath(rule, 'path', issues, `rules.${key}.path`);
    if (Object.hasOwn(rule, 'label') && typeof rule.label !== 'string') issues.push(`rules.${key}.label must be a string`);
  }
}

function validateUnderstanding(value, issues) {
  if (!isPlainObject(value)) {
    issues.push('understanding must be an object');
    return;
  }
  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 100) {
    issues.push('understanding.score must be an integer between 0 and 100');
  }
  if (Object.hasOwn(value, 'complete') && typeof value.complete !== 'boolean') {
    issues.push('understanding.complete must be a boolean');
  }
  if (Object.hasOwn(value, 'missingDimensions') && !Array.isArray(value.missingDimensions)) {
    issues.push('understanding.missingDimensions must be an array');
  }
  if (Object.hasOwn(value, 'dimensions') && !Array.isArray(value.dimensions)) {
    issues.push('understanding.dimensions must be an array');
  }
}

function requireIntegerEnum(object, key, values, issues, label = key) {
  if (!Object.hasOwn(object, key)) {
    issues.push(`${label} is required`);
    return;
  }
  if (!Number.isInteger(object[key]) || !values.includes(object[key])) {
    issues.push(`${label} must be one of: ${values.join(', ')}`);
  }
}

function validateDailyReportNaming(value, issues, label) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    issues.push(`${label} must be an object`);
    return;
  }
  validateOptionalPathPattern(value, 'memberFolderPattern', issues, `${label}.memberFolderPattern`, { allowNested: true });
  validateOptionalPathPattern(value, 'reportFilePattern', issues, `${label}.reportFilePattern`, { allowNested: false });
}

function validateOptionalPathPattern(object, key, issues, label, options = {}) {
  if (!Object.hasOwn(object, key)) return;
  if (typeof object[key] !== 'string') {
    issues.push(`${label} must be a string`);
    return;
  }
  if (!isSafeRelativePatternPath(object[key], options)) issues.push(`${label} must be a safe relative pattern`);
}

function isSafeRelativePatternPath(value, options = {}) {
  if (!value || value.includes('\0')) return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false;
  const segments = value.split(/[\\/]+/);
  if (!options.allowNested && segments.length > 1) return false;
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function requireString(object, key, issues, label = key) {
  if (!Object.hasOwn(object, key)) {
    issues.push(`${label} is required`);
    return;
  }
  if (typeof object[key] !== 'string') issues.push(`${label} must be a string`);
}

function requireObject(object, key, issues, label = key) {
  if (!Object.hasOwn(object, key)) {
    issues.push(`${label} is required`);
    return;
  }
  if (!isPlainObject(object[key])) issues.push(`${label} must be an object`);
}

function requireStringArray(object, key, issues, label = key, options = {}) {
  if (!Object.hasOwn(object, key)) {
    if (!options.optional) issues.push(`${label} is required`);
    return;
  }
  if (!Array.isArray(object[key]) || object[key].some((item) => typeof item !== 'string')) {
    issues.push(`${label} must be an array of strings`);
  }
}

function requireWikiRelativePath(object, key, issues, label = key, options = {}) {
  if (!Object.hasOwn(object, key) || typeof object[key] !== 'string') return;
  if (!isWikiRelativePath(object[key], options)) issues.push(`${label} must be a wiki-relative path`);
}

function requireOptionalWikiRelativePath(object, key, issues, label = key, options = {}) {
  if (!Object.hasOwn(object, key)) return;
  if (typeof object[key] !== 'string') {
    issues.push(`${label} must be a string`);
    return;
  }
  if (!isWikiRelativePath(object[key], options)) issues.push(`${label} must be a wiki-relative path`);
}

function requireWikiRelativePathArray(object, key, issues, label = key) {
  if (!Object.hasOwn(object, key) || !Array.isArray(object[key])) return;
  object[key].forEach((item, index) => {
    if (typeof item === 'string' && !isWikiRelativePath(item)) issues.push(`${label}[${index}] must be a wiki-relative path`);
  });
}

function isWikiRelativePath(value, options = {}) {
  if (value === '') return Boolean(options.allowEmpty);
  if (value.includes('\0')) return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false;
  const segments = value.split(/[\\/]+/);
  return !segments.some((segment) => segment === '..');
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function scannerContractsEquivalent(current, scanned) {
  if (current?.generatedBy !== scanned.generatedBy) return false;
  const currentComparable = { ...current, generatedAt: scanned.generatedAt };
  return JSON.stringify(currentComparable) === JSON.stringify(scanned);
}

function summarizeContractChanges(current, next) {
  const currentFlat = flattenContractForDiff(current || {});
  const nextFlat = flattenContractForDiff(next || {});
  const keys = [...new Set([...Object.keys(currentFlat), ...Object.keys(nextFlat)])].sort();
  return keys.flatMap((key) => {
    if (!Object.hasOwn(currentFlat, key)) return [{ path: key, type: 'added', next: nextFlat[key] }];
    if (!Object.hasOwn(nextFlat, key)) return [{ path: key, type: 'removed', previous: currentFlat[key] }];
    if (currentFlat[key] !== nextFlat[key]) return [{ path: key, type: 'changed', previous: currentFlat[key], next: nextFlat[key] }];
    return [];
  });
}

function flattenContractForDiff(value, prefix = '') {
  if (prefix === 'generatedAt') return {};
  if (!isPlainObject(value) && !Array.isArray(value)) return prefix ? { [prefix]: value } : {};
  if (Array.isArray(value)) {
    return { [prefix]: JSON.stringify(value) };
  }
  return Object.assign({}, ...Object.entries(value).map(([key, child]) => flattenContractForDiff(child, prefix ? `${prefix}.${key}` : key)));
}

function mergeScannerOwnedContract(current, scanned) {
  const preservedTopLevel = Object.fromEntries(Object.entries(current || {}).filter(([key]) => !scannerOwnedTopLevelKeys().has(key)));
  const raw = mergeUnknownKeys(current?.raw, scanned.raw, scannerOwnedRawKeys());
  return {
    ...preservedTopLevel,
    ...scanned,
    raw: {
      ...raw,
      types: mergeRawTypes(current?.raw?.types, scanned.raw?.types),
    },
    search: mergeUnknownKeys(current?.search, scanned.search, scannerOwnedSearchKeys()),
    ingest: mergeUnknownKeys(current?.ingest, scanned.ingest, scannerOwnedIngestKeys()),
    daily: mergeUnknownKeys(current?.daily, scanned.daily, scannerOwnedDailyKeys()),
  };
}

function mergeUnknownKeys(currentSection = {}, scannedSection = {}, scannerKeys = new Set()) {
  const preserved = Object.fromEntries(Object.entries(currentSection || {}).filter(([key]) => !scannerKeys.has(key)));
  return { ...preserved, ...scannedSection };
}

function mergeRawTypes(currentTypes = {}, scannedTypes = {}) {
  const merged = { ...scannedTypes };
  for (const [key, currentType] of Object.entries(currentTypes || {})) {
    if (!scannedTypes?.[key]) {
      if (isUserOwnedRawType(key, currentType)) merged[key] = currentType;
      continue;
    }
    merged[key] = mergeUnknownKeys(currentType, scannedTypes[key], scannerOwnedRawTypeKeys());
  }
  return merged;
}

function isUserOwnedRawType(key, value = {}) {
  if (scannerOwnedRawTypeNames().has(key)) return false;
  return Boolean(value && value.folder && (value.agentTemplate || value.template || value.humanTemplate));
}

function scannerOwnedRawTypeNames() {
  return new Set(['daily_report', 'agent_session', 'discussion', 'web_clip']);
}

function scannerOwnedTopLevelKeys() {
  return new Set(['schemaVersion', 'generatedBy', 'generatedAt', 'defaultLanguage', 'language', 'wikiName', 'source', 'scanner', 'understanding', 'capabilities', 'frontmatter', 'rules', 'raw', 'ingest', 'search', 'daily']);
}

function scannerOwnedRawKeys() {
  return new Set(['root', 'noteTypes', 'placeholder', 'sensitivityCheck', 'naming', 'types', 'ingestStates']);
}

function scannerOwnedRawTypeKeys() {
  return new Set(['label', 'folder', 'agentTemplate', 'humanTemplate', 'templateKind', 'naming']);
}

function scannerOwnedSearchKeys() {
  return new Set(['root', 'excludeDirs']);
}

function scannerOwnedIngestKeys() {
  return new Set(['pendingStates', 'candidateTargets', 'ruleKeys', 'approvalRequiredForPromotedNotes']);
}

function scannerOwnedDailyKeys() {
  return new Set(['titlePattern', 'placeholder', 'sensitivityCheck', 'channel', 'sections', 'placeholders']);
}

function summarizeRuleText(text) {
  return String(text || '').replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('|') && !line.startsWith('---')).slice(0, 8).join('\n').slice(0, 1200);
}
