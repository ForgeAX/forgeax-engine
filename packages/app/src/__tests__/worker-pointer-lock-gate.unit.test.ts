import { ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineToHostMessage, HostToEngineMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

// The real Engine Worker session and Host controller run here; only the
// browser platform, the Worker realm and the DOM input producer are replaced.
const probes = vi.hoisted(() => ({
  pointerAllowed: vi.fn(),
  startupMessages: [] as EngineToHostMessage[],
}));

vi.mock('@forgeax/engine-platform-browser', () => ({
  createBrowserPlatform: vi.fn(() =>
    ok({
      now: () => ok(performance.now()),
      visible: () => true,
      requestFrame: () => ok(() => {}),
      subscribe: () => ok(() => {}),
      dispose: () => {},
    }),
  ),
}));

vi.mock('@forgeax/engine-input', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-input')>()),
  attachBrowserInputBackend: vi.fn(() => {
    const cleanup = (() => {}) as (() => void) & {
      backend: import('@forgeax/engine-input').InputBackend;
    };
    cleanup.backend = {
      sample: () => ({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      detach: () => {},
      setPointerLockAllowed: (allowed: boolean) => probes.pointerAllowed(allowed),
    };
    return cleanup;
  }),
}));

class StartupWorker extends EventTarget {
  onmessage: ((event: MessageEvent<EngineToHostMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate(): void {}
  postMessage(message: HostToEngineMessage): void {
    const deliver = (data: EngineToHostMessage) =>
      this.onmessage?.({ data } as MessageEvent<EngineToHostMessage>);
    if (message.kind === 'dispose')
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: { kind: 'disposed' } })),
      );
    if (message.kind !== 'init') return;
    queueMicrotask(() => {
      // Engine-realm plugins apply before the ready ACK, so a game's gate
      // command precedes every Host listener and the browser input backend.
      for (const startupMessage of probes.startupMessages) deliver(startupMessage);
      deliver({ kind: 'ready', worldIdentity: 'world-test', realm: 'worker', workerWebGpu: true });
    });
  }
}

import { createWorkerExecutionApp } from '../execution/host-controller';

const capabilities = {
  worker: { available: true, reason: 'test' },
  offscreenCanvas: { available: true, reason: 'test' },
  workerAnimationFrame: { available: true, reason: 'test' },
  workerWebGpu: { available: true, reason: 'test' },
  crossOriginIsolated: { available: false, reason: 'test' },
  sharedArrayBuffer: { available: false, reason: 'test' },
  atomicsWait: { available: false, reason: 'test' },
} as const;

const gate = (allowed: boolean): EngineToHostMessage => ({
  kind: 'host-control',
  command: 'set-pointer-lock-allowed',
  allowed,
});

describe('Engine-realm pointer-lock gate', () => {
  beforeEach(() => {
    probes.pointerAllowed.mockClear();
    probes.startupMessages = [];
    vi.stubGlobal('Worker', StartupWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [[false], false],
    [[true], true],
    [[true, false], false],
    [[false, true], true],
  ])('applies startup commands %j to the later browser input backend as %s', async (commands, effective) => {
    probes.startupMessages = commands.map(gate);
    const result = await createWorkerExecutionApp({
      canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(probes.pointerAllowed).toHaveBeenCalled();
      expect(probes.pointerAllowed.mock.calls.at(-1)).toEqual([effective]);
    } finally {
      await result.value.dispose();
    }
  });
});
