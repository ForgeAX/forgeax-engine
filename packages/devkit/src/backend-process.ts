import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHostWebSocketClient } from '@forgeax/engine-host/transport';
import {
  commandContribution,
  isToolCommandContract,
  type ToolContribution,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { WebSocket } from 'ws';
import { backendStateDirectory, processAlive, watchBackendLifetime } from './backend-lifetime.js';
import { logBackendStartup, traceBackendStartup } from './backend-startup.js';
import { backendHeapEnv } from './child-process.js';
import { isValidStartupTimeoutMs } from './project.js';
import { failCommand } from './types.js';

export { backendHeapEnv } from './child-process.js';

export const DEFAULT_BACKEND_STARTUP_TIMEOUT_MS = 120_000;

function canonicalProjectRoot(project: string) {
  const root = resolve(project);
  return existsSync(root) ? realpathSync.native(root) : root;
}

export function resolveBackendStartupTimeoutMs(
  timeoutMs: number | null | undefined,
): number | null {
  const resolved = timeoutMs === undefined ? DEFAULT_BACKEND_STARTUP_TIMEOUT_MS : timeoutMs;
  if (!isValidStartupTimeoutMs(resolved)) {
    throw new TypeError('startupTimeoutMs must be a positive timer-safe integer or null.');
  }
  return resolved;
}

export async function waitForBackendStartup(
  timeoutMs: number | null,
  isReady: () => boolean,
  assertAlive: () => void,
  timeoutError: () => Error,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
  while (deadline === undefined || Date.now() < deadline) {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('Backend startup wait cancelled', 'AbortError');
    if (isReady()) return;
    assertAlive();
    await new Promise((done) => setTimeout(done, 50));
  }
  throw timeoutError();
}

interface BackendState {
  readonly id: string;
  readonly pid: number;
  readonly root: string;
  readonly hostPack?: string;
  readonly viewShell?: boolean;
  readonly lifetime?: 'clients';
  readonly viewUrl?: string;
  readonly phase: 'starting' | 'ready';
  readonly endpoint?: string;
  readonly token?: string;
}

function statePath(root: string): string {
  return join(backendStateDirectory(root), 'session.json');
}

function readState(root: string): BackendState | undefined {
  const path = statePath(root);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BackendState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function waitForResidentReady(
  root: string,
  id: string,
  timeoutMs: number | null,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
  stoppedMessage: string,
): Promise<void> {
  let owner: BackendState | undefined;
  return waitForBackendStartup(
    timeoutMs,
    () => {
      owner = readState(root);
      return owner?.id === id && owner.phase === 'ready';
    },
    () => {
      if (owner?.id !== id || !processAlive(owner.pid)) throw new Error(stoppedMessage);
    },
    () => new Error(timeoutMessage),
    signal,
  );
}

function removeState(root: string, id: string): void {
  if (readState(root)?.id === id) rmSync(statePath(root), { force: true });
}

function writeState(state: BackendState): void {
  const path = statePath(state.root);
  const pending = `${path}.${state.id}.tmp`;
  writeFileSync(pending, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

async function startEarlyViewShell(root: string, hostPack?: string) {
  const candidates = [hostPack === undefined ? root : dirname(hostPack), root];
  let entry: string | undefined;
  for (const candidate of candidates) {
    try {
      entry = createRequire(join(candidate, 'package.json')).resolve('@forgeax/view/static-server');
      break;
    } catch {
      // The View package is resolved from the selected Host Pack first, then the game project.
    }
  }
  if (!entry)
    throw new Error('The selected View Host Pack does not expose its static service entry.');
  const staticRoot = resolve(dirname(entry), '../viewer');
  if (!existsSync(join(staticRoot, 'index.html')))
    throw new Error(`The selected View static build is missing: ${staticRoot}`);
  const module = (await import(pathToFileURL(entry).href)) as {
    startViewerStaticServer(options: { staticRoot: string; waitForBootstrap: boolean }): Promise<{
      readonly viewerUrl: string;
      setBootstrapSource(source: string | URL): void;
      setBootstrapFailure(message: string): void;
      close(): Promise<void>;
    }>;
  };
  return module.startViewerStaticServer({ staticRoot, waitForBootstrap: true });
}

async function request(
  state: BackendState | undefined,
  service: string,
  payload?: unknown,
  timeout = 120_000,
  signal?: AbortSignal,
) {
  if (
    !state ||
    !processAlive(state.pid) ||
    state.phase !== 'ready' ||
    !state.endpoint ||
    !state.token
  ) {
    throw new Error('Engine backend is not ready. Run forgeax backend start first.');
  }
  const url = new URL(state.endpoint);
  url.searchParams.set('token', state.token);
  const socket = new WebSocket(url.href, { handshakeTimeout: 5000 });
  try {
    const transport = await createHostWebSocketClient(socket);
    try {
      return await transport.request(service, payload, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      });
    } finally {
      transport.close();
    }
  } finally {
    socket.terminate();
  }
}

/** Discover the active public owners without starting a backend or mounting a plugin. */
export async function discoverDevKitBackendTools(
  root: string,
): Promise<readonly ToolContribution[]> {
  const state = readState(root);
  if (!state || !processAlive(state.pid) || state.phase !== 'ready') return [];
  const contract = await request(state, 'engine.backend.tool.list', undefined, 5000);
  if (!isToolCommandContract(contract)) throw new TypeError('invalid backend tool contract');
  return contract.commands.map((declaration) =>
    commandContribution(declaration, async () => async (args, context) => {
      const terminal = await runDevKitBackendTool(root, declaration.id, args, context.signal);
      if (terminal.outcome === 'succeeded')
        return { ok: true, value: terminal.result, artifacts: terminal.artifacts };
      if (terminal.outcome === 'failed') return { ok: false, error: terminal.failure };
      return failCommand(
        'tool-run-cancelled',
        'a completed backend operation',
        'Start a fresh request.',
        { reason: 'backend operation cancelled' },
      );
    }),
  );
}

export async function runDevKitBackendTool(
  root: string,
  operation: string,
  args: unknown = {},
  signal?: AbortSignal,
): Promise<ToolTerminal<unknown>> {
  return (await request(
    readState(root),
    'engine.backend.call',
    { operation, args },
    300_000,
    signal,
  )) as ToolTerminal<unknown>;
}

export async function callDevKitBackend(root: string, operation: string, args: unknown = {}) {
  const terminal = await runDevKitBackendTool(root, operation, args);
  if (terminal.outcome === 'failed') {
    const error = new Error(terminal.failure.hint);
    Object.assign(error, terminal.failure);
    throw error;
  }
  return terminal.result;
}

export async function devKitBackendStatus(rootInput: string, signal?: AbortSignal) {
  const root = resolve(rootInput);
  const state = readState(root);
  if (!state || !processAlive(state.pid)) return { root, phase: 'stopped' as const };
  const owner = {
    pid: state.pid,
    ...(state.hostPack === undefined ? {} : { hostPack: state.hostPack }),
  };
  const view = state.viewUrl === undefined ? {} : { viewUrl: state.viewUrl };
  if (state.phase === 'starting') return { root, phase: 'starting', ...owner, ...view };
  try {
    const status = (await request(state, 'engine.backend.status', undefined, 5000, signal)) as {
      readonly root?: unknown;
      readonly phase?: unknown;
      readonly hostPack?: unknown;
    };
    if (
      status.root !== root ||
      status.phase !== 'ready' ||
      (state.hostPack !== undefined && status.hostPack !== state.hostPack)
    )
      throw new Error(
        'The resident backend source identity or root differs from its selected owner state.',
      );
    return { root, phase: 'ready', ...owner, ...view };
  } catch {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('Backend status wait cancelled', 'AbortError');
    return { root, phase: 'unreachable', ...owner };
  }
}

export async function stopDevKitBackend(rootInput: string) {
  const root = resolve(rootInput);
  const state = readState(root);
  if (!state) return { root, phase: 'stopped' };
  if (!processAlive(state.pid)) {
    removeState(root, state.id);
    return { root, phase: 'stopped' };
  }
  await request(state, 'engine.backend.stop', undefined, 5000);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!processAlive(state.pid) || readState(root)?.id !== state.id)
      return { root, phase: 'stopped' };
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(
    `Engine backend is still stopping; inspect ${join(dirname(statePath(root)), 'backend.log')} and backend status.`,
  );
}

export function devKitBackendHostPack(rootInput: string): string | undefined {
  const state = readState(resolve(rootInput));
  return state && processAlive(state.pid) ? state.hostPack : undefined;
}

export async function startDevKitBackend(
  rootInput: string,
  options: {
    readonly hostPack?: string;
    readonly startupTimeoutMs?: number | null;
    readonly signal?: AbortSignal;
    readonly viewShell?: boolean;
    readonly lifetime?: 'clients';
    readonly waitForReady?: boolean;
  } = {},
) {
  if (options.signal?.aborted)
    throw options.signal.reason ?? new DOMException('Backend startup cancelled', 'AbortError');
  const root = resolve(rootInput);
  const hostPack = options.hostPack === undefined ? undefined : realpathSync(options.hostPack);
  const startupTimeoutMs = resolveBackendStartupTimeoutMs(options.startupTimeoutMs);
  const current = readState(root);
  const waitForClaim = (owner: BackendState) =>
    waitForResidentReady(
      root,
      owner.id,
      startupTimeoutMs,
      options.signal,
      `Engine backend startup is still pending after ${startupTimeoutMs}ms; inspect backend status.`,
      'The claimed Engine backend stopped before becoming ready.',
    );
  const reuseBackend = async (current: BackendState) => {
    if (options.lifetime !== current.lifetime)
      throw new Error(
        'Backend lifetime differs from this caller; stop the existing instance before changing its process ownership.',
      );
    if (hostPack !== undefined && current.hostPack !== hostPack)
      throw new Error(
        `Backend already runs with a different host Pack: ${current.hostPack ?? 'none'}`,
      );
    if (
      current.phase === 'starting' &&
      !(options.waitForReady === false && options.viewShell && current.viewUrl)
    )
      await waitForClaim(current);
    return devKitBackendStatus(root, options.signal);
  };
  if (current && processAlive(current.pid)) return reuseBackend(current);
  if (current) removeState(root, current.id);
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const id = randomUUID();
  const initial: BackendState = {
    id,
    root,
    pid: process.pid,
    phase: 'starting',
    ...(hostPack === undefined ? {} : { hostPack }),
    ...(options.viewShell ? { viewShell: true } : {}),
    ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
  };
  const claim = `${path}.${id}.claim`;
  writeFileSync(claim, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  try {
    linkSync(claim, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const owner = readState(root);
      if (owner?.lifetime !== options.lifetime)
        throw new Error('Backend lifetime differs from this caller.');
      if (hostPack !== undefined && owner?.hostPack !== hostPack)
        throw new Error(
          `Backend already starts with a different host Pack: ${owner?.hostPack ?? 'none'}`,
        );
      if (owner?.phase === 'starting') await waitForClaim(owner);
      return devKitBackendStatus(root, options.signal);
    }
    throw error;
  } finally {
    rmSync(claim, { force: true });
  }
  const logPath = join(dirname(path), 'backend.log');
  const log = openSync(logPath, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--__forgeax-backend', root, id],
      {
        detached: true,
        stdio: ['ignore', log, log],
        env: backendHeapEnv(process.env, totalmem(), process.constrainedMemory()),
      },
    );
    logBackendStartup(
      {
        stage: 'daemon-spawn',
        event: 'spawned',
        hostPid: process.pid,
        childPid: child.pid,
        time: new Date().toISOString(),
      },
      log,
    );
  } catch (error) {
    removeState(root, id);
    throw error;
  } finally {
    closeSync(log);
  }
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.unref();
  const shellOnly = options.waitForReady === false && Boolean(options.viewShell);
  await waitForBackendStartup(
    startupTimeoutMs,
    () => {
      const state = readState(root);
      return (
        state?.id === id && (state.phase === 'ready' || (shellOnly && state.viewUrl !== undefined))
      );
    },
    () => {
      if (failure || !child.pid || !processAlive(child.pid)) {
        removeState(root, id);
        const owner = shellOnly ? 'Engine View shell' : 'Engine backend';
        throw failure ?? new Error(`${owner} startup failed; inspect ${logPath}`);
      }
    },
    () =>
      new Error(
        `${shellOnly ? 'Engine View shell is still preparing' : 'Engine backend startup is still pending'} after ${startupTimeoutMs}ms; inspect ${logPath} and backend status.`,
      ),
    options.signal,
  );
  return devKitBackendStatus(root, options.signal);
}

async function requireResidentBackend(
  root: string,
  backend: Awaited<ReturnType<typeof startDevKitBackend>>,
  startupTimeoutMs: number | null | undefined,
  signal: AbortSignal | undefined,
) {
  if (backend.phase === 'starting') {
    const backendId = readState(root)?.id;
    if (!backendId) throw new Error('Engine backend startup ownership disappeared.');
    await waitForResidentReady(
      root,
      backendId,
      resolveBackendStartupTimeoutMs(startupTimeoutMs),
      signal,
      'Engine backend is still preparing; inspect backend status.',
      'Engine backend stopped before its workspace owner became ready.',
    );
    backend = await devKitBackendStatus(root, signal);
  }
  if (backend.phase !== 'ready') throw new Error(`Backend ensure ended in ${backend.phase}`);
  return backend;
}

function viewEnsureFailure(
  code: 'backend-start-failed' | 'view-start-failed' | 'tool-run-cancelled',
  cause: unknown,
  stage: 'backend.start' | 'view.start',
) {
  const value = cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : {};
  const ownerFailure =
    value.failure && typeof value.failure === 'object'
      ? (value.failure as Record<string, unknown>)
      : value;
  return {
    ok: false as const,
    error: {
      code,
      expected:
        typeof ownerFailure.expected === 'string'
          ? ownerFailure.expected
          : code === 'tool-run-cancelled'
            ? 'the ensure caller to remain active'
            : 'the owner startup operation to succeed',
      hint:
        typeof ownerFailure.hint === 'string'
          ? ownerFailure.hint
          : cause instanceof Error
            ? cause.message
            : String(cause),
      detail: {
        stage,
        ownerFailure: {
          ...(typeof ownerFailure.code === 'string' ? { code: ownerFailure.code } : {}),
          ...(typeof ownerFailure.expected === 'string' ? { expected: ownerFailure.expected } : {}),
          ...(typeof ownerFailure.hint === 'string' ? { hint: ownerFailure.hint } : {}),
          ...(ownerFailure.detail === undefined ? {} : { detail: ownerFailure.detail }),
        },
      },
    },
  };
}

function viewStartupResult(
  backend: Awaited<ReturnType<typeof requireResidentBackend>>,
  terminal: ToolTerminal<unknown>,
) {
  if (terminal.outcome === 'failed')
    return viewEnsureFailure(
      terminal.failure.code === 'tool-run-cancelled' ? 'tool-run-cancelled' : 'view-start-failed',
      terminal.failure,
      'view.start',
    );
  const view = terminal.result as { readonly ok?: unknown; readonly error?: unknown };
  if (view && typeof view === 'object' && view.ok === false)
    return viewEnsureFailure('view-start-failed', view.error, 'view.start');
  return { ok: true as const, value: { backend, view: terminal.result } };
}

/** Ensure the selected resident backend and its View shell through Engine-owned control. */
export async function ensureDevKitView(
  rootInput: string,
  options: {
    readonly hostPack: string;
    readonly lifetime?: 'clients';
    readonly project?: string;
    readonly startupTimeoutMs?: number | null;
    readonly signal?: AbortSignal;
  },
) {
  if (options.signal?.aborted)
    return viewEnsureFailure(
      'tool-run-cancelled',
      options.signal.reason ?? new DOMException('Ensure cancelled', 'AbortError'),
      'backend.start',
    );
  const root = resolve(rootInput);
  let project = options.project === undefined ? undefined : canonicalProjectRoot(options.project);
  let backend: Awaited<ReturnType<typeof requireResidentBackend>>;
  try {
    const started = await startDevKitBackend(root, {
      hostPack: options.hostPack,
      ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      viewShell: true,
      waitForReady: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    backend = await requireResidentBackend(root, started, options.startupTimeoutMs, options.signal);
  } catch (cause) {
    return viewEnsureFailure(
      options.signal?.aborted ? 'tool-run-cancelled' : 'backend-start-failed',
      cause,
      'backend.start',
    );
  }
  if (options.signal?.aborted)
    return viewEnsureFailure(
      'tool-run-cancelled',
      options.signal.reason ?? new DOMException('Ensure cancelled', 'AbortError'),
      'view.start',
    );
  if (project === undefined && options.lifetime === 'clients') {
    const { createWorkspaceSelection } = await import('./backend-lifetime.js');
    try {
      project = (await createWorkspaceSelection(root).read()) ?? undefined;
    } catch (cause) {
      return viewEnsureFailure('view-start-failed', cause, 'view.start');
    }
  }
  let terminal: ToolTerminal<unknown>;
  try {
    terminal = await runDevKitBackendTool(
      root,
      'view.start',
      { root, ...(project === undefined ? {} : { project }) },
      options.signal,
    );
  } catch (cause) {
    return viewEnsureFailure(
      options.signal?.aborted ? 'tool-run-cancelled' : 'view-start-failed',
      cause,
      'view.start',
    );
  }
  return viewStartupResult(backend, terminal);
}

export async function runDevKitBackendProcess(root: string, id: string): Promise<void> {
  logBackendStartup({
    stage: 'daemon-entry',
    event: 'begin',
    pid: process.pid,
    time: new Date().toISOString(),
  });
  const claim = readState(root);
  if (claim?.id !== id) throw new Error('Backend startup claim was replaced');
  let stop!: () => void;
  const lifetime = new AbortController();
  const closed = new Promise<void>((done) => {
    stop = () => {
      lifetime.abort(new Error('Backend process stopped'));
      done();
    };
  });
  let disposed!: () => void;
  let disposeFailed!: (error: unknown) => void;
  const disposal = new Promise<void>((done, reject) => {
    disposed = done;
    disposeFailed = reject;
  });
  void disposal.catch(() => {});
  // Only explicitly client-owned daemons stop when their last process user exits.
  const usage =
    claim.lifetime === 'clients'
      ? watchBackendLifetime(root, async () => {
          stop();
          await disposal;
        })
      : undefined;
  void usage?.finished.catch((error) => {
    console.error('Backend lifetime cleanup failed:', error);
    process.exitCode = 1;
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  type BackendModule = typeof import('./backend.js');
  const hostPack = claim.hostPack;
  let earlyView: Awaited<ReturnType<typeof startEarlyViewShell>> | undefined;
  let backend: Awaited<ReturnType<BackendModule['createDevKitBackend']>> | undefined;
  try {
    const { createDevKitBackend, devKitBackendServerPlugin } = await import('./backend.js');
    if (claim.viewShell)
      earlyView = await traceBackendStartup('view-static-listen', () =>
        startEarlyViewShell(root, hostPack),
      );
    const owner = {
      ...claim,
      root,
      id,
      pid: process.pid,
      ...(earlyView === undefined ? {} : { viewUrl: earlyView.viewerUrl }),
    };
    writeState({ ...owner, phase: 'starting' });
    backend = await traceBackendStartup('backend-create', () =>
      createDevKitBackend(root, {
        ...(hostPack === undefined ? {} : { hostPack }),
        ...(claim.lifetime === 'clients' ? { restoreWorkspace: true } : {}),
        signal: lifetime.signal,
        ...(earlyView === undefined
          ? {}
          : {
              viewBootstrap: {
                viewerUrl: earlyView.viewerUrl,
                publishSource: (url: string) => earlyView?.setBootstrapSource(url),
                publishFailure: (message: string) => earlyView?.setBootstrapFailure(message),
              },
            }),
      }),
    );
    const startedBackend = backend;
    await traceBackendStartup('server-listen', async () => {
      await (await startedBackend.host.context.plugin(devKitBackendServerPlugin, { stop })).await();
    });
    writeState({ ...owner, phase: 'ready', ...backend.host.context.devkitBackendServer });
    await closed;
  } finally {
    let cleanupError: unknown;
    try {
      await traceBackendStartup('backend-dispose', async () => {
        await backend?.dispose();
      });
      await earlyView?.close();
      removeState(root, id);
      disposed();
    } catch (error) {
      cleanupError = error;
      disposeFailed(error);
    }
    usage?.close();
    await usage?.finished;
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (cleanupError) await Promise.reject(cleanupError);
  }
}
