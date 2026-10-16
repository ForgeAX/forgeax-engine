import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { observeViteHttpReadiness } from '../vite-http-readiness.mjs';

class FakeViteProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 12345;
}

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test server address missing');
  return `http://127.0.0.1:${address.port}`;
}

describe('observeViteHttpReadiness', () => {
  it('accepts the forced-color banner used by the real gizmo CI Host', async () => {
    const origin = await listen((_request, response) => response.end('ready'));
    const [prefix, port] = origin.split(/:(?=\d+$)/);
    const process = new FakeViteProcess();
    const readiness = observeViteHttpReadiness(process, {
      timeoutEnvName: 'FORGEAX_TEST_GIZMO_VITE_TIMEOUT_MS',
      defaultTimeoutMs: 1000,
      pollIntervalMs: 5,
    });
    process.stdout.write(
      `\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36m${prefix}:\u001b[1m${port}\u001b[22m/\u001b[39m\n`,
    );
    assert.equal((await readiness.wait()).origin, origin);
  });

  it('publishes a Local origin only after the complete ANSI CRLF line at every chunk boundary', async () => {
    let requests = 0;
    const listeningOrigin = await listen((_request, response) => {
      requests++;
      response.statusCode = 200;
      response.end('ready');
    });
    const origin = listeningOrigin.replace('127.0.0.1', 'localhost');
    const line = `\u001b[32m  ➜  Local:\u001b[0m   ${origin}/\r\n`;

    for (let split = 1; split < line.length; split++) {
      const process = new FakeViteProcess();
      const readiness = observeViteHttpReadiness(process, {
        timeoutEnvName: 'FORGEAX_TEST_EVERY_SPLIT_VITE_TIMEOUT_MS',
        defaultTimeoutMs: 1_000,
        pollIntervalMs: 2,
      });
      const requestCountBefore = requests;
      const ready = readiness.wait();

      process.stdout.write(line.slice(0, split));
      await new Promise((resolve) => setTimeout(resolve, 8));
      assert.equal(requests, requestCountBefore, `split=${split}`);

      process.stdout.write(line.slice(split));
      assert.equal((await ready).origin, origin, `split=${split}`);
      assert.equal(requests, requestCountBefore + 1, `split=${split}`);
    }
  });

  it('reassembles ANSI-decorated Local output split across arbitrary stdout chunks and waits for HTTP 2xx', async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
      requests++;
      response.statusCode = requests === 1 ? 503 : 200;
      response.end(requests === 1 ? 'warming' : 'ready');
    });
    const process = new FakeViteProcess();
    const readiness = observeViteHttpReadiness(process, {
      timeoutEnvName: 'FORGEAX_TEST_SPLIT_VITE_TIMEOUT_MS',
      defaultTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });

    process.stderr.write('Local: http://127.0.0.1:1/\n');
    process.stdout.write('\u001b[32mLo');
    process.stdout.write('cal:\u001b[0m htt');
    process.stdout.write(`${origin.slice(3)}/`);
    process.stdout.write('\n');

    assert.equal((await readiness.wait()).origin, origin);
    assert.ok(requests >= 2);
  });

  it('reports an early process exit with bounded output diagnostics', async () => {
    const process = new FakeViteProcess();
    const readiness = observeViteHttpReadiness(process, {
      timeoutEnvName: 'FORGEAX_TEST_EXIT_VITE_TIMEOUT_MS',
      defaultTimeoutMs: 500,
      outputLimit: 32,
      pollIntervalMs: 5,
    });
    process.stdout.write(`${'discard-'.repeat(10)}tail-marker`);
    process.emit('exit', 7, null);

    await assert.rejects(readiness.wait(), /Vite exited before readiness/);
    await assert.rejects(readiness.wait(), /tail-marker/);
  });

  it('times out with the last non-2xx HTTP status and bounded output tail', async () => {
    const origin = await listen((_request, response) => {
      response.statusCode = 503;
      response.end('warming');
    });
    const process = new FakeViteProcess();
    const readiness = observeViteHttpReadiness(process, {
      timeoutEnvName: 'FORGEAX_TEST_TIMEOUT_VITE_TIMEOUT_MS',
      defaultTimeoutMs: 80,
      outputLimit: 48,
      pollIntervalMs: 5,
    });
    process.stdout.write(`${'discard-'.repeat(10)}Local: ${origin}/\n`);

    await assert.rejects(readiness.wait(), /Vite did not become HTTP-ready/);
    await assert.rejects(readiness.wait(), /"lastStatus":503/);
  });
});
