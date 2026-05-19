import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStateDirs } from '../../runtime/state.js';
import { readJsonFile } from '../../utils/fs.js';
import { readConfig } from '../../config/config.js';
import { captureRawNote } from '../../wiki/capture.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const OWNER = 'oh-my-wiki';

export function defaultClaudeHome(input) {
  return input || process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

export function defaultCliPath() {
  return fileURLToPath(new URL('../../cli/omw.js', import.meta.url));
}

export async function installClaudeHooks({ claudeHome, cliPath = defaultCliPath() }) {
  const home = defaultClaudeHome(claudeHome);
  const dirs = await ensureStateDirs();
  await mkdir(home, { recursive: true });
  const settingsPath = path.join(home, 'settings.json');
  const settings = (await readJsonFile(settingsPath, { hooks: {} })) || { hooks: {} };
  settings.hooks ||= {};

  for (const eventName of EVENTS) {
    const entries = settings.hooks[eventName] || [];
    settings.hooks[eventName] = [
      ...removeOwnedEntries(entries),
      buildHookEntry(eventName, cliPath, dirs.root),
    ];
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return claudeHookStatus({ claudeHome: home, cliPath });
}

export async function uninstallClaudeHooks({ claudeHome, cliPath = defaultCliPath() }) {
  const home = defaultClaudeHome(claudeHome);
  const settingsPath = path.join(home, 'settings.json');
  const settings = (await readJsonFile(settingsPath, { hooks: {} })) || { hooks: {} };
  settings.hooks ||= {};

  for (const eventName of EVENTS) {
    settings.hooks[eventName] = removeOwnedEntries(settings.hooks[eventName] || []);
  }

  await mkdir(home, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return claudeHookStatus({ claudeHome: home, cliPath });
}

export async function claudeHookStatus({ claudeHome, cliPath = defaultCliPath() }) {
  const home = defaultClaudeHome(claudeHome);
  const dirs = await ensureStateDirs();
  const settingsPath = path.join(home, 'settings.json');
  const settings = (await readJsonFile(settingsPath, { hooks: {} })) || { hooks: {} };
  const status = {
    claudeHome: home,
    settingsPath,
    cliPath,
    events: {},
  };

  for (const eventName of EVENTS) {
    const entries = settings.hooks?.[eventName] || [];
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

export async function handleClaudeHook(eventName, stdinText) {
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
  const eventWrite = await recordEventBestEffort(eventRecord);
  await captureHookRawBestEffort(eventName, eventRecord, payload, 'claude-code');
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

async function recordEventBestEffort(eventRecord) {
  try {
    const dirs = await ensureStateDirs();
    const eventPath = path.join(dirs.eventsDir, `${Date.now()}-claude-${eventRecord.eventName}.json`);
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
        'OMW is active for this Claude Code session.',
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
      },
    ],
  };
  if (eventName === 'SessionStart') {
    entry.matcher = 'startup|resume';
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
  return `OH_MY_WIKI_HOME="${stateRoot}" node "${cliPath}" claude-hook ${eventName} --owner ${OWNER}`;
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
