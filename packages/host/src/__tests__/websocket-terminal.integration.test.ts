import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createHostWebSocketClient } from '../transport.js';

it.each([
  'closing',
  'closed',
] as const)('rejects a real %s socket without retaining connection listeners', async (state) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let socket: WebSocket | undefined;
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing socket address');
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.close();
    if (state === 'closed') await closed;
    expect(socket.readyState).toBe(state === 'closed' ? WebSocket.CLOSED : WebSocket.CLOSING);
    const listeners = { open: socket.listenerCount('open'), error: socket.listenerCount('error') };
    await expect(createHostWebSocketClient(socket)).rejects.toMatchObject({
      code: 'host-transport-failure',
    });
    expect(socket.listenerCount('open')).toBe(listeners.open);
    expect(socket.listenerCount('error')).toBe(listeners.error);
    await closed;
  } finally {
    socket?.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  'error',
  'peer-close',
  'client-close',
] as const)('retires requests and physical listeners on %s', async (cause) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let socket: WebSocket | undefined;
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const accepted = once(server, 'connection');
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, 'open');
    const [peer] = await accepted;
    const client = await createHostWebSocketClient(socket);
    const abort = new AbortController();
    const removed = vi.spyOn(abort.signal, 'removeEventListener');
    const rejected = expect(
      client.request('never-replied', null, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'host-transport-failure' });
    client.subscribe('updates', () => {
      throw new Error('retired subscription');
    });
    const disconnected = vi.fn();
    client.onDisconnect(disconnected);
    const closed = new Promise<void>((resolve) => socket?.once('close', () => resolve()));
    if (cause === 'error') socket.emit('error', new Error('injected native socket failure'));
    else if (cause === 'peer-close') peer.close();
    else client.close();
    if (cause !== 'error') await closed;
    await rejected;
    expect(client.connected).toBe(false);
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
    expect(socket.listenerCount('message')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
    expect(removed).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
    client.close();
    expect(disconnected).toHaveBeenCalledOnce();
    await closed;
  } finally {
    vi.restoreAllMocks();
    socket?.terminate();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
