#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createOwnedProcessGroupStopper } from '../../apps/shared/scripts/rhi-debug-process.mjs';
import { withLocalGpuLease } from './local-gpu-lease.mjs';

let windowsShell;
function repositoryShell() {
  if (process.platform !== 'win32') return true;
  if (windowsShell) return windowsShell;
  const gitExecPath = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const bash = resolve(gitExecPath, '../../..', 'bin/bash.exe');
  if (!existsSync(bash)) throw new Error(`repository shell commands require Git Bash: ${bash}`);
  windowsShell = bash;
  return windowsShell;
}

const retryPatterns = Object.freeze({
  vitest: [
    /Device was destroyed/,
    /Browser connection was closed/,
    /rpc is closed/,
    /A valid external Instance reference no longer exists/,
    // Vitest browser groups share Vite's generated optimize-deps directory.
    // A dependency-set change between isolated groups can invalidate one
    // generated module while the next group is importing it. Retry this
    // exact cache-race signature once; real import and assertion failures
    // remain hard failures.
    /Pre-transform error: The file does not exist at "[^"\n]+\/node_modules\/\.vite\/vitest\/[^"\n]+\/deps\/[^"\n]+\.js" which is in the optimize deps directory/,
    /bootstrap inconclusive within \d+s[\s\S]*runner instability, rerun/,
    /ForgeAX linear HDR observation failed: observation-unavailable/,
    // Headed Chrome Beta + lavapipe can occasionally stall an isolated
    // advanced-lighting WebGPU bootstrap until its bounded 60s test budget.
    // Retry only this exact gate timeout; assertions and other test timeouts
    // remain hard failures on the first attempt.
    /apps\/learn-render\/5\.advanced-lighting\/6\.hdr\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*Test timed out in 60000ms\./,
    // The gate's own bounded bootstrap timer fires at 55s (the remaining 5s
    // are reserved for error observation), so Vitest reports the structured
    // bootstrap timeout instead of its generic 60s timeout. Keep the retry
    // scoped to the HDR catalog-resolution stall; a repeated failure remains
    // a hard red result on the second attempt.
    /apps\/learn-render\/5\.advanced-lighting\/6\.hdr\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*\[learn-render bootstrap\] timed out after \d+ms; stage=hdr\.assets\.catalog\.resolve\.start\b/,
    // Bloom's headed first bootstrap can miss its own bounded readiness
    // deadline on the same cold Chrome Beta + lavapipe runner. Retry only
    // this exact gate/stage pair; assertion failures and other Bloom stages
    // remain hard failures on the first attempt.
    /apps\/learn-render\/5\.advanced-lighting\/7\.bloom\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*\[learn-render bootstrap\] timed out after \d+ms; stage=waitForLearnRenderTestBootstrap\b/,
    // Render-target reflection can hit the same runner-level cold WebGPU
    // startup stall after neighboring browser groups close. The failing
    // signal is the gate's bounded wait stage with no SUT assertion; retry
    // only this exact demo/stage pair and keep a repeated failure red.
    /apps\/learn-render\/6\.pbr\/4\.render-target-reflection\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*\[learn-render bootstrap\] timed out after \d+ms; stage=waitForLearnRenderTestBootstrap\b/,
    // The same isolated reflection gate can reach its explicit 60s Vitest
    // budget before the bounded bootstrap timer fires. Retry only this exact
    // test timeout; a second timeout remains a hard failure.
    /apps\/learn-render\/6\.pbr\/4\.render-target-reflection\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*Test timed out in 60000ms\./,
    // SSAO's first lazy backpack request can observe a transient producer
    // session failure (HTTP 503) while the isolated Pack session is still
    // publishing its startup snapshot. Retry only that exact demo/request
    // shape; a real 422 importer failure and every other asset error remain
    // hard failures.
    /apps\/learn-render\/5\.advanced-lighting\/9\.ssao\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*import failed for [^\n]+ \(HTTP 503\): import-failed[\s\S]*asset-not-imported/,
    // SSAO has the same headed Chrome Beta + lavapipe cold-start shape as
    // deferred shading, but its asset bootstrap can cross the bounded 60s
    // budget on a contended container. Retry only this exact gate timeout;
    // a second timeout remains a hard failure.
    /apps\/learn-render\/5\.advanced-lighting\/9\.ssao\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*Test timed out in 60000ms\./,
    // The PBR IBL irradiance demo has the same cold WebGPU startup shape as
    // HDR on a contended headed lavapipe runner. Retry only this exact gate
    // timeout; the second attempt remains a hard failure.
    /apps\/learn-render\/6\.pbr\/2\.ibl-irradiance\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*Test timed out in 60000ms\./,
    // The PBR IBL specular demo can stall while its split-sum resources are
    // admitted after a neighboring browser process releases a device. Retry
    // only this exact bootstrap wait; a repeated timeout remains hard red.
    /apps\/learn-render\/6\.pbr\/3\.ibl-specular\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*\[learn-render bootstrap\] timed out after \d+ms; stage=waitForLearnRenderTestBootstrap\b/,
    // Engine Worker startup has a bounded 10s handshake deadline.  On a
    // loaded self-hosted browser runner the worker-resize probe can miss that
    // deadline before any frame work starts; retry only that exact probe and
    // handshake phase so real startup regressions remain red.
    /packages\/app\/__tests__\/worker-resize\.browser\.test\.ts[\s\S]*app-execution-deadline-exceeded:[\s\S]*phase=handshake\b/,
    // The browser-to-Node WebSocket contract crosses the Vitest command
    // boundary. Retry only its one observed close-event timeout; a different
    // WebSocket test, event, or assertion remains a hard failure.
    /packages\/net-websocket\/__tests__\/endpoint-contract\.browser\.test\.ts[\s\S]*emits peer-disconnected event on close[\s\S]*Timed out waiting for 1 peer-disconnected event\(s\)/,
    // The connector replacement contract crosses the same browser command
    // boundary, and a contended headed runner can delay its listener close
    // event past the bounded poll window. Retry only this exact replacement
    // case; a different connector assertion remains a hard failure.
    /packages\/net-websocket\/__tests__\/connector-contract\.browser\.test\.ts[\s\S]*delivers ordered bytes and exposes a new PeerId after replacement[\s\S]*Timed out waiting for listener peer-disconnected event/,
  ],
  'vitest-dawn': [
    // A loaded native Dawn runner can terminate one Vitest worker after the
    // assertions have passed. Retry only this worker-fork signature; test
    // failures, adapter errors, and other process exits remain red.
    /\[vitest-pool\]: Worker forks emitted error[\s\S]*Worker exited unexpectedly/,
  ],
  'rhi-debug': [
    // The CSM carrier can hit a runner-level adapter acquisition stall before
    // the app registers its capture hooks. Retry only this exact signature in
    // the dedicated CSM job; a second attempt remains a hard failure.
    /\[learn-render 5\.3\.3 csm\][\s\S]*capture hook readiness timed out after 90000ms[\s\S]*rendererBootstrap[\s\S]*"name":"adapter-request-start"[\s\S]*"shaderManifest":null[\s\S]*captureHooks[\s\S]*"__prepareCsmCapture":false[\s\S]*"__captureCsm":false/,
    // A cold Vite dependency scan can hold the MSAA app navigation past its
    // 30s budget on a loaded runner. Retry only this exact app/script timeout;
    // OFF/ON capture and P2 assertions still run, and a second timeout stays red.
    /\$ pnpm --filter @forgeax\/engine-rhi-debug build && node scripts\/smoke-browser-pair\.mjs[\s\S]*\[optimizer\] scanning dependencies\.\.\.[\s\S]*page\.goto: Timeout 30000ms exceeded\.[\s\S]*waiting until "domcontentloaded"[\s\S]*apps\/learn-render\/4\.advanced-opengl\/10\.anti-aliasing-msaa\/scripts\/smoke-browser-pair\.mjs:\d+:\d+/,
    /capture (?:off|on) failed before materializing v7 tape:[\s\S]*"code":"capture-timeout"/,
    /capture\/live-readback threw:[\s\S]*"code":"capture-snapshot-failed"[\s\S]*"stage":"snapshot"[\s\S]*A valid external Instance reference no longer exists/,
    /transient WebGPU external Instance loss/,
  ],
  benchmark: [
    /\[multithreaded benchmark\] browser readiness timeout; runner instability:/,
    /\[multithreaded benchmark\] runner pause detected; runner instability:/,
    // A cold/shared browser can lose its first frame deadline without a page
    // error. Retry only that structured frame fault; a repeated fault still
    // fails the required benchmark on the second attempt.
    /\[multithreaded benchmark\] browser readiness failed:[\s\S]*"phase":"frame"[\s\S]*"pageErrors":\[\]/,
  ],
  'multithread-smoke': [
    // A shared-tier smoke can miss its first frame deadline on a cold or
    // contended runner without producing a Playwright page error. Retry only
    // this structured runtime fault; the second attempt remains required and
    // all smoke assertions stay unchanged.
    /apps\/hello\/multithreaded-execution\/scripts\/smoke-browser\.mjs:[\s\S]*"code":"app-execution-deadline-exceeded"[\s\S]*"phase":"frame"[\s\S]*"timeoutMs":5000[\s\S]*errors=;/,
  ],
});

