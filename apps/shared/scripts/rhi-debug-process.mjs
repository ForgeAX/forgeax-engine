import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_GRACE_MS = 2000;
const DEFAULT_POLL_MS = 25;
const MIN_SETTLE_MS = 1000;

function ownedPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`refusing to manage invalid owned process-group leader pid: ${String(pid)}`);
  }
  return pid;
}

function processGroupAlive(pid) {
  ownedPid(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForChildExit(exitPromise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForGroupGone(pid, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
  return true;
}

function signalOwnedProcess(child, pid, signal) {
  ownedPid(pid);
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
}

/**
 * Create an idempotent cleanup operation for a detached child process group.
 * The returned stopper owns exactly the PID captured at creation time.
 */
export function createOwnedProcessGroupStopper(child, options = {}) {
  const pid = ownedPid(child?.pid);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  // TERM grace controls escalation, not OS reaping or inherited-pipe close.
  // Keep production's two-second default, and allow short-grace callers to
  // observe completion on busy hosts without delaying the SIGKILL itself.
  const settleMs = Math.max(graceMs, MIN_SETTLE_MS);
  const incomplete = (phase) => new Error(
    `owned process group ${pid} cleanup incomplete: phase=${phase} waitMs=${settleMs} ` +
    `exitCode=${child.exitCode} signal=${child.signalCode}; ` +
    (phase === 'group-exit'
      ? 'group remains visible after SIGKILL; inspect live or unreaped members'
      : 'child close event missing; inspect inherited stdout/stderr holders'),
  );
  const exitPromise = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const onExit = () => {
      child.off('close', onExit);
      child.off('error', onExit);
      resolve();
    };
    child.once('close', onExit);
    child.once('error', onExit);
  });

  let stopPromise;
  return async function stopOwnedProcessGroup() {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = (async () => {
      if (process.platform === 'win32') {
        // Retire descendants while the owned leader still identifies its tree.
        // Killing only pnpm leaves its Vite server and bound port alive.
        if (child.exitCode === null && child.signalCode === null) {
          const result = spawnSync(
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
            ['/PID', String(pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: Math.max(2000, settleMs) },
          );
          if (!(await waitForChildExit(exitPromise, settleMs))) {
            throw result.error ?? incomplete('group-exit');
          }
          return { kind: 'sigkill' };
        }
        if (!(await waitForChildExit(exitPromise, settleMs))) throw incomplete('stdio-close');
        return { kind: 'alreadyGone' };
      }
      if (!processGroupAlive(pid)) {
        if (!(await waitForChildExit(exitPromise, settleMs))) {
          throw incomplete('stdio-close');
        }
        return { kind: 'alreadyGone' };
      }

      signalOwnedProcess(child, pid, 'SIGTERM');
      let gone = await waitForGroupGone(pid, graceMs, pollMs);
      let kind = 'sigterm';
      if (!gone) {
        signalOwnedProcess(child, pid, 'SIGKILL');
        kind = 'sigkill';
        gone = await waitForGroupGone(pid, settleMs, pollMs);
      }
      if (!gone) {
        throw incomplete('group-exit');
      }
      if (!(await waitForChildExit(exitPromise, settleMs))) {
        throw incomplete('stdio-close');
      }
      return { kind };
    })();
    return stopPromise;
  };
}
