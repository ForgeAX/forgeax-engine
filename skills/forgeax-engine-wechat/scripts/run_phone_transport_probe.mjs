import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

const kind = 'forgeax-phone-gameplay-control/1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const limit = 24 * 1024 * 1024;

/** One source-bound transport probe. It has no ADB, native input or capture commands. */
export async function createPhoneTransportProbe({ publication, out, timeoutMs = 180000 }) {
  const manifest = JSON.parse(await readFile(join(publication, 'benchmark-manifest.json'), 'utf8'));
  const phone = manifest.source.phone;
  assert.equal(phone.mode, 'transport-probe');
  const url = new URL(phone.controlUrl);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
  const source = phone.reportSource,
    events = [];
  let current,
    stage = 0,
    finished = false,
    acceptedBody;
  const atMs = () => Number(process.hrtime.bigint()) / 1e6;
  const event = (name, detail) => events.push({ name, atMs: atMs(), ...detail });
  await mkdir(out, { mode: 0o700 });
  const save = (name, value) =>
    writeFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `${url.pathname}/report`);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= limit, 'Report exceeds 24 MiB');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks),
        sha256 = hash(body);
      assert.equal(request.headers['x-forgeax-report-bytes'], String(bytes));
      assert.equal(request.headers['x-forgeax-report-sha256'], sha256);
      const report = JSON.parse(body);
      assert.equal(report.kind, 'forgeax-phone-gameplay');
      assert.equal(report.schemaVersion, 'forgeax-phone-gameplay/1');
      assert.equal(report.mode, 'transport-probe');
      assert.equal(report.runId, phone.runId);
      assert.deepEqual(report.source, source);
      assert.ok(['complete', 'partial'].includes(report.status));
      if (acceptedBody) assert.equal(sha256, acceptedBody, 'Terminal bytes changed');
      else {
        acceptedBody = sha256;
        await writeFile(join(out, 'phone-report.json'), body, { mode: 0o600, flag: 'wx' });
      }
      const receipt = { status: 'saved', bytes, sha256 };
      await save('report-receipt.json', receipt);
      event('report', { receipt });
      const toggles = report.debugReceipts?.map((value) => [value.enableDebug, value.status]);
      const passed =
        report.status === 'complete' &&
        stage === 3 &&
        report.websocket?.bidirectionalAfterDebugFalse === true &&
        JSON.stringify(toggles) ===
          JSON.stringify([
            [true, 'success'],
            [false, 'success'],
            [true, 'success'],
          ]) &&
        report.websocket.events?.some((value) => value.name === 'close');
      const summary = {
        kind: 'forgeax-phone-transport-probe/1',
        runId: phone.runId,
        status: passed ? 'complete' : 'partial',
        source,
        receipt,
        websocketStage: stage,
        bidirectionalAfterDebugFalse: report.websocket?.bidirectionalAfterDebugFalse === true,
        debugReceipts: report.debugReceipts,
        failure: report.failure ?? null,
        qualification:
          'No native input or performance capture; real phone evidence only when run there.',
      };
      await save('transport-events.json', events);
      await save('probe-summary.json', summary);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(receipt));
      finished = true;
      clearTimeout(timer);
      resolveDone(summary);
    } catch (error) {
      event('report-rejected', { error: String(error) });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: limit,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== `${url.pathname}/control` || current || finished) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) =>
      sockets.emit('connection', websocket),
    );
  });
  sockets.on('connection', (socket) => {
    current = socket;
    event('open', {});
    socket.on('error', (error) => event('socket-error', { error: String(error) }));
    socket.on('close', (code, reason) => event('close', { code, reason: String(reason) }));
    socket.on('message', (bytes, binary) => {
      try {
        assert.equal(binary, false);
        const message = JSON.parse(String(bytes));
        assert.equal(message.kind, kind);
        assert.equal(message.runId, phone.runId);
        assert.deepEqual(message.source, source);
        assert.equal(message.probeOnly, true);
        assert.equal(message.stage, ['ready', 'debug-closed', 'probe-complete'][stage]);
        if (stage === 1) {
          assert.equal(message.debugReceipt.api, 'wx.setEnableDebug');
          assert.equal(message.debugReceipt.enableDebug, false);
          assert.equal(message.debugReceipt.status, 'success');
          assert.ok(
            Object.hasOwn(message.debugReceipt, 'success'),
            'Official success callback required',
          );
        }
        event('receive', { message });
        const reply = {
          kind,
          runId: phone.runId,
          source,
          probeOnly: true,
          stage: message.stage,
          action: ['disable-debug', 'arm', 'close'][stage++],
        };
        event('send', { message: reply });
        socket.send(JSON.stringify(reply));
      } catch (error) {
        event('control-rejected', { error: String(error) });
        socket.close(1008, 'Invalid source or probe stage');
      }
    });
  });
  const timer = setTimeout(async () => {
    const summary = {
      status: 'partial',
      failure: 'transport-probe-deadline',
      websocketStage: stage,
      runId: phone.runId,
      source,
    };
    await save('transport-events.json', events);
    await save('probe-summary.json', summary);
    resolveDone(summary);
  }, timeoutMs);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(url.port), '127.0.0.1', resolve);
  });
  await save('receiver.json', {
    url: phone.controlUrl,
    runId: phone.runId,
    source,
    websocketPath: `${url.pathname}/control`,
    noNativeInput: true,
  });
  return {
    done,
    async close() {
      clearTimeout(timer);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      publication: { type: 'string' },
      out: { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  assert.ok(values.publication && values.out, '--publication and --out required');
  const controller = await createPhoneTransportProbe({
    publication: resolve(values.publication),
    out: resolve(values.out),
    timeoutMs: Number(values.timeout ?? 180) * 1000,
  });
  console.log(JSON.stringify({ status: 'listening', out: resolve(values.out) }));
  try {
    const result = await controller.done;
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'complete' ? 0 : 1;
  } finally {
    await controller.close();
  }
}
