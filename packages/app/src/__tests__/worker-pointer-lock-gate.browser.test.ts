import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createWorkerExecutionApp } from '../execution/host-controller';
import { workerSelection } from './execution-fixtures';

// Real Chromium, a real module Worker, the real Host controller and the real
// browser input backend. The Worker speaks the Engine protocol: like a game
// plugin, it commands the pointer-lock gate before its ready ACK.
function engineWorkerSource(commands: readonly boolean[]): string {
  return `
    self.onmessage = (event) => {
      const message = event.data;
      if (message.kind === 'init') {
        for (const allowed of ${JSON.stringify(commands)})
          self.postMessage({ kind: 'host-control', command: 'set-pointer-lock-allowed', allowed });
        self.postMessage({ kind: 'ready', worldIdentity: 'world-test', realm: 'worker', workerWebGpu: true });
      }
      if (message.kind === 'dispose') self.postMessage({ kind: 'disposed' });
    };
  `;
}

const capabilities = {
  worker: { available: true, reason: 'test' },
  offscreenCanvas: { available: true, reason: 'test' },
  workerAnimationFrame: { available: true, reason: 'test' },
  workerWebGpu: { available: true, reason: 'test' },
  crossOriginIsolated: { available: false, reason: 'test' },
  sharedArrayBuffer: { available: false, reason: 'test' },
  atomicsWait: { available: false, reason: 'test' },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Engine-realm pointer-lock gate (real Chromium)', () => {
  it.each([
    [[false], 0],
    [[true], 1],
    [[true, false], 0],
  ])('startup commands %j lead a trusted canvas click to %i lock requests', async (commands, requests) => {
    const url = URL.createObjectURL(
      new Blob([engineWorkerSource(commands)], { type: 'text/javascript' }),
    );
    const NativeWorker = Worker;
    vi.stubGlobal(
      'Worker',
      class extends NativeWorker {
        constructor() {
          super(url, { type: 'module' });
        }
      },
    );
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:320px;height:200px';
    document.body.append(canvas);
    let lockRequests = 0;
    Object.defineProperty(canvas, 'requestPointerLock', {
      configurable: true,
      value: () => {
        lockRequests += 1;
        return Promise.resolve();
      },
    });
    const result = await createWorkerExecutionApp({
      canvas,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      await userEvent.click(canvas);
      expect(lockRequests).toBe(requests);
    } finally {
      await result.value.dispose();
      canvas.remove();
      URL.revokeObjectURL(url);
    }
  });
});
