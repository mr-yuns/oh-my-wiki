#!/usr/bin/env node
import process from 'node:process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexHookStatus,
  handleCodexHook,
  installCodexHooks,
  uninstallCodexHooks,
} from '../platforms/codex/hooks.js';
import {
  claudeHookStatus,
  handleClaudeHook,
  installClaudeHooks,
  uninstallClaudeHooks,
} from '../platforms/claude/hooks.js';
import {
  readConfig,
  readConfigWithSource,
  resolveWikiPath,
  SETUP_COMMAND_HINT,
  validateConfig,
  writeConfig,
} from '../config/config.js';
import { ensureStateDirs, stateRoot, fallbackStateRoot } from '../runtime/state.js';
import { installSkills, listSkills, repoRoot, skillStatus, uninstallSkills } from '../skills/manager.js';
import { parseOptions } from '../utils/args.js';
import { pathExists } from '../utils/fs.js';
import { checkCommandAvailable, runWrappedCommand } from '../wrapper/omx.js';
import { buildWikiStatus, ensureWikiContract, normalizeWikiLanguage } from '../wiki/contract.mjs';

async function main(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return printHelp();
  if (command === '--version' || command === '-v') return version();
  if (command === 'version') return version();
  if (command === 'init') return init([subcommand, ...rest].filter(Boolean));
  if (command === 'setup') return setup([subcommand, ...rest].filter(Boolean));
  if (command === 'doctor') return doctor([subcommand, ...rest].filter(Boolean));
  if (command === 'paths') return paths();
  if (command === 'wiki' && (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help')) return printWikiHelp();
  if (command === 'wiki') return wiki(subcommand, rest);
  if (command === 'search') return wiki('search', [subcommand, ...rest].filter(Boolean));
  if (command === 'capture') return wiki('capture', [subcommand, ...rest].filter(Boolean));
  if (command === 'daily') return wiki('daily', [subcommand, ...rest].filter(Boolean));
  if (command === 'ingest') return wiki('ingest', [subcommand, ...rest].filter(Boolean));
  if (command === 'queue') return wiki('queue', [subcommand, ...rest].filter(Boolean));
  if (command === 'report-raw-ingest') return wiki('report-raw-ingest', [subcommand, ...rest].filter(Boolean));
  if (command === 'report-daily') return wiki('report-daily', [subcommand, ...rest].filter(Boolean));
  if (command === 'validate') return wiki('validate', [subcommand, ...rest].filter(Boolean));
  if (command === 'omx') return omx([subcommand, ...rest].filter(Boolean));
  if (command === 'omc') return omc([subcommand, ...rest].filter(Boolean));
  if (command === 'codex') return codex([subcommand, ...rest].filter(Boolean));
  if (command === 'claude') return claude([subcommand, ...rest].filter(Boolean));
  if (command === 'codex-hooks') return codexHooks(subcommand, rest);
  if (command === 'claude-hooks') return claudeHooks(subcommand, rest);
  if (command === 'skills') return skills(subcommand, rest);
  if (command === 'hook') return hook(subcommand);
  if (command === 'claude-hook') return claudeHook(subcommand);
  const passthroughArgs = [command, subcommand, ...rest].filter(Boolean);
  if (isTopLevelOmxPassthrough(passthroughArgs)) return omx(passthroughArgs);
  throw new Error(`Unknown command: ${command}`);
}

async function setup(argv) {
  const options = parseOptions(argv);
  const previousConfig = await readConfig();
  const wikiPath = options.wiki || options['wiki-path'] || process.env.OMW_WIKI_PATH || previousConfig?.wikiPath || defaultBaseWikiPath();
  const wikiAutoCapture = options['wiki-auto-capture'] ? true : options['no-wiki-auto-capture'] ? false : undefined;
  const wikiLanguage = normalizeWikiLanguage(options.language || options.lang || process.env.OMW_WIKI_LANGUAGE || previousConfig?.wikiLanguage || 'en');
  const config = await writeConfig({
    sourcePath: repoRoot(),
    wikiPath,
    wikiAutoCapture,
    wikiLanguage,
    omxBin: options['omx-bin'],
    omcBin: options['omc-bin'],
    previousConfig,
  });
  const dirs = await ensureStateDirs();
  const contractSetup = await ensureWikiContract(config.wikiPath, { language: config.wikiLanguage });
  const validation = await validateConfig(config);
  const wikiStatus = await buildWikiStatus(config);
  const omxStatus = checkCommandAvailable(resolveOmxBin(config));
  const omcStatus = checkCommandAvailable(config.omcBin);

  console.log('Oh My Wiki setup');
  console.log(`Registered wiki: ${config.wikiPath}`);
  console.log(`Wiki language: ${config.wikiLanguage}`);
  if (contractSetup.created) console.log(`- Generated wiki contract: ${contractSetup.contractPath}`);
  if (contractSetup.updated) console.log(`- Updated wiki contract: ${contractSetup.contractPath}`);
  console.log(`- Wiki auto capture: ${config.wikiAutoCapture ? 'enabled' : 'disabled'}`);
  console.log(`Registered OMX command: ${resolveOmxBin(config)}`);
  console.log(`Registered OMC command: ${config.omcBin}`);
  console.log(`Config written: ${dirs.configPath}`);

  const issues = [...new Set([...validation.issues, ...contractSetup.issues, ...wikiStatus.issues])];
  if (issues.length > 0) {
    console.log('\nIssues:');
    for (const issue of issues) console.log(`- ${issue}`);
    return 1;
  }

  if (!options['no-hooks']) {
    const codexHooks = await installCodexHooks({ codexHome: options['codex-home'] });
    const claudeHooks = await installClaudeHooks({ claudeHome: options['claude-home'] });
    console.log('\nConfigured hooks:');
    console.log(`- Codex Stop hook: ${codexHooks.events.Stop.installed ? 'installed' : 'missing'}`);
    console.log(`- Claude Stop hook: ${claudeHooks.events.Stop.installed ? 'installed' : 'missing'}`);
  }
  const codexSkills = await installSkills({ platform: 'codex', codexHome: options['codex-home'], name: 'all' });
  const claudeSkills = await installSkills({ platform: 'claude', claudeHome: options['claude-home'], name: 'all' });
  console.log(`- Codex skills: ${codexSkills.installed.map((item) => item.name).join(', ') || '(none)'}`);
  console.log(`- Claude skills: ${claudeSkills.installed.map((item) => item.name).join(', ') || '(none)'}`);
  console.log(`- OMX: ${omxStatus.available ? 'available' : 'optional / unavailable'}`);
  console.log(`- OMC: ${omcStatus.available ? 'available' : 'optional / unavailable'}`);
  console.log('\nOMW is ready.');
  return 0;
}

async function init(argv = []) {
  const options = parseOptions(argv);
  const previousConfig = await readConfig();
  const { initializeWiki } = await import('../commands/init.mjs');
  const result = await initializeWiki({ config: previousConfig, options });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  console.log('Oh My Wiki init');
  console.log(`- wiki: ${result.wikiPath}`);
  console.log(`- language: ${result.language}`);
  console.log(`- created wiki directory: ${result.createdWiki ? 'yes' : 'no'}`);
  console.log(`- copied base wiki: ${result.copiedBaseWiki ? 'yes' : 'no'}`);
  console.log(`- contract: ${result.contractPath}`);
  if (result.contractCreated) console.log('- contract created: yes');
  if (result.contractUpdated) console.log('- contract updated: yes');
  if (result.issues.length > 0) {
    console.log('\nIssues:');
    for (const issue of result.issues) console.log(`- ${issue}`);
    return 1;
  }
  console.log('\nOMW wiki is initialized.');
  return 0;
}

function defaultBaseWikiPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '.wiki');
}

