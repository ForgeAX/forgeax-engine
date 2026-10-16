import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { startServer } from '../server';

type Response = {
  result?: { methods?: Array<{ name: string }>; roots?: Record<string, unknown> };
  error?: { code: number; data?: { code?: string } };
};

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function request(ws: WebSocket, payload: unknown): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      ws.off('message', onMessage);
      try {
        resolve(JSON.parse(raw.toString()) as Response);
      } catch (error) {
        reject(error);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(payload));
  });
}

describe('remote profiler method roster', () => {
  it('keeps profiler capability inside eval/introspect without adding an RPC method', async () => {
    const profiler = createProfiler();
    const started = await startServer({ port: 0, host: '127.0.0.1', world: {}, profiler });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const ws = await connect(started.value.port);
    try {
      const response = await request(ws, {
        jsonrpc: '2.0',
        method: 'introspect',
        id: 1,
      });
      expect(response.result?.methods?.map((method) => method.name)).toEqual([
        'eval',
        'introspect',
      ]);
      expect(response.result?.roots?.profiler).toBeDefined();
    } finally {
      ws.close();
      await started.value.close();
    }
  });

  it('keeps the existing JSON-RPC error mapping for unknown methods', async () => {
    const started = await startServer({ port: 0, host: '127.0.0.1', world: {} });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const ws = await connect(started.value.port);
    try {
      const response = await request(ws, {
        jsonrpc: '2.0',
        method: 'profile.capture',
        id: 2,
      });
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.data).toBeUndefined();
    } finally {
      ws.close();
      await started.value.close();
    }
  });
});
