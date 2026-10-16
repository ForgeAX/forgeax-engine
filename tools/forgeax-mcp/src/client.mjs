import { readFile, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
export async function createBridgeClient(rootArg) {
  const root = await realpath(resolve(rootArg));
  const statePath = join(root, '.forgeax', 'host', 'mcp-bridge.json');
  function failure(code, expected, hint) {
    return { ok: false, error: { code, expected, hint } };
  }

  async function request(tool, args, signal) {
    if (signal?.aborted)
      return failure('mcp-cancelled', 'an active MCP request', 'Retry when ready.');
    let state;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      return failure(
        'backend-not-ready',
        'a running ForgeaX MCP Host Pack',
        'Start this project backend with tools/forgeax-mcp/host.pack.json.',
      );
    }
    if (
      state.root !== root ||
      typeof state.socketPath !== 'string' ||
      typeof state.token !== 'string' ||
      typeof state.id !== 'string'
    )
      return failure(
        'root-mismatch',
        'the exact connected project root',
        'Connect the MCP client to the matching backend.',
      );
    return new Promise((done) => {
      let settled = false;
      let buffer = '';
      const socket = createConnection(state.socketPath);
      const onAbort = () =>
        finish(failure('mcp-cancelled', 'an active MCP request', 'Retry when ready.'));
      const finish = (result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        done(result);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      socket.setTimeout(18_000, () =>
        finish(
          failure('bridge-timeout', 'a bounded Host response', 'Check backend health and retry.'),
        ),
      );
      socket.on('error', () =>
        finish(
          failure(
            'backend-unreachable',
            'the active local Host bridge',
            'Restart the matching backend and retry.',
          ),
        ),
      );
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ id: state.id, token: state.token, root, tool, args })}\n`),
      );
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > 32_768)
          return finish(
            failure('bridge-result-too-large', 'a bounded Host result', 'Narrow the query.'),
          );
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          finish(JSON.parse(buffer.slice(0, newline)));
        } catch {
          finish(
            failure('bridge-invalid-result', 'one JSON result', 'Restart the matching backend.'),
          );
        }
      });
      socket.on('end', () =>
        finish(
          failure(
            'backend-disconnected',
            'a completed Host result',
            'Retry after checking backend status.',
          ),
        ),
      );
    });
  }

  return { root, request };
}