async function doctor(argv = []) {
  const options = parseOptions(argv);
  const dirs = await ensureStateDirs();
  const configSource = await readConfigWithSource();
  const config = configSource.config;
  const validation = await validateConfig(config);
  const wikiStatus = await buildWikiStatus(config);
  const omx = checkCommandAvailable(resolveOmxBin(config));
  const omc = checkCommandAvailable(config?.omcBin || 'omc');
  const hooks = {
    codex: await codexHookStatus({ codexHome: options['codex-home'] }),
    claude: await claudeHookStatus({ claudeHome: options['claude-home'] }),
  };
  const issues = [...new Set([...(configSource.issues || []), ...validation.issues, ...wikiStatus.issues])];
  const warnings = hookWarnings({ config, hooks });
  const report = {
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    state: { root: dirs.root, configPath: dirs.configPath },
    config: {
      configured: Boolean(config),
      wikiPath: resolveWikiPath(config),
      wikiPathExists: config?.wikiPath ? await pathExists(config.wikiPath) : false,
      omxBin: resolveOmxBin(config),
      wikiLanguage: config?.wikiLanguage || 'en',
      omcBin: config?.omcBin || 'omc',
    },
    wiki: wikiStatus,
    omx,
    omc,
    hooks,
    warnings,
    issues,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  console.log('Oh My Wiki doctor');
  console.log(`- state dir: ${dirs.root}`);
  console.log(`- config: ${dirs.configPath}`);
  console.log(`- wiki: ${report.config.wikiPath || '(not configured)'}${report.config.wikiPathExists ? ' (exists)' : ''}`);
  console.log(`- omx: ${omx.available ? 'available' : 'optional / unavailable'}`);
  console.log(`- omc: ${omc.available ? 'available' : 'optional / unavailable'}`);
  console.log(`- Codex hooks: ${hookSummary(hooks.codex, 'codex')}`);
  console.log(`- Claude hooks: ${hookSummary(hooks.claude, 'claude')}`);
  if (warnings.length > 0) {
    console.log('\nHook warnings:');
    for (const warning of warnings) console.log(`- ${warning}`);
  }
  if (issues.length > 0) {
    console.log('\nIssues:');
    for (const issue of issues) console.log(`- ${issue}`);
    return 1;
  }
  console.log('\nOMW core is ready.');
  return 0;
}

function hookWarnings({ config, hooks }) {
  const warnings = [];
  const autoCapture = Boolean(config?.wikiAutoCapture);
  if (autoCapture && !hooks.codex.codexHooksFeatureEnabled) {
    warnings.push('Codex hooks feature is disabled; run `omw codex-hooks install` to enable OMW Codex hooks.');
  }
  for (const [platform, status] of Object.entries(hooks)) {
    const label = platform === 'codex' ? 'Codex' : 'Claude';
    for (const issue of status.issues || []) {
      warnings.push(issue);
    }
    const stop = status.events?.Stop || {};
    if (autoCapture && !stop.installed) {
      warnings.push(`${label} Stop hook is not installed; run \`omw ${platform}-hooks install\` to enable wiki auto-capture for ${label}.`);
    }
    const stale = Object.values(status.events || {}).reduce((total, event) => total + (event.staleOmwLikeEntries || 0), 0);
    if (stale > 0) {
      warnings.push(`${label} has ${stale} stale OMW-like hook entr${stale === 1 ? 'y' : 'ies'}; run \`omw ${platform}-hooks install\` to refresh managed hooks.`);
    }
    const driftedEvents = Object.entries(status.events || {})
      .filter(([, event]) => event.installed && event.stateRootMatches === false)
      .map(([eventName]) => eventName);
    if (driftedEvents.length > 0) {
      warnings.push(`${label} hooks use a stale OMW state root for ${driftedEvents.join(', ')}; run \`omw ${platform}-hooks install\` to refresh managed hooks.`);
    }
  }
  return warnings;
}

function hookSummary(status, platform) {
  const stopInstalled = status.events?.Stop?.installed;
  const stale = Object.values(status.events || {}).reduce((total, event) => total + (event.staleOmwLikeEntries || 0), 0);
  const parts = [stopInstalled ? 'Stop installed' : 'Stop missing'];
  if (platform === 'codex') parts.push(status.codexHooksFeatureEnabled ? 'feature enabled' : 'feature disabled');
  if (stale > 0) parts.push(`${stale} stale`);
  return parts.join(', ');
}

async function wiki(subcommand, argv = []) {
  const options = parseOptions(argv);
  const config = await readConfig();
  const { runWikiCommand } = await import('../commands/wiki.mjs');
  const stdinText = options.stdin ? await readStdinText() : '';
  const result = await runWikiCommand({ subcommand, config, options, stdinText });
  process.stdout.write(result.output);
  return result.exitCode;
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function paths() {
  const dirs = await ensureStateDirs();
  const config = await readConfig();
  console.log(JSON.stringify({
    activeStateRoot: dirs.root,
    configuredStateRoot: stateRoot(),
    fallbackStateRoot: fallbackStateRoot(),
    configPath: dirs.configPath,
    eventsDir: dirs.eventsDir,
    wikiPath: resolveWikiPath(config),
    omxBin: resolveOmxBin(config),
    omcBin: config?.omcBin || 'omc',
  }, null, 2));
  return 0;
}

async function omx(argv) {
  const config = await readConfig();
  return runWrappedCommand({ command: resolveOmxBin(config), args: normalizePassthroughArgs(argv), config });
}

async function omc(argv) {
  const config = await readConfig();
  return runWrappedCommand({ command: process.env.OMW_OMC_BIN || config?.omcBin || 'omc', args: normalizePassthroughArgs(argv), config });
}

async function codex(argv) {
  const config = await readConfig();
  return runWrappedCommand({ command: 'codex', args: normalizePassthroughArgs(argv), config });
}

async function claude(argv) {
  const config = await readConfig();
  return runWrappedCommand({ command: 'claude', args: normalizePassthroughArgs(argv), config });
}

async function codexHooks(subcommand, argv = []) {
  const options = parseOptions(argv);
  if (subcommand === 'install') { console.log(JSON.stringify(await installCodexHooks({ codexHome: options['codex-home'] }), null, 2)); return 0; }
  if (subcommand === 'uninstall') { console.log(JSON.stringify(await uninstallCodexHooks({ codexHome: options['codex-home'] }), null, 2)); return 0; }
  if (subcommand === 'status') { console.log(JSON.stringify(await codexHookStatus({ codexHome: options['codex-home'] }), null, 2)); return 0; }
  throw new Error('Usage: omw codex-hooks <install|status|uninstall> [--codex-home <path>]');
}

async function claudeHooks(subcommand, argv = []) {
  const options = parseOptions(argv);
  if (subcommand === 'install') { console.log(JSON.stringify(await installClaudeHooks({ claudeHome: options['claude-home'] }), null, 2)); return 0; }
  if (subcommand === 'uninstall') { console.log(JSON.stringify(await uninstallClaudeHooks({ claudeHome: options['claude-home'] }), null, 2)); return 0; }
  if (subcommand === 'status') { console.log(JSON.stringify(await claudeHookStatus({ claudeHome: options['claude-home'] }), null, 2)); return 0; }
  throw new Error('Usage: omw claude-hooks <install|status|uninstall> [--claude-home <path>]');
}

async function skills(subcommand, argv = []) {
  const options = parseOptions(argv);
  const platform = options.platform || options._[0] || 'codex';
  const name = options.name || options.skill || options._[1] || 'all';
  const common = { platform, codexHome: options['codex-home'], claudeHome: options['claude-home'], name };
  if (subcommand === 'list') { console.log(JSON.stringify(await listSkills({ platform }), null, 2)); return 0; }
  if (subcommand === 'install') { console.log(JSON.stringify(await installSkills(common), null, 2)); return 0; }
  if (subcommand === 'status') { console.log(JSON.stringify(await skillStatus({ platform, codexHome: options['codex-home'], claudeHome: options['claude-home'] }), null, 2)); return 0; }
  if (subcommand === 'uninstall') { console.log(JSON.stringify(await uninstallSkills(common), null, 2)); return 0; }
  throw new Error('Usage: omw skills <list|install|status|uninstall> [codex|claude] [--name <skill>]');
}

async function hook(eventName) {
  if (!eventName) throw new Error('Usage: omw hook <event-name>');
  const result = await handleCodexHook(eventName, await readStdinText());
  if (result) console.log(JSON.stringify(result));
  return 0;
}

async function claudeHook(eventName) {
  if (!eventName) throw new Error('Usage: omw claude-hook <event-name>');
  const result = await handleClaudeHook(eventName, await readStdinText());
  if (result) console.log(JSON.stringify(result));
  return 0;
}

function normalizePassthroughArgs(argv) {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

function resolveOmxBin(config) {
  return process.env.OMW_OMX_BIN || config?.omxBin || 'omx';
}

function isTopLevelOmxPassthrough(argv = []) {
  if (argv.length === 0) return false;
  const first = argv[0];
  if (!first.startsWith('-') || ['--help', '-h', '--version', '-v'].includes(first)) return false;
  return true;
}

function version() {
  const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  return 0;
}

function printHelp() {
  console.log(`oh-my-wiki

Usage:
  omw setup [--wiki <path>] [--language en|ko] [--wiki-auto-capture]
  omw init [--wiki <path>] [--language en|ko] [--json]
  omw doctor [--json]
  omw paths
  omw wiki --help
  omw wiki init|status|refresh|contract|search|capture|queue|ingest|daily|report-raw-ingest|report-daily|validate
  omw search "<query>" [--backend auto|sqlite|scan] [--limit <n>] [--type <type>] [--status <status>] [--path <path>] [--sort relevance|path|title] [--json]
  omw capture --title "<title>" --stdin
  omw queue [--json]
  omw ingest <raw-note> [--write-draft]
  omw ingest <raw-note> --promote --target <relative-note.md>
  omw daily --author "<name>" --team "<team>" --date YYYY-MM-DD --stdin
  omw report-raw-ingest [--language en|ko]
  omw report-daily [--language en|ko] [--date YYYY-MM-DD] [--author <name>] [--team <team>]
  omw validate [--json]
  omw codex-hooks install|status|uninstall
  omw claude-hooks install|status|uninstall
  omw skills install|status|list|uninstall --platform codex|claude
  omw omx -- <args...>
  omw omc -- <args...>
  omw -- <omx args...>
  omw <omx launch flags...>

Defaults:
  State root: ~/.omw
  Base wiki: repository .wiki unless --wiki is provided
`);
  return 0;
}

function printWikiHelp() {
  console.log(`omw wiki

Usage:
  omw wiki status [--json]
  omw wiki init [--wiki <path>] [--language en|ko] [--json]
  omw wiki refresh [--target all|contract|index] [--dry-run] [--json]
  omw wiki contract [--refresh] [--dry-run] [--explain|--validate] [--json]
  omw wiki search "<query>" [--backend auto|sqlite|scan] [--limit <n>] [--type <type>] [--status <status>] [--path <path>] [--sort relevance|path|title] [--json]
  omw wiki capture --title "<title>" [--type agent_session|discussion] [--stdin|--body <text>] [--json]
  omw wiki queue [--json]
  omw wiki ingest <raw-note> [--write-draft] [--overwrite-draft] [--json]
  omw wiki ingest <raw-note> --promote --target <relative-note.md> [--overwrite-promote] [--json]
  omw wiki daily --author <name> --team <team> --date YYYY-MM-DD [--stdin|--body <text>] [--json]
  omw wiki report-raw-ingest [--language en|ko]
  omw wiki report-daily [--language en|ko] [--date YYYY-MM-DD] [--author <name>] [--team <team>]
  omw wiki validate [--json]

Notes:
  --promote writes only to an explicit wiki-relative Markdown target.
  --backend scan is the dependency-free fallback; sqlite is used automatically when available.
  Search filters match note frontmatter metadata and wiki-relative paths.
`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
