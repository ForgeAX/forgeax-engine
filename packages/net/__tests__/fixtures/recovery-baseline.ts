import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');

export interface BaselineCommandResult {
  readonly command: string;
  readonly ok: boolean;
  readonly output: string;
}

export interface BaselineSourceCheck {
  readonly path: string;
  readonly command: string;
  readonly expected: string;
  readonly present: boolean;
}

export interface RecoveryBaseline {
  readonly generatedBy: string;
  readonly repositoryRoot: string;
  readonly head: BaselineCommandResult;
  readonly packageOwnership: ReadonlyArray<{
    readonly packageName: string;
    readonly paths: readonly string[];
    readonly cohesion: string;
  }>;
  readonly publicExports: ReadonlyArray<{
    readonly packageName: string;
    readonly entries: readonly string[];
  }>;
  readonly readmeRecoveryBoundaries: readonly BaselineSourceCheck[];
  readonly lifecycleFacts: readonly BaselineSourceCheck[];
  readonly intendedFalsifiers: ReadonlyArray<{
    readonly acceptanceId: string;
    readonly invariant: string;
    readonly expectedOutcome: string;
  }>;
}

function runGit(args: readonly string[]): BaselineCommandResult {
  const command = `git ${args.join(' ')}`;
  try {
    return {
      command,
      ok: true,
      output: execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    };
  } catch (cause) {
    const error = cause as { stderr?: string; status?: number };
    return {
      command,
      ok: false,
      output: (error.stderr ?? `exit status ${error.status ?? 'unknown'}`).trim(),
    };
  }
}

function sourceCheck(path: string, expected: string): BaselineSourceCheck {
  const absolutePath = `${repositoryRoot}/${path}`;
  let present = false;
  try {
    present = readFileSync(absolutePath, 'utf8').includes(expected);
  } catch {
    present = false;
  }
  return {
    path,
    command: `rg -n --fixed-strings '${expected}' ${path}`,
    expected,
    present,
  };
}

export function collectRecoveryBaseline(): RecoveryBaseline {
  const head = runGit(['rev-parse', 'HEAD']);
  const root = runGit(['rev-parse', '--show-toplevel']);

  return {
    generatedBy: 'packages/net/__tests__/fixtures/recovery-baseline.ts',
    repositoryRoot: root.output,
    head,
    packageOwnership: [
      {
        packageName: '@forgeax/engine-net',
        paths: ['packages/net/src/endpoint', 'packages/net/src/session', 'packages/net/src/replication'],
        cohesion: 'file_count=13; max_file_loc=258; fan_in=11; root_file_sprawl=1; no findings',
      },
      {
        packageName: '@forgeax/engine-net-websocket',
        paths: ['packages/net-websocket/src/browser.ts', 'packages/net-websocket/src/node.ts', 'packages/net-websocket/src/websocket-client-core.ts', 'packages/net-websocket/src/event-queue.ts'],
        cohesion: 'file_count=4; max_file_loc=204; fan_in=2; root_file_sprawl=4; no findings',
      },
      {
        packageName: '@forgeax/multiplayer-snake',
        paths: ['apps/multiplayer-snake/src/client.ts', 'apps/multiplayer-snake/src/server.ts', 'apps/multiplayer-snake/src/main.ts'],
        cohesion: 'consumer workspace; package cohesion script does not apply',
      },
    ],
    publicExports: [
      {
        packageName: '@forgeax/engine-net',
        entries: ['NetEndpoint', 'NetSession', 'defineReplication', 'AuthorityCoordinator', 'ReplicaCoordinator', 'NetError'],
      },
      {
        packageName: '@forgeax/engine-net-websocket',
        entries: ['./browser', './node'],
      },
    ],
    readmeRecoveryBoundaries: [
      sourceCheck('packages/net/README.md', 'Reconnect, ACK ledger, resync, packet-loss recovery'),
      sourceCheck('packages/net/README.md', 'Socket-specific retry or automatic recovery'),
      sourceCheck('packages/net-websocket/README.md', 'retry, and gameplay remain in `@forgeax/engine-net`'),
    ],
    lifecycleFacts: [
      sourceCheck('packages/net/src/endpoint/endpoint.ts', 'poll(): EndpointEvent[]'),
      sourceCheck('packages/net/src/endpoint/endpoint.ts', 'send(peerId: PeerId, data: Uint8Array)'),
      sourceCheck('packages/net/src/endpoint/endpoint.ts', 'close(): Result<void, EndpointError>'),
      sourceCheck('packages/net/src/session/net-session.ts', 'receiveEvents(): readonly NetError[]'),
      sourceCheck('packages/net/src/session/net-session.ts', 'publish(): Result<void, NetError | EndpointError>'),
      sourceCheck('packages/net/src/replication/replica.ts', 'clear(): void'),
      sourceCheck('packages/net/src/session/net-session.ts', 'dispose(): void'),
    ],
    intendedFalsifiers: [
      { acceptanceId: 'AC-02', invariant: 'A rejected pre-baseline mutation leaves the local projection unchanged.', expectedOutcome: 'structured rejection and unchanged World state' },
      { acceptanceId: 'AC-03', invariant: 'ACK and retry retention remain within the configured finite bound.', expectedOutcome: 'observable usage never exceeds the bound' },
      { acceptanceId: 'AC-04', invariant: 'A reopened socket cannot promote stale local state to authority.', expectedOutcome: 'resyncing state until a fresh authoritative baseline is accepted' },
      { acceptanceId: 'AC-06', invariant: 'A fatal apply failure is not hidden by transport retry.', expectedOutcome: 'terminal structured apply failure' },
      { acceptanceId: 'AC-07', invariant: 'Duplicate and out-of-order packets do not duplicate or regress mutation.', expectedOutcome: 'deterministic no-mutation or structured rejection' },
      { acceptanceId: 'AC-12', invariant: 'Disposal retires every timer, listener, socket, pending connect, ledger, and callback.', expectedOutcome: 'all instrumented resource counters equal zero' },
    ],
  };
}

export { repositoryRoot };
