import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserExecutionBridge } from '../internal/browser-remote-bridge';

class FakeWebSocket {
  static current: FakeWebSocket | undefined;

  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.current = this;
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {}

  emit(type: string, event: { data?: string } = {}): void {
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
});
