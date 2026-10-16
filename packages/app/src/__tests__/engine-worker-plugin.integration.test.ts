import { describe, expect, it, vi } from 'vitest';
import { startEngineWorker } from '../execution/engine-worker';
import type { EngineToHostMessage, HostToEngineMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

class PluginWorker extends EventTarget {
  onmessage: ((event: MessageEvent<EngineToHostMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posts: Array<{
    readonly message: HostToEngineMessage;
    readonly transfer: readonly Transferable[];
  }> = [];
  readonly terminate = vi.fn();

  postMessage(message: HostToEngineMessage, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
    if (message.kind === 'dispose')
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: { kind: 'disposed' } })),
      );
    if (message.kind !== 'init') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: { kind: 'ready', worldIdentity: 'world-plugin', realm: 'worker', workerWebGpu: true },
      } as MessageEvent<EngineToHostMessage>);
    });
  }
}

describe('Engine Worker plugin realm', () => {
  it('transfers only bootstrap data and asset publication identity into the Worker', async () => {
    const worker = new PluginWorker();
    const offscreen = {} as OffscreenCanvas;
    const started = await startEngineWorker({
      canvas: {
        transferControlToOffscreen: vi.fn(() => offscreen),
      } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/engine-worker.js',
      bootstrapData: { gameId: 'plugin-fixture' },
      assetCatalog: {
        url: '/__pack/scopes/plugin-fixture/3/catalog.json',
        expectedScope: { scopeId: 'plugin-fixture', generation: 3 },
      },
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: false, kernels: false }),
      workerFactory: () => worker as unknown as Worker,
    });

    expect(started.ok).toBe(true);
    expect(worker.posts[0]?.message).toMatchObject({
      kind: 'init',
      bootstrapUrl: 'https://example.test/engine-worker.js',
      bootstrapData: { gameId: 'plugin-fixture' },
      assetCatalog: { expectedScope: { scopeId: 'plugin-fixture', generation: 3 } },
    });
    expect(worker.posts[0]?.message).not.toHaveProperty('pluginBootstrap');
    started.ok && (await started.value.dispose()).unwrap();
  });
});