export function isRetryableOutput(mode, output) {
  const patterns = retryPatterns[mode];
  if (!patterns) throw new Error(`unknown browser gate retry mode: ${mode}`);
  return patterns.some((pattern) => pattern.test(output));
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator !== 1 || separator === argv.length - 1) {
    throw new Error(
      'usage: run-browser-gate-with-retry.mjs --mode=<vitest|vitest-dawn|benchmark|multithread-smoke|rhi-debug> -- <command>',
    );
  }
  const modeArgument = argv[0];
  if (!modeArgument.startsWith('--mode=')) {
    throw new Error(
      'the retry mode must use --mode=<vitest|vitest-dawn|benchmark|multithread-smoke|rhi-debug>',
    );
  }
  const mode = modeArgument.slice('--mode='.length);
  if (!retryPatterns[mode]) throw new Error(`unknown browser gate retry mode: ${mode}`);
  return { mode, command: argv.slice(separator + 1) };
}

const DEFAULT_TIMEOUT_GRACE_MS = 2_000;

/**
 * Run one browser-gate child with an optional bounded lifetime.
 *
 * Browser/Vite children can create their own descendants (Chromium, a Vite
 * optimizer, or a WebSocket fixture).  On Unix a detached child is therefore
 * placed in a private process group so a timeout can reclaim the whole
 * ownership tree without signalling the caller.  The Windows fallback keeps
 * the existing direct-child semantics because negative process-group signals
 * are not available there.
 */
