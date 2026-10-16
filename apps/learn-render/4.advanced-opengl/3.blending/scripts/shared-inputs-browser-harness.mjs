import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DIAGNOSTIC_LIMIT = 64 * 1024;

export function parseViteOrigin(output) {
  const match = stripVTControlCharacters(output).match(/https?:\/\/127\.0\.0\.1:(\d+)(?!\d)/u);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}`;
}

function hasTargetShaderPath(pathname, targetPath) {
  return pathname === `/${targetPath}` || pathname.endsWith(`/${targetPath}`);
}

export function isTargetShaderUrl(url, targetPath = 'alpha-test.wgsl') {
  try {
    return hasTargetShaderPath(new URL(url).pathname, targetPath);
  } catch {
    return false;
  }
}

export function isAlphaShaderReady(response, targetPath = 'alpha-test.wgsl') {
  if (!response || response.ok !== true || response.status < 200 || response.status >= 300) return false;
  return isTargetShaderUrl(response.url, targetPath);
}

export function isTargetViteHmrUpdate(payload, targetPath = 'alpha-test.wgsl') {
  let frame;
  try {
    frame = JSON.parse(payload);
  } catch {
    return false;
  }
  if (frame?.type !== 'update' || !Array.isArray(frame.updates)) return false;
  return frame.updates.some((update) =>
    [update?.path, update?.acceptedPath].some((path) =>
      typeof path === 'string' && (path === targetPath || path.endsWith(`/${targetPath}`)),
    ),
  );
}

export class ProbeError extends Error {
  constructor(stage, url, expected, actual, hint, detail = '') {
    super(`${stage}: ${detail || `expected ${expected}, got ${actual}`} (${url})`);
    this.name = 'ProbeError';
    this.stage = stage;
    this.url = url;
    this.expected = expected;
    this.actual = actual;
    this.hint = hint;
    this.detail = detail;
  }
}

export function probeFailureRecord(error) {
  if (!(error instanceof ProbeError)) return null;
  return {
    code: `shared-input-browser-${error.stage}`,
    stage: error.stage,
    url: error.url,
    expected: error.expected,
    actual: error.actual,
    hint: error.hint,
    detail: error.detail,
  };
}

export function assertApplicationBootstrap(errors, url) {
  const failures = errors.filter((error) => /createApp failed|app\.onError|no usable backend/i.test(error));
  if (failures.length > 0) {
    throw new ProbeError(
      'application-bootstrap',
      url,
      'the application to initialize without a structured runtime error',
      failures.join('\n'),
      'Inspect the browser error and repair the application or shader manifest before accepting preview output.',
    );
  }
}

export async function pollHttpReady(url, options = {}) {
  const {
    deadlineMs = 30_000,
    intervalMs = 100,
    fetchImpl = globalThis.fetch,
    stage = 'preview-readiness',
  } = options;
  const deadline = Date.now() + deadlineMs;
  let actual = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      actual = response.status;
      if (response.ok) return response;
    } catch (error) {
      actual = error instanceof Error ? error.message : String(error);
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new ProbeError(stage, url, 'HTTP 2xx before deadline', actual, 'Check the server root/base and verify HTTP readiness rather than stdout markers.');
}

export async function startViteServer({ mode, root, base = '/blending/', port = 0 }) {
  const viteCli = fileURLToPath(new URL('./cli.js', import.meta.resolve('vite')));
  const command = mode === 'preview' ? [viteCli, 'preview'] : [viteCli];
  command.push('--host', '127.0.0.1', '--port', String(port), '--strictPort', 'false', '--base', base);
  const childEnv = {
    ...process.env,
    ...(mode === 'dev' ? { FORGEAX_SHARED_INPUTS_HMR_POLLING: '1' } : {}),
  };
  const child = spawn(process.execPath, command, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = (chunk) => {
    if (output.length >= DIAGNOSTIC_LIMIT) return;
    output += chunk.toString().slice(0, DIAGNOSTIC_LIMIT - output.length);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const disposeOutput = () => {
    child.stdout.off('data', capture);
    child.stderr.off('data', capture);
  };
  try {
    const origin = await new Promise((resolve, reject) => {
      let settled = false;
      // A cold dev server has to scan and optimize the full Engine dependency
      // graph before it prints its address.  On CI and on a fresh checkout that
      // regularly exceeds the old 15 s probe deadline even though the server
      // becomes healthy immediately afterwards.  Keep the deadline bounded but
      // allow callers to tighten/extend it for their environment.
      const startTimeoutMs = Number(process.env.FORGEAX_VITE_START_TIMEOUT_MS ?? 30_000);
      const timer = setTimeout(() => settle(reject, new Error(`Vite ${mode} child did not publish an address: ${output}`)), startTimeoutMs);
      const removeReadinessListeners = () => {
        child.stdout.off('data', onOutput);
        child.stderr.off('data', onOutput);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeReadinessListeners();
        callback(value);
      };
      const onOutput = () => {
        const origin = parseViteOrigin(output);
        if (origin) settle(resolve, origin);
      };
      const onError = (error) => settle(reject, error);
      const onExit = (code, signal) => settle(reject, new Error(`Vite ${mode} child exited before readiness: code=${code} signal=${signal} output=${output}`));
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);
      child.once('error', onError);
      child.once('exit', onExit);
      onOutput();
    });
    return { process: child, origin, disposeOutput, diagnosticOutput: () => output };
  } catch (error) {
    await reapChild(child, 5_000);
    disposeOutput();
    throw error;
  }
}

async function reapChild(child, timeoutMs) {
  if (!child?.kill) return;
  const waitForExit = (limitMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        child.off('exit', done);
        child.off('error', done);
        resolve();
      };
      timer = setTimeout(done, limitMs);
      child.once('exit', done);
      child.once('error', done);
    });
  };
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitForExit(timeoutMs);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(1_000);
}

export async function closeServer(resource, timeoutMs = 5_000) {
  if (!resource) return;
  const child = resource.process;
  if (child?.kill) {
    await reapChild(child, timeoutMs);
    resource.disposeOutput?.();
    return;
  }
  const close = resource.close?.bind(resource);
  if (!close) return;
  // Vite's dev server retains HMR WebSockets. Stop those connections before
  // awaiting its close promise: otherwise a browser probe can leave CI waiting
  // indefinitely for the peer that the server itself is meant to terminate.
  resource.ws?.close?.();
  resource.httpServer?.closeAllConnections?.();
  resource.httpServer?.closeIdleConnections?.();
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('server close timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    resource.httpServer?.close?.();
  }
}

export async function withServerLifecycle(serverPromise, callback) {
  const resource = await serverPromise;
  try {
    return await callback(resource);
  } finally {
    await closeServer(resource);
  }
}

export async function withRestoredFile(path, callback) {
  const original = await readFile(path);
  try {
    return await callback(original);
  } finally {
    await writeFile(path, original);
  }
}
