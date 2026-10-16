import { World } from '@forgeax/engine/ecs';
import { startServer } from '@forgeax/engine/remote/server';
import { defaultConnect } from '@forgeax/engine/types/inspector-client';
import { defineFeature } from '../../lab/feature';

interface RpcReply {
  result?: unknown;
  error?: { code?: number; message?: string; data?: { code?: string } };
}

function rpc(url: string, payload: string): Promise<RpcReply> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve({ error: { message: 'timeout' } });
    }, 10_000);
    socket.onopen = () => socket.send(payload);
    socket.onerror = () => {
      clearTimeout(timer);
      resolve({ error: { message: 'socket error' } });
    };
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(String(event.data)) as RpcReply);
    };
  });
}

export default defineFeature({
  title: 'Node WebSocket JSON-RPC',
  catalog: 'Node WebSocket JSON-RPC',
  kind: 'headless',
  summary:
    'startServer binds a loopback ws://host:port/inspector JSON-RPC 2.0 server over a live World; introspect returns the OpenRPC document and eval runs scripts with full access, mapping failures to stable numeric codes.',
  expect:
    'port 0 binds an OS port; introspect lists eval+introspect; the shared inspector client evaluates world.inspect().entityCount; a runtime throw is -32002 script-runtime-error; unknown methods are -32601; bad params -32602; malformed JSON -32700; a second bind on the same port fails with server-startup-failed.',
  async run(checks) {
    const world = new World();
    world.spawn();
    world.spawn();
    const started = await startServer({ port: 0, world });
    if (!started.ok) {
      checks.ok('server starts', false, `${started.error.code}: ${started.error.hint}`);
      return;
    }
    const server = started.value;
    const url = `ws://127.0.0.1:${server.port}/inspector`;
    try {
      checks.ok('OS-assigned port', server.port > 0, String(server.port));

      const doc = await rpc(url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'introspect' }));
      const methods = (
        (doc.result as { methods?: { name: string }[] } | undefined)?.methods ?? []
      ).map((m) => m.name);
      checks.equal('introspect methods', methods.sort().join(','), 'eval,introspect');

      const connected = await defaultConnect(url);
      if (!connected.ok) {
        checks.ok('inspector client connects', false, connected.error.code);
      } else {
        const client = connected.value;
        await checks.run('eval counts live entities', async () => {
          const count = await client.eval('world.inspect().entityCount');
          return count === 2 ? 'entityCount 2' : false;
        });
        await checks.run('eval sees a later spawn', async () => {
          world.spawn();
          const count = await client.eval('return world.inspect().entityCount;');
          return count === 3 ? 'entityCount 3' : false;
        });
        await client.dispose();
      }

      const thrown = await rpc(
        url,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eval',
          params: { script: 'throw new Error("boom")' },
        }),
      );
      checks.ok(
        'runtime throw is -32002',
        thrown.error?.code === -32002 && thrown.error.data?.code === 'script-runtime-error',
        JSON.stringify(thrown.error),
      );
      const unknown = await rpc(url, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope' }));
      checks.equal('unknown method is -32601', unknown.error?.code, -32601);
      const params = await rpc(
        url,
        JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'eval', params: {} }),
      );
      checks.equal('missing script is -32602', params.error?.code, -32602);
      const malformed = await rpc(url, '{not json');
      checks.equal('malformed JSON is -32700', malformed.error?.code, -32700);

      const clash = await startServer({ port: server.port, world });
      checks.equal('port clash code', clash.ok ? 'ok' : clash.error.code, 'server-startup-failed');
      if (clash.ok) await clash.value.close();
    } finally {
      await server.close();
    }
    const after = await defaultConnect(url);
    checks.equal(
      'closed server refuses',
      after.ok ? 'connected' : after.error.code,
      'server-not-running',
    );
    if (after.ok) await after.value.dispose();
  },
});
