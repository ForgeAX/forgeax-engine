import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserExecutionBridge } from '../internal/browser-remote-bridge';

class FakeWebSocket {
  static current: FakeWebSocket | undefined;
  static created = 0;

  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: string; code?: number; reason?: string }) => void>
  >();
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.current = this;
    FakeWebSocket.created++;
  }

  addEventListener(
    type: string,
    listener: (event: { data?: string; code?: number; reason?: string }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {}

  emit(type: string, event: { data?: string; code?: number; reason?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  FakeWebSocket.current = undefined;
  FakeWebSocket.created = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Worker browser execution bridge status', () => {
  it('answers Host-owned status without admitting a Worker eval', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const execute = vi.fn();
    const status = {
      worldIdentity: 'world-1',
      execution: { frame: { submitted: 1, completed: 0, inFlight: 1 } },
      workers: { engine: { enabled: true } },
    };

    const teardown = await installBrowserExecutionBridge({
      execute: execute as never,
      readStatus: () => status,
      port: '5733',
    });
    const socket = FakeWebSocket.current;
    expect(socket?.url).toBe('ws://127.0.0.1:5733/bridge');

    socket?.emit('message', { data: JSON.stringify({ type: 'status', id: 7 }) });

    expect(execute).not.toHaveBeenCalled();
    expect(socket?.sent.map((value) => JSON.parse(value))).toEqual([
      { type: 'result', id: 7, payload: { ok: true, value: status } },
    ]);
    teardown();
  });

  it('presents the owner token and stays an observer after the owner rejects it', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    vi.stubGlobal('location', { search: '?level=2&forgeaxBridge=owner-token' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clearInput = vi.fn();
    const teardown = await installBrowserExecutionBridge({
      execute: vi.fn() as never,
      readStatus: () => ({}),
      port: '5733',
      clearInput,
    });
    expect(FakeWebSocket.current?.url).toBe('ws://127.0.0.1:5733/bridge?forgeaxBridge=owner-token');

    // An ordinary disconnect keeps the existing reconnect.
    FakeWebSocket.current?.emit('close', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.created).toBe(2);

    // Another page owns the bridge: this page keeps running and stops dialing.
    FakeWebSocket.current?.emit('close', { code: 4403, reason: 'live-bridge-not-owner' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.created).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('live-bridge-not-owner');
    expect(clearInput).toHaveBeenCalled();
    teardown();
  });

  it('keeps the token read at install and stops when a newer owner page displaces it', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const location = { search: '?forgeaxBridge=owner-token' };
    vi.stubGlobal('location', location);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const teardown = await installBrowserExecutionBridge({
      execute: vi.fn() as never,
      readStatus: () => ({}),
      port: '5733',
    });
    // Game code rewrites its own query string after startup.
    location.search = '?level=3';
    FakeWebSocket.current?.emit('close', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.current?.url).toBe('ws://127.0.0.1:5733/bridge?forgeaxBridge=owner-token');

    FakeWebSocket.current?.emit('close', { code: 4409, reason: 'live-bridge-displaced' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.created).toBe(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('live-bridge-displaced');
    teardown();
  });
});
