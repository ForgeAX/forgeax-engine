import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@forgeax/engine-plugin';
import { err, ok, type Result } from '@forgeax/engine-types';

import {
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_ROUTE_PREFIX,
  type FederationActivityResult,
  type FederationBinding,
  type FederationCommunityCapability,
  type FederationLease,
  type FederationOwnership,
  type FederationStatus,
  isFederationStatus,
} from './protocol';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    dshRealm: DshRealmConnection;
  }
}

export type DshRealmErrorCode =
  | 'dsh-target-unavailable'
  | 'dsh-target-incompatible'
  | 'dsh-launch-failed'
  | 'dsh-handshake-timeout'
  | 'dsh-lease-failed'
  | 'dsh-community-failed';

export class DshRealmError extends Error {
  readonly code: DshRealmErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: DshRealmErrorCode,
    expected: string,
    hint: string,
    detail: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super(`${code}: ${expected}`, cause === undefined ? undefined : { cause });
    this.name = 'DshRealmError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export interface DshRealmPluginOptions {
  /** Attach to an already-running compatible DSH realm. Never closes that realm. */
  readonly endpoint?: string;
  /** Explicit DSH executable. Omit to discover `dsh` on PATH. */
  readonly executable?: string;
  readonly profile?: string;
  readonly home?: string;
  readonly cwd?: string;
  readonly handshakeTimeoutMs?: number;
  readonly allowEmbedded?: boolean;
}

export interface DshRealmConnection {
  readonly endpoint: string;
  readonly binding: FederationBinding;
  readonly ownership: FederationOwnership;
  readonly status: FederationStatus;
  community(): Promise<FederationCommunityCapability>;
  activity(
    input: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<FederationActivityResult>;
}

export interface ConnectedRealm {
  readonly connection: DshRealmConnection;
  dispose(): Promise<void>;
}

/** Engine-side Realm Host Plugin. It publishes no service until handshake and lease acquisition succeed. */
export function dshRealmPlugin(options: DshRealmPluginOptions = {}): Plugin {
  return {
    name: 'dsh-realm',
    provide: 'dshRealm',
    async apply(ctx) {
      const result = await connectDshRealm(options);
      if (!result.ok) throw result.error;
      const connected = result.value;
      ctx.effect(() => () => connected.dispose(), 'dsh-realm: binding ownership');
      ctx.provide('dshRealm', connected.connection);
    },
  };
}

export async function connectDshRealm(
  options: DshRealmPluginOptions = {},
): Promise<Result<ConnectedRealm, DshRealmError>> {
  try {
    return ok(await resolveDshRealm(options));
  } catch (cause) {
    if (cause instanceof DshRealmError) return err(cause);
    return err(
      new DshRealmError(
        'dsh-launch-failed',
        'the DSH realm binding to initialize',
        'Inspect the selected endpoint, executable, profile, and process diagnostics.',
        { binding: options.endpoint === undefined ? 'launch' : 'attach' },
        cause,
      ),
    );
  }
}

async function resolveDshRealm(options: DshRealmPluginOptions): Promise<ConnectedRealm> {
  const timeoutMs = options.handshakeTimeoutMs ?? 10_000;
  if (options.endpoint !== undefined) {
    return attach(options.endpoint, timeoutMs);
  }

  const executable =
    options.executable === undefined ? await discoverOnPath('dsh') : options.executable;
  if (executable !== undefined) {
    return launchExternal(executable, options, timeoutMs);
  }
  if (options.allowEmbedded === false) {
    throw new DshRealmError(
      'dsh-target-unavailable',
      'a compatible explicit endpoint or local dsh executable',
      'Install DeepSeek Harness, pass executable/endpoint, or allow the packaged minimum fallback.',
      { binding: 'external' },
    );
  }
  return launchEmbedded(timeoutMs);
}

async function attach(endpoint: string, timeoutMs: number): Promise<ConnectedRealm> {
  const normalized = normalizeEndpoint(endpoint);
  const status = await waitForStatus(normalized, timeoutMs, 'attach');
  const leaseId = await acquireLease(normalized);
  let disposed = false;
  return {
    connection: connection(normalized, 'attach', 'lease', status),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await releaseLease(normalized, leaseId);
    },
  };
}

async function launchExternal(
  executable: string,
  options: DshRealmPluginOptions,
  timeoutMs: number,
): Promise<ConnectedRealm> {
  const args = ['--profile', options.profile ?? 'web', '--host', '127.0.0.1', '--port', '0'];
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.home === undefined ? {} : { DSH_HOME: options.home }),
    },
  });
  return finishLaunch(child, 'external', timeoutMs, executable);
}

