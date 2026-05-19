import { spawn, spawnSync } from 'node:child_process';
import { SETUP_COMMAND_HINT } from '../config/config.js';
import { ensureStateDirs } from '../runtime/state.js';

export function checkCommandAvailable(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
  });

  if (result.error?.code === 'ENOENT') {
    return {
      available: false,
      command,
      reason: 'not_found',
    };
  }

  if (result.error) {
    return {
      available: false,
      command,
      reason: result.error.code || result.error.message,
    };
  }

  return {
    available: true,
    command,
    version: firstNonEmptyLine(`${result.stdout || ''}\n${result.stderr || ''}`),
    status: result.status,
  };
}

export async function runWrappedCommand({ command, args, config, onExit, onSignal }) {
  const dirs = await ensureStateDirs();
  const env = {
    ...process.env,
    OH_MY_WIKI_ACTIVE: '1',
    OH_MY_WIKI_CONFIGURED: config ? '1' : '0',
    OH_MY_WIKI_HOME: dirs.root,
  };

  return new Promise((resolve) => {
    const signalHandlers = new Map();
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers.entries()) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
    };
    let finished = false;
    const safeCallback = (callback, label, value) => {
      if (!callback) return;
      try {
        callback(value);
      } catch (error) {
        console.error(`[omw] ${label} callback failed: ${error.message}`);
      }
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      removeSignalHandlers();
      safeCallback(onExit, 'exit');
      resolve(code);
    };
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
    });

    if (onSignal) {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
          safeCallback(onSignal, 'signal', signal);
          if (!child.killed) child.kill(signal);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        console.error(renderMissingRuntimeMessage(command));
      } else {
        console.error(`Failed to execute ${command}: ${error.message}`);
      }
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? signalExitCode(signal)));
  });
}

export function renderMissingOmxMessage(command) {
  return renderMissingRuntimeMessage(command);
}

export function renderMissingRuntimeMessage(command) {
  if (String(command).includes('omc')) {
    return `OMC command not found: ${command}

OMW core features still work without OMC:
- Claude Code hooks
- local wiki/config diagnostics
- OMX/OMC wrapper commands

Install or configure oh-my-claudecode only if you want OMC workflows:
  omw setup --omc-bin <path-to-omc>`;
  }

  return `OMX command not found: ${command}

OMW core features still work without OMX:
- Codex App/CLI hooks
- local wiki/config diagnostics
- OMX/OMC wrapper commands

Install OMX only if you want OMX workflows:
  npm install -g oh-my-codex

Or configure a custom path:
  ${SETUP_COMMAND_HINT} --omx-bin <path-to-omx>`;
}

function firstNonEmptyLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}
