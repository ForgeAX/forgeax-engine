import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

/** Fixed transport only; Python retains input, arm clocks, validation and report ownership. */
export async function startGameplaySocketHost(config) {
  const external = new URL(config.controlUrl),
    backend = new URL(config.backendUrl);
  assert.equal(external.hostname, '127.0.0.1');
  assert.equal(backend.hostname, '127.0.0.1');
  assert.equal(external.protocol, 'http:');
  assert.equal(backend.protocol, 'http:');
  const events = [];
  let client;
  const record = (name, detail) => {
    if (events.length < 64) events.push({ name, atMs: performance.now(), ...detail });
  };
  const save = () =>
    writeFile(config.eventsFile, `${JSON.stringify(events, null, 2)}\n`, { mode: 0o600 });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `${external.pathname}/report`);
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        assert.ok(length <= 24 * 1024 * 1024);
        chunks.push(chunk);
      }
      const result = await fetch(`${config.backendUrl}/report`, {
        method: 'POST',
        body: Buffer.concat(chunks),
        headers: {
          'content-type': 'application/json',
          'x-forgeax-report-bytes': request.headers['x-forgeax-report-bytes'] ?? '',
          'x-forgeax-report-sha256': request.headers['x-forgeax-report-sha256'] ?? '',
        },
        signal: AbortSignal.timeout(15000),
      });
      const body = await result.text();
      record('report-receipt', { statusCode: result.status, body });
      await save();
      response.writeHead(result.status, {
        'content-type': 'application/json',
        connection: 'close',
      });
      response.end(body);
    } catch (error) {
      record('report-error', { error: String(error) });
      response.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 2 * 1024 * 1024,
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== `${external.pathname}/control` || client) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (socket) => sockets.emit('connection', socket));
  });
  sockets.on('connection', (socket) => {
    client = socket;
    let pending = false;
    record('open', {});
    socket.on('error', (error) => record('error', { error: String(error) }));
    socket.on('close', (code, reason) => {
      record('close', { code, reason: String(reason) });
      void save();
    });
    socket.on('message', async (bytes, binary) => {
      let value;
      try {
        assert.equal(binary, false);
        assert.equal(pending, false);
        value = JSON.parse(String(bytes));
        assert.equal(value.kind, 'forgeax-phone-gameplay-control/1');
        assert.equal(value.runId, config.runId);
        assert.deepEqual(value.source, config.source);
        assert.equal(value.probeOnly, undefined);
        assert.ok(['ready', 'armed', 'release'].includes(value.stage));
        pending = true;
        record('receive', { stage: value.stage });
        const result = await fetch(`${config.backendUrl}/${value.stage}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: String(bytes),
          signal: AbortSignal.timeout(value.stage === 'ready' ? 125000 : 25000),
        });
        const reply = await result.json();
        record('reply', { stage: value.stage, statusCode: result.status, action: reply.action });
        socket.send(
          JSON.stringify({
            kind: value.kind,
            source: config.source,
            ...reply,
            runId: config.runId,
            stage: value.stage,
            ...(result.status === 200 ? {} : { action: 'rejected' }),
          }),
        );
      } catch (error) {
        record('rejected', { stage: value?.stage, error: String(error) });
        socket.close(1008, 'Invalid fixed gameplay control');
      } finally {
        pending = false;
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(external.port), '127.0.0.1', resolve);
  });
  return {
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
      await save();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  assert.ok(values.config, '--config required');
  const config = JSON.parse(await readFile(values.config, 'utf8'));
  const server = await startGameplaySocketHost(config);
  process.stdout.write(
    `${JSON.stringify({ state: 'listening', controlUrl: config.controlUrl })}\n`,
  );
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await server.close();
      process.exit(0);
    });
}
