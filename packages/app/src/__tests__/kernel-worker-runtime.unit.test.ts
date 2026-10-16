import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('kernel worker runtime', () => {
  let originalOnMessage: typeof globalThis.onmessage;
  let receive: (event: MessageEvent<unknown>) => void;

  beforeAll(async () => {
    originalOnMessage = globalThis.onmessage;
    await import('../execution/kernel-worker-runtime');
    receive = globalThis.onmessage as unknown as (event: MessageEvent<unknown>) => void;
  });

  afterAll(() => {
    globalThis.onmessage = originalOnMessage;
  });

  it('dispatches a preloaded kernel without a per-frame import promise', async () => {
    const moduleUrl = 'data:text/javascript,export default { run() { return undefined; } }';
    const channel = new MessageChannel();
    receive({ data: { kind: 'kernel-connect', port: channel.port2 } } as MessageEvent<unknown>);
    const preloadControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const preloadStatus = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

    channel.port1.postMessage({
      kind: 'kernel-preload',
      moduleUrl,
      control: preloadControl,
      status: preloadStatus,
      jobIndex: 0,
    });
    await vi.waitFor(() => expect(Atomics.load(preloadControl, 0)).toBe(1));
    expect(Atomics.load(preloadStatus, 0)).toBe(1);

    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const status = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    channel.port1.postMessage({
      kind: 'kernel-job',
      moduleUrl,
      binding: { length: 0, read: {}, write: {} },
      control,
      status,
      jobIndex: 0,
    });

    await vi.waitFor(() => expect(Atomics.load(control, 0)).toBe(1));
    expect(Atomics.load(control, 0)).toBe(1);
    expect(Atomics.load(status, 0)).toBe(1);
    channel.port1.close();
    channel.port2.close();
  });
});
