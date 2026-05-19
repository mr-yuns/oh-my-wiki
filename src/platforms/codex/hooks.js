import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStateDirs } from '../../runtime/state.js';
import { pathExists, readJsonFile } from '../../utils/fs.js';
import { readConfig } from '../../config/config.js';
import { captureRawNote } from '../../wiki/capture.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const OWNER = 'oh-my-wiki';

export function defaultCodexHome(input) {
  return input || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function defaultCliPath() {
  return fileURLToPath(new URL('../../cli/omw.js', import.meta.url));
}

export async function installCodexHooks({ codexHome, cliPath = defaultCliPath() }) {
  const home = defaultCodexHome(codexHome);
  const dirs = await ensureStateDirs();
  await mkdir(home, { recursive: true });
  const hooksPath = path.join(home, 'hooks.json');
  const configPath = path.join(home, 'config.toml');
  const doc = (await readJsonFile(hooksPath, { hooks: {} })) || { hooks: {} };
  doc.hooks ||= {};

  for (const eventName of EVENTS) {
    const entries = doc.hooks[eventName] || [];
    doc.hooks[eventName] = [
      ...removeOwnedEntries(entries),
      buildHookEntry(eventName, cliPath, dirs.root),
    ];
  }

  await writeFile(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  await enableCodexHooksFeature(configPath);
  return codexHookStatus({ codexHome: home, cliPath });
}

export async function uninstallCodexHooks({ codexHome, cliPath = defaultCliPath() }) {
  const home = defaultCodexHome(codexHome);
  const hooksPath = path.join(home, 'hooks.json');
  const doc = (await readJsonFile(hooksPath, { hooks: {} })) || { hooks: {} };
  doc.hooks ||= {};

  for (const eventName of EVENTS) {
    doc.hooks[eventName] = removeOwnedEntries(doc.hooks[eventName] || []);
  }

  await mkdir(home, { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  return codexHookStatus({ codexHome: home, cliPath });
}

export async function codexHookStatus({ codexHome, cliPath = defaultCliPath() }) {
  const home = defaultCodexHome(codexHome);
  const dirs = await ensureStateDirs();
  const hooksPath = path.join(home, 'hooks.json');
  const configPath = path.join(home, 'config.toml');
  const doc = (await readJsonFile(hooksPath, { hooks: {} })) || { hooks: {} };
  const status = {
    codexHome: home,
    hooksPath,
    configPath,
    cliPath,
    codexHooksFeatureEnabled: await codexHooksFeatureEnabled(configPath),
    events: {},
  };

  for (const eventName of EVENTS) {
    const entries = doc.hooks?.[eventName] || [];
    const ownedEntries = entries.filter((entry) => entryHasOwnedCommand(entry, cliPath));
    const omwLikeEntries = entries.filter(entryHasOwnerCommand);
    status.events[eventName] = {
      installed: ownedEntries.length === 1,
      totalEntries: entries.length,
      expectedEntries: ownedEntries.length,
      omwLikeEntries: omwLikeEntries.length,
      staleOmwLikeEntries: Math.max(0, omwLikeEntries.length - ownedEntries.length),
      stateRoot: extractStateRootFromEntry(ownedEntries[0]) || dirs.root,
    };
  }
  return status;
}

export async function handleCodexHook(eventName, stdinText) {
  const payload = parseHookPayload(stdinText);
  const eventRecord = {
    eventName,
    receivedAt: new Date().toISOString(),
    hookRunId: payload.hook_run_id || payload.hookRunId || null,
    sessionId: payload.session_id || payload.sessionId || null,
    transcriptPath: payload.transcript_path || payload.transcriptPath || null,
    payloadKeys: Object.keys(payload).sort(),
    cwd: payload.cwd || process.cwd(),
  };
  const eventWrite = await recordEventBestEffort(eventName, eventRecord);
  await captureHookRawBestEffort(eventName, eventRecord, payload, 'codex-app');
  return buildRuntimeContextOutput(eventName, eventWrite);
}

async function captureHookRawBestEffort(eventName, eventRecord, payload, platform) {
  if (eventName !== 'Stop') return;
  try {
    const config = await readConfig();
    if (!config?.wikiAutoCapture) return;
    const workspace = eventRecord.cwd?.split('/').filter(Boolean).at(-1) || 'workspace';
    const captureText = hookCaptureText(config?.wikiLanguage, { eventName, payload, workspace });
    await captureRawNote({
      config,
      type: 'agent_session',
      title: captureText.title,
      body: captureText.body,
      options: {
        platform,
        workspace,
      },
    });
  } catch {
    // Hook capture is deliberately best-effort and must never block the platform session.
  }
}

function hookCaptureText(language, { eventName, payload, workspace }) {
  const transcript = payload.transcript_path || payload.transcriptPath ? '[captured by platform, not stored]' : 'none';
  if (language === 'ko') {
    return {
      title: `AI 세션 Raw 축적 - ${workspace}`,
      body: [
        `- hook event: ${eventName}`,
        `- transcript path: ${transcript}`,
        '- summary: 플랫폼 작업 종료 시점에 정리된 세션 Raw입니다. 원문 transcript 전체는 저장하지 않습니다.',
      ].join('\n'),
    };
  }
  return {
    title: `AI session raw capture - ${workspace}`,
    body: [
      `- hook event: ${eventName}`,
      `- transcript path: ${transcript}`,
      '- summary: Session Raw captured at platform stop time. The full original transcript is not stored.',
    ].join('\n'),
  };
}

async function recordEventBestEffort(eventName, eventRecord) {
  try {
    const dirs = await ensureStateDirs();
    const eventPath = path.join(dirs.eventsDir, `${Date.now()}-${eventName}.json`);
    await writeFile(eventPath, `${JSON.stringify(eventRecord, null, 2)}\n`);
    return { ok: true, eventPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRuntimeContextOutput(eventName, eventWrite) {
  if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit') {
    return null;
  }
  const diagnostics = eventWrite.ok ? '' : '\n- OMW event logging is unavailable in this runtime; continue without blocking the session.';
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: [
        'OMW is active for this Codex session.',
        '- Use OMW only as a local runtime/overlay boundary for hooks, diagnostics, and wrapper commands.',
        '- Do not persist secrets, signed URLs, private local paths, raw credentials, or personal identifiers.',
        diagnostics,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  };
}

function buildHookEntry(eventName, cliPath, stateRoot) {
  const entry = {
    hooks: [
      {
        type: 'command',
        command: hookCommand(eventName, cliPath, stateRoot),
        statusMessage: statusMessage(eventName),
      },
    ],
  };
  if (eventName === 'SessionStart') {
    entry.matcher = 'startup|resume';
  }
  if (eventName === 'PreToolUse') {
    entry.matcher = 'Bash';
  }
  if (eventName === 'Stop') {
    entry.hooks[0].timeout = 30;
  }
  return entry;
}

function removeOwnedEntries(entries) {
  return entries.filter((entry) => !entryHasOwnerCommand(entry));
}

function entryHasOwnerCommand(entry) {
  return (entry.hooks || []).some((hook) => hook.command?.includes(OWNER));
}

function entryHasOwnedCommand(entry, cliPath) {
  return (entry.hooks || []).some((hook) => hook.command?.includes(`"${cliPath}"`) && hook.command?.includes(OWNER));
}

function extractStateRootFromEntry(entry) {
  const command = entry?.hooks?.find((hook) => hook.command?.includes(OWNER))?.command || '';
  return command.match(/OH_MY_WIKI_HOME="([^"]+)"/)?.[1] || null;
}

function hookCommand(eventName, cliPath, stateRoot) {
  return `OH_MY_WIKI_HOME="${stateRoot}" node "${cliPath}" hook ${eventName} --owner ${OWNER}`;
}

function statusMessage(eventName) {
  if (eventName === 'Stop') {
    return 'OMW recording session stop';
  }
  if (eventName === 'UserPromptSubmit') {
    return 'OMW preparing runtime context';
  }
  return `OMW ${eventName}`;
}

async function enableCodexHooksFeature(configPath) {
  const current = (await pathExists(configPath)) ? await readFile(configPath, 'utf8') : '';
  const lines = current.split(/\r?\n/);
  const out = [];
  let inFeatures = false;
  let sawFeatures = false;
  let wroteFlag = false;

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (inFeatures && !wroteFlag) {
        out.push('codex_hooks = true');
        wroteFlag = true;
      }
      inFeatures = /^\s*\[features\]\s*$/.test(line);
      sawFeatures ||= inFeatures;
      out.push(line);
      continue;
    }
    if (inFeatures && /^\s*codex_hooks\s*=/.test(line)) {
      out.push('codex_hooks = true');
      wroteFlag = true;
      continue;
    }
    out.push(line);
  }
  if (inFeatures && !wroteFlag) {
    out.push('codex_hooks = true');
  }
  if (!sawFeatures) {
    if (out.length > 0 && out[out.length - 1] !== '') {
      out.push('');
    }
    out.push('[features]');
    out.push('codex_hooks = true');
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${out.join('\n').replace(/\n+$/, '')}\n`);
}

async function codexHooksFeatureEnabled(configPath) {
  if (!(await pathExists(configPath))) {
    return false;
  }
  const lines = (await readFile(configPath, 'utf8')).split(/\r?\n/);
  let inFeatures = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inFeatures = /^\s*\[features\]\s*$/.test(line);
      continue;
    }
    if (inFeatures && /^\s*codex_hooks\s*=\s*true\s*$/.test(line)) {
      return true;
    }
  }
  return false;
}

function parseHookPayload(stdinText) {
  if (!stdinText?.trim()) {
    return {};
  }
  try {
    return JSON.parse(stdinText);
  } catch {
    return {};
  }
}