async function launchEmbedded(timeoutMs: number): Promise<ConnectedRealm> {
  const entry = fileURLToPath(new URL('./embedded.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], { env: process.env });
  return finishLaunch(child, 'embedded', timeoutMs, entry);
}

async function finishLaunch(
  child: ChildProcessWithoutNullStreams,
  binding: Exclude<FederationBinding, 'attach'>,
  timeoutMs: number,
  target: string,
): Promise<ConnectedRealm> {
  try {
    const endpoint = await readLaunchEndpoint(child, timeoutMs, target);
    const status = await waitForStatus(endpoint, timeoutMs, binding);
    const leaseId = await acquireLease(endpoint);
    let disposed = false;
    return {
      connection: connection(endpoint, binding, 'instance', status),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await releaseLease(endpoint, leaseId).catch(() => undefined);
        await stopChild(child);
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

function connection(
  endpoint: string,
  binding: FederationBinding,
  ownership: FederationOwnership,
  status: FederationStatus,
): DshRealmConnection {
  return {
    endpoint,
    binding,
    ownership,
    status,
    async community() {
      const response = await fetch(`${endpoint}${FEDERATION_ROUTE_PREFIX}/community`);
      if (!response.ok) {
        throw new DshRealmError(
          'dsh-community-failed',
          'the DSH-native community capability to answer through the bridge',
          'Install and enable a DSH plugin that provides forgeaxFederationCapability.',
          { endpoint, status: response.status },
        );
      }
      return (await response.json()) as FederationCommunityCapability;
    },
    async activity(input, sessionId, signal) {
      const response = await fetch(`${endpoint}${FEDERATION_ROUTE_PREFIX}/activity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input, sessionId }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new DshRealmError(
          'dsh-community-failed',
          'a DSH-native intelligence capability to answer through the bridge',
          'Install and enable a DSH plugin that provides forgeaxIntelligenceCapability.',
          { endpoint, status: response.status },
        );
      }
      const value = (await response.json()) as Partial<FederationActivityResult>;
      if (typeof value.output !== 'string') {
        throw new DshRealmError(
          'dsh-community-failed',
          'the DSH intelligence bridge to return text output',
          'Use a capability plugin compatible with federation protocol 1.',
          { endpoint, received: value },
        );
      }
      return { output: value.output };
    },
  };
}

async function waitForStatus(
  endpoint: string,
  timeoutMs: number,
  binding: FederationBinding,
): Promise<FederationStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}${FEDERATION_ROUTE_PREFIX}/status`);
      if (response.ok) {
        const value: unknown = await response.json();
        if (!isFederationStatus(value) || value.protocol !== FEDERATION_PROTOCOL_VERSION) {
          throw new DshRealmError(
            'dsh-target-incompatible',
            `DSH federation protocol ${FEDERATION_PROTOCOL_VERSION}`,
            'Use a connector version that matches this Engine package.',
            { binding, endpoint, received: value },
          );
        }
        return value;
      }
      last = response.status;
    } catch (error) {
      if (error instanceof DshRealmError) throw error;
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new DshRealmError(
    'dsh-handshake-timeout',
    `a ready federation endpoint within ${timeoutMs}ms`,
    'Install @forgeax/engine-dsh into the selected DSH profile and inspect its native Loader diagnostics.',
    { binding, endpoint, last },
  );
}

async function acquireLease(endpoint: string): Promise<string> {
  const response = await fetch(`${endpoint}${FEDERATION_ROUTE_PREFIX}/lease`, { method: 'POST' });
  if (!response.ok) {
    throw new DshRealmError(
      'dsh-lease-failed',
      'a lease-scoped bridge activation',
      'The target must support lease acquisition and release before attach is safe.',
      { endpoint, status: response.status },
    );
  }
  const lease = (await response.json()) as Partial<FederationLease>;
  if (typeof lease.leaseId !== 'string') {
    throw new DshRealmError(
      'dsh-lease-failed',
      'a string leaseId',
      'Update the target connector to the matching protocol version.',
      { endpoint, received: lease },
    );
  }
  return lease.leaseId;
}

async function releaseLease(endpoint: string, leaseId: string): Promise<void> {
  await fetch(
    `${endpoint}${FEDERATION_ROUTE_PREFIX}/lease?leaseId=${encodeURIComponent(leaseId)}`,
    { method: 'DELETE' },
  );
}

function readLaunchEndpoint(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  target: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new DshRealmError(
          'dsh-launch-failed',
          'the launched realm to print its loopback URL',
          'Inspect the native DSH startup and Loader diagnostics.',
          { target, output },
        ),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const matched = output.match(/(?:dsh web|forgeax embedded):\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (matched?.[1] === undefined) return;
      cleanup();
      resolve(matched[1]);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new DshRealmError(
          'dsh-launch-failed',
          'the launched realm to remain alive through readiness',
          'Inspect the native process output and profile composition.',
          { target, code, output },
        ),
      );
    };
    const onError = (cause: Error): void => {
      cleanup();
      reject(
        new DshRealmError(
          'dsh-launch-failed',
          'the selected DSH executable to start',
          'Pass an executable file that can launch the selected native DSH profile.',
          { target, output },
          cause,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!graceful && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function discoverOnPath(name: string): Promise<string | undefined> {
  const paths = process.env.PATH?.split(delimiter) ?? [];
  for (const directory of paths) {
    const candidate = join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep scanning deterministic PATH order.
    }
  }
  return undefined;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
}
