import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';

test('MCP SDK HTTP parsing survives trailing compressed bytes and serves the next request', { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./support/compressed-request-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', (text) => {
    diagnostics += text;
    process.stderr.write(text);
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const alive = (operation) => Promise.race([operation, exited.then((result) => {
    throw new Error(`MCP HTTP server exited ${JSON.stringify(result)}: ${diagnostics}`);
  })]);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  });
  const [{ port }] = await alive(once(child, 'message'));
  assert.ok(Number.isInteger(port) && port > 0);
  const body = { healthy: true };
  const first = Buffer.concat([gzipSync(JSON.stringify(body)), Buffer.from([0])]);
  const trailing = Buffer.alloc(100 * 1024, 0x58);
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = request({ host: '127.0.0.1', port, path: '/trailing', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': first.length + trailing.length },
    }, (response) => {
      let bytes = '';
      response.setEncoding('utf8').on('data', (text) => { bytes += text; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: bytes }));
    });
    pending.once('error', reject);
  });
  // Send the tail only after the real SDK parser finished the compressed frame.
  // The child has no uncaught-exception handler: the vulnerable dependency exits.
  const parsed = alive(once(child, 'message'));
  pending.write(first);
  assert.deepEqual((await parsed)[0], { parsed: true });
  pending.end(trailing);
  const captured = await alive(response);
  assert.equal(captured.status, 200);
  assert.deepEqual(JSON.parse(captured.body), body);
  const next = await alive(fetch(`http://127.0.0.1:${port}/plain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), body);
});
