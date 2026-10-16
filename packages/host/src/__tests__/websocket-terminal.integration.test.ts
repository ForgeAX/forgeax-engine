import { once } from 'node:events';
import { expect, it } from 'vitest';
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
