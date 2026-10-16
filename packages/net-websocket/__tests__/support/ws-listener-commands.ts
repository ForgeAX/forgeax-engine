import { createServer } from 'node:net';
import type { EndpointEvent, NetEndpoint, PeerId } from '@forgeax/engine-net';
import { listenWebSocketEndpoint } from '../../src/node';

type SerializedEvent =
  | { kind: 'peer-connected' | 'peer-disconnected'; peerId: number }
  | { kind: 'message'; peerId: number; data: number[] };

const listeners = new Map<string, NetEndpoint>();
let nextListenerId = 1;

export const websocketListenerCommands = {
  async startWebSocketListener(
    _context: unknown,
    requestedPort?: number,
  ): Promise<{ id: string; url: string }> {
    const port = requestedPort ?? (await reservePort());
    const result = await listenWebSocketEndpoint({ port });
    if (!result.ok) throw result.error;
    const id = String(nextListenerId++);
    listeners.set(id, result.value);
    return { id, url: `ws://127.0.0.1:${port}` };
  },
  pollWebSocketListener(_context: unknown, id: string): SerializedEvent[] {
    return listener(id).poll().map(serializeEvent);
  },
  sendWebSocketListener(
    _context: unknown,
    id: string,
    peerId: number,
    data: number[],
  ): { ok: true } | { ok: false; code: string } {
    const result = listener(id).send(peerId as PeerId, new Uint8Array(data));
    return result.ok ? { ok: true } : { ok: false, code: result.error.code };
  },
  closeWebSocketListener(
    _context: unknown,
    id: string,
  ): { ok: true } | { ok: false; code: string } {
    const endpoint = listeners.get(id);
    if (!endpoint) return { ok: true };
    listeners.delete(id);
    const result = endpoint.close();
    return result.ok ? { ok: true } : { ok: false, code: result.error.code };
  },
};

function listener(id: string): NetEndpoint {
  const endpoint = listeners.get(id);
  if (!endpoint) throw new Error(`Unknown WebSocket listener fixture ${id}.`);
  return endpoint;
}

function serializeEvent(event: EndpointEvent): SerializedEvent {
  if (event.kind === 'message') {
    return { kind: event.kind, peerId: event.peerId, data: [...event.data] };
  }
  return { kind: event.kind, peerId: event.peerId };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
