import { describe, expect, it, vi } from 'vitest';
import { createWorkerFrameResponder, WorkerFrameSource } from '../execution/worker-frame-source';

function fixture() {
  const client = new WorkerFrameSource();
  const host = { postMessage: vi.fn() };
  const render = { postMessage: vi.fn() };
  const callbacks: FrameRequestCallback[] = [];
  const native = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => callbacks.push(callback)),
    cancelAnimationFrame: vi.fn(),
  };
  render.postMessage.mockImplementation((notice) => client.receive(host, notice));
  client.connect(host);
  const responder = createWorkerFrameResponder(render, native);
  host.postMessage.mockImplementation(responder.receive);
  const dispose = responder.dispose;
  return { client, host, render, native, callbacks, dispose };
}

describe('existing Engine Worker native frame leases', () => {
  it('runs only requested native callbacks, once, without an idle heartbeat', () => {
    const f = fixture();
    const tick = vi.fn();
    expect(f.native.requestAnimationFrame).not.toHaveBeenCalled();
    f.client.request(tick, vi.fn());
    expect(f.native.requestAnimationFrame).toHaveBeenCalledTimes(1);
    f.callbacks[0]?.(10);
    f.callbacks[0]?.(20);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(f.native.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('fences a cancelled callback when a new demand follows pause/resume', () => {
    const f = fixture();
    const old = vi.fn();
    const current = vi.fn();
    f.client.request(old, vi.fn())?.();
    f.client.request(current, vi.fn());
    f.callbacks[0]?.(10);
    expect(old).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    f.callbacks[1]?.(20);
    expect(current).toHaveBeenCalledTimes(1);
    expect(f.native.cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it('invalidates the old port before rescheduling on replacement', () => {
    const f = fixture();
    const tick = vi.fn();
    const unavailable = vi.fn(() => expect(f.client.request(tick, vi.fn())).toBeUndefined());
    f.client.request(tick, unavailable);
    const replacement = { postMessage: vi.fn() };
    f.client.connect(replacement);
    expect(unavailable).toHaveBeenCalledTimes(1);
    f.callbacks[0]?.(10);
    f.client.receive(f.host, { kind: 'native-frame-ready', supported: true });
    expect(tick).not.toHaveBeenCalled();
    expect(f.client.request(tick, vi.fn())).toBeUndefined();
  });

  it('provider disposal cancels the native callback and reschedules without a synthetic tick', () => {
    const f = fixture();
    const tick = vi.fn();
    const unavailable = vi.fn();
    f.client.request(tick, unavailable);
    f.dispose();
    f.callbacks[0]?.(10);
    expect(f.native.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    expect(f.client.request(tick, vi.fn())).toBeUndefined();
  });

  it('falls back if native rAF rejects this Worker owner', () => {
    const f = fixture();
    f.native.requestAnimationFrame.mockImplementation(() => {
      throw Error('unsupported owner');
    });
    const tick = vi.fn();
    const unavailable = vi.fn();
    f.client.request(tick, unavailable);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    expect(f.client.request(tick, vi.fn())).toBeUndefined();
  });

  it('falls back when posting a lease fails and ignores obsolete replies', () => {
    const f = fixture();
    f.host.postMessage.mockImplementation(() => {
      throw Error('closed port');
    });
    const tick = vi.fn();
    expect(f.client.request(tick, vi.fn())).toBeUndefined();
    f.client.receive(f.host, { kind: 'native-frame', id: 1 });
    expect(tick).not.toHaveBeenCalled();
  });

  it('does not request native frames until supported readiness arrives', () => {
    const client = new WorkerFrameSource();
    const port = { postMessage: vi.fn() };
    expect(client.request(vi.fn(), vi.fn())).toBeUndefined();
    client.connect(port);
    client.receive(port, { kind: 'native-frame-ready', supported: false });
    expect(client.request(vi.fn(), vi.fn())).toBeUndefined();
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
