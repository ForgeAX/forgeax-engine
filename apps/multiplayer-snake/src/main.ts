import type { App } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import type { NetRecoverySnapshot, NetSession } from '@forgeax/engine-net';
import { isEndpointError } from '@forgeax/engine-net';
import type { Renderer } from '@forgeax/engine-render';
import { recordSnakeBrowserError } from './browser-diagnostics';
import { createClient } from './client';

type SnakeBrowserProbe = {
  readonly recover: () => ReturnType<NetSession['recover']>;
  readonly recoverRenderer: () => ReturnType<Renderer['recover']>;
  readonly rendererInspection: () => ReturnType<Renderer['inspect']>;
  readonly appLastError: () => App['lastError'];
  readonly completedFrames: () => number;
  readonly advanceRecovery: () => void;
  readonly snapshot: () => NetRecoverySnapshot;
  readonly directionCommandSendCount: () => number;
  readonly dispose: () => void;
};

declare global {
  interface Window {
    __forgeaxSnake?: SnakeBrowserProbe;
  }
}

function endpointUrl(): string {
  const requested = new URLSearchParams(window.location.search).get('server');
  if (requested !== null) return requested;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:8787`;
}

function hostEndpointUrl(): string {
  const requested = new URLSearchParams(window.location.search).get('host');
  if (requested !== null) return requested;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:8788`;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  const state = document.querySelector<HTMLOutputElement>('[data-testid="snake-state"]');
  if (canvas === null || state === null) return;

  let disposeClient: (() => void) | undefined;
  try {
    const client = await createClient(canvas, endpointUrl(), hostEndpointUrl());
    const browserProbeEnabled =
      new URLSearchParams(window.location.search).get('m16-reconnect') === '1';
    const browserProbe: SnakeBrowserProbe = {
      recover: () => client.session.recover(),
      recoverRenderer: () => client.renderer.recover(),
      rendererInspection: () => client.renderer.inspect(),
      appLastError: () => client.app.lastError,
      completedFrames: () => client.app.execution.report().frame.completed,
      advanceRecovery: () => client.session.advanceRecovery(),
      snapshot: client.getRecoverySnapshot,
      directionCommandSendCount: () => client.directionCommandEvidence.directionCommandSendCount,
      dispose: () => {
        client.dispose();
        if (window.__forgeaxSnake === browserProbe) delete window.__forgeaxSnake;
      },
    };
    if (browserProbeEnabled) window.__forgeaxSnake = browserProbe;
    disposeClient = browserProbe.dispose;

    client.world
      .addSystem(Update, {
        name: 'snake-client-observability',
        queries: [],
        fn: () => {
          const recovery = client.getRecoverySnapshot();
          state.dataset.netSessionId = String(recovery.sessionId);
          state.dataset.netSessionState = recovery.state.kind;
          state.dataset.netPendingPackets = String(recovery.pendingPackets);
          state.dataset.netOwnedResources = JSON.stringify(recovery.ownedResources);
          switch (recovery.state.kind) {
            case 'connecting':
              break;
            case 'resyncing':
              state.dataset.netEpoch = String(recovery.state.epoch);
              break;
            case 'active':
              state.dataset.netEpoch = String(recovery.state.epoch);
              state.dataset.netSequence = String(recovery.state.sequence);
              break;
            case 'recovering':
              state.dataset.netRecoveryAttempt = String(recovery.state.attempt);
              break;
            case 'failed':
              state.dataset.netErrorCode = recovery.state.error.code;
              state.dataset.netErrorHint = recovery.state.error.hint;
              state.dataset.netErrorDetail = JSON.stringify(recovery.state.error.detail);
              break;
            case 'retired':
              state.dataset.netRetireReason = recovery.state.reason;
              break;
          }
          state.dataset.directionCommandSendCount = String(
            client.directionCommandEvidence.directionCommandSendCount,
          );
          if (recovery.lastError !== undefined)
            state.dataset.netLastErrorDetail = JSON.stringify(recovery.lastError.detail);
          const frustumStats = client.renderer.inspect().frustumStats;
          state.dataset.renderableTotal = String(frustumStats.total);
          state.dataset.renderableCulled = String(frustumStats.culled);
        },
      })
      .unwrap();

    const appErrors: string[] = [];
    const status = document.querySelector<HTMLElement>('#round-status') ?? undefined;
    client.app.onError((error) => {
      recordSnakeBrowserError(state, status, appErrors, error);
    });
    const started = client.app.start();
    if (!started.ok) throw started.error;
  } catch (error) {
    state.dataset.lifecycle = 'failed';
    disposeClient?.();
    if (isEndpointError(error)) {
      state.textContent = `${error.code}: ${error.hint} (${JSON.stringify(error.detail)})`;
    } else {
      state.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

void main();