export function runBrowserCommand(
  command,
  {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs,
    timeoutGraceMs = DEFAULT_TIMEOUT_GRACE_MS,
    label = Array.isArray(command) ? command[0] : 'smoke',
    gpuLease = false,
    excludeGpuLeaseQueue = false,
  } = {},
) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  if (!Number.isFinite(timeoutGraceMs) || timeoutGraceMs <= 0) {
    throw new Error(`timeoutGraceMs must be a positive finite number, got ${timeoutGraceMs}`);
  }
  if (gpuLease && env.FORGEAX_LOCAL_GPU_LEASE === '1' && env.FORGEAX_LOCAL_GPU_LEASE_HELD !== '1')
    return withLocalGpuLease(
      () =>
        runBrowserCommand(command, {
          cwd,
          env: { ...env, FORGEAX_LOCAL_GPU_LEASE_HELD: '1' },
          timeoutMs,
          timeoutGraceMs,
          label,
        }),
      { label },
    );
  // Roster commands are repository-owned shell scripts; argv callers bypass the shell.
  const shell = typeof command === 'string';
  const [program, ...args] = shell ? [command] : command;
  return new Promise((finish) => {
    let output = '';
    let childOutputTail = '';
    let lastOutputAt = Date.now();
    let settled = false;
    let timedOut = false;
    let cancelled = null;
    let timeoutTimer;
    const startedAt = Date.now();
    // A coordinator owns the existing bounded groups without holding their
    // lease. Only intervals with queued groups and no executing group are
    // excluded; concurrent execution and all CPU preparation still count.
    const leaseStates = new Map();
    let queuePausedAt;
    let excludedGpuQueueMs = 0;
    let queueLineTail = '';
    const excludedQueueTime = () =>
      excludedGpuQueueMs + (queuePausedAt === undefined ? 0 : Date.now() - queuePausedAt);
    const armTimeout = () => {
      clearTimeout(timeoutTimer);
      if (timeoutMs === undefined || settled || timedOut || queuePausedAt !== undefined) return;
      const remaining = timeoutMs - (Date.now() - startedAt - excludedQueueTime());
      timeoutTimer = setTimeout(
        () => {
          if (settled || queuePausedAt !== undefined) return;
          // Native timers may deliver early; keep the original accounted deadline.
          if (Date.now() - startedAt - excludedQueueTime() < timeoutMs) {
            armTimeout();
            return;
          }
          timedOut = true;
          diagnostic(
            `timeout label=${label} pid=${child.pid} elapsedMs=${Date.now() - startedAt} timeoutMs=${timeoutMs}; reclaiming private process group`,
          );
          void cleanup().then(() => settle(child.exitCode, child.signalCode));
        },
        Math.max(0, remaining),
      );
    };
    const observeLeaseQueue = (text) => {
      if (!excludeGpuLeaseQueue) return;
      queueLineTail += text;
      const lines = queueLineTail.split('\n');
      queueLineTail = lines.pop().slice(-8192);
      for (const line of lines) {
        const event =
          /^\[local-gpu\] (queued|acquired|released) label=(.*?) (?:lock=|queueMs=)/.exec(line);
        if (!event) continue;
        if (queuePausedAt !== undefined) {
          excludedGpuQueueMs += Date.now() - queuePausedAt;
          queuePausedAt = undefined;
        }
        if (event[1] === 'released') leaseStates.delete(event[2]);
        else leaseStates.set(event[2], event[1]);
        if (leaseStates.size > 0 && ![...leaseStates.values()].includes('acquired'))
          queuePausedAt = Date.now();
        armTimeout();
      }
    };
    const child = spawn(program, args, {
      cwd,
      env,
      shell: shell ? repositoryShell() : false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stop =
      child.pid === undefined
        ? null
        : createOwnedProcessGroupStopper(child, {
            graceMs: timeoutGraceMs,
          });
    const diagnostic = (message) => {
      const text = `[browser-gate] ${message}\n`;
      output += text;
      process.stderr.write(text);
    };
    const forward = (chunk, destination) => {
      const text = String(chunk);
      if (destination === process.stderr) observeLeaseQueue(text);
      lastOutputAt = Date.now();
      childOutputTail = (childOutputTail + text).slice(-8192);
      output += text;
      destination.write(text);
    };
    // This promise belongs to the complete group, not just its leader. In
    // particular, a leader exit must never cancel TERM-to-KILL escalation.
    let cleanupPromise;
    const cleanup = () => {
      cleanupPromise ??= (stop ? stop() : Promise.resolve({ kind: 'alreadyGone' })).catch(
        (error) => ({ kind: 'failed', error: error.message }),
      );
      return cleanupPromise;
    };
    const onInterrupt = (signal) => {
      cancelled ??= signal;
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      diagnostic(`cancelled label=${label} signal=${signal}; reclaiming private process group`);
      void cleanup().then(() => settle(child.exitCode, child.signalCode));
    };
    const onSigint = () => onInterrupt('SIGINT');
    const onSigterm = () => onInterrupt('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const settle = async (exitCode, signal, startError) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (startError) diagnostic(`failed to start ${label}: ${startError.message}`);
      const cleanupResult = await cleanup();
      // The stopper waits for stdio close as well as group exit. If that
      // proof fails, terminate our streams and return a hard failure.
      if (cleanupResult.kind === 'failed') {
        diagnostic(`cleanup failed label=${label}: ${cleanupResult.error}`);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      const result = {
        status: cancelled
          ? cancelled === 'SIGINT'
            ? 130
            : 143
          : timedOut
            ? 124
            : cleanupResult.kind === 'failed'
              ? 1
              : (exitCode ?? 1),
        exitCode,
        signal,
        timedOut,
        cancelled,
        pid: child.pid,
        elapsedMs: Date.now() - startedAt,
        ...(excludeGpuLeaseQueue ? { excludedGpuQueueMs: excludedQueueTime() } : {}),
        cleanup: cleanupResult,
      };
      const lastOutputAgeMs = Date.now() - lastOutputAt;
      result.failure =
        result.status === 0
          ? null
          : [
              `label=${label}`,
              startError
                ? `start failed: ${startError.code ?? 'unknown'}: ${startError.message}`
                : cancelled
                  ? `cancelled by ${cancelled}`
                  : timedOut
                    ? `command deadline exceeded (${timeoutMs} ms)`
                    : signal
                      ? `child terminated by ${signal}; signal alone does not establish the cause`
                      : cleanupResult.kind === 'failed'
                        ? `process cleanup failed: ${cleanupResult.error}`
                        : `child exited with code ${exitCode}`,
              `status=${result.status} signal=${signal ?? 'none'} elapsedMs=${result.elapsedMs} lastOutputAgeMs=${lastOutputAgeMs} cleanup=${JSON.stringify(cleanupResult)}`,
              childOutputTail.trim()
                ? `last child output:\n${stripVTControlCharacters(childOutputTail)}`
                : 'No child stdout/stderr was captured; inspect command startup and runner diagnostics.',
            ].join('\n');
      diagnostic(
        `process-result ${JSON.stringify({ label, ...result, failure: undefined, lastOutputAgeMs })}`,
      );
      if (result.failure !== null) {
        diagnostic(`failure-detail ${result.failure}`);
        if (env.GITHUB_ACTIONS === 'true') {
          // This is an attempt, which may be retried or trigger source recovery.
          // Only the caller decides the terminal gate result.
          const annotation = result.failure
            .slice(0, 2048)
            .replaceAll('%', '%25')
            .replaceAll('\r', '%0D')
            .replaceAll('\n', '%0A');
          process.stderr.write(`::warning title=CI child attempt failed::${annotation}\n`);
          if (env.GITHUB_STEP_SUMMARY) {
            const detail = `command=${JSON.stringify(command)}\ncwd=${cwd}\n${result.failure}`;
            const fence = '`'.repeat(
              Math.max(3, ...(detail.match(/`+/g) ?? []).map((part) => part.length + 1)),
            );
            try {
              appendFileSync(
                env.GITHUB_STEP_SUMMARY,
                `\n### CI child attempt failed\n\n${fence}text\n${detail}\n${fence}\n`,
              );
            } catch (error) {
              diagnostic(`could not write failure summary: ${error.message}`);
            }
          }
        }
      }
      finish({ ...result, output });
    };
    // Keep command metadata out of result.output: retry classification consumes
    // child diagnostics, never literals embedded in the command arguments.
    process.stderr.write(
      `[browser-gate] process-start ${JSON.stringify({ label, command, cwd, pid: child.pid, timeoutMs: timeoutMs ?? null })}\n`,
    );
    child.stdout.on('data', (chunk) => forward(chunk, process.stdout));
    child.stderr.on('data', (chunk) => forward(chunk, process.stderr));
    child.once('error', (error) => {
      void settle(null, null, error);
    });
    child.once('exit', (status, signal) => {
      void settle(status, signal);
    });
    armTimeout();
  });
}

async function main(argv) {
  const { mode, command } = parseArgs(argv);
  const first = await runBrowserCommand(command);
  if (first.status === 0) return;
  if (first.cancelled || !isRetryableOutput(mode, first.output)) {
    process.exitCode = first.status;
    return;
  }

  process.stderr.write(
    `::warning::${mode} browser gate matched a retry signature (cause unclassified); retrying once with a fresh process\n`,
  );
  const second = await runBrowserCommand(command);
  process.exitCode = second.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[browser-gate] ${error.message}\n`);
    process.exitCode = 1;
  });
}
