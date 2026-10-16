import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileNames = ['game.js', 'workers/probe.js', 'options.js', 'game.json', 'project.config.json'];
const reasons = ['v2-not-admitted', 'two-workers-replied', 'deadline', 'native-error', 'main-failed', 'worker-error', 'worker-killed'];

export async function receiveWorkerReport({ publication, out, reportUrl, deadlineMs = 180000, onReady }) {
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})(\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.exec(reportUrl ?? '');
  if (!match || match[0] !== reportUrl || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error('invalid loopback report URL');
  if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 600000) throw Error('deadline must be 100..600000 ms');
  const root = resolve(publication), destination = resolve(out);
  const manifest = JSON.parse(await readFile(join(root, 'probe-manifest.json'), 'utf8'));
  if (manifest.kind !== 'forgeax-worker-probe-build' || manifest.schema !== 1
    || !/^[A-Za-z0-9_-]{1,96}$/.test(manifest.runId ?? '')
    || !isDeepStrictEqual(Object.keys(manifest.files ?? {}).sort(), [...fileNames].sort())) throw Error('invalid Worker probe manifest');
  for (const name of fileNames) {
    const bytes = await readFile(join(root, name)), row = manifest.files[name];
    if (row.bytes !== bytes.length || row.sha256 !== hash(bytes)) throw Error(`publication drift: ${name}`);
  }
  if (!isDeepStrictEqual(manifest.source, { entrySha256: manifest.files['game.js'].sha256,
    workerSha256: manifest.files['workers/probe.js'].sha256 })) throw Error('invalid entry identity');
  await mkdir(destination, { mode: 0o700 });
  let result, savedReceipt, timer, receiving = false;
  const server = createServer();
  const stoppedAt = Date.now() + deadlineMs;
  const completion = new Promise((done) => {
    const finish = (value) => {
      if (result) return;
      result = savedReceipt ?? value;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      done(result);
    };
    timer = setTimeout(() => finish({ status: 'timeout', reason: 'deadline' }), deadlineMs);
    server.on('error', (error) => finish({ status: 'failed', reason: error.message }));
    server.on('request', async (request, response) => {
      const reply = (status, value, terminal = false) => {
        if (response.destroyed) { if (terminal) finish(value); return; }
        if (terminal) response.once('close', () => finish(value));
        response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify(value), () => { if (terminal) finish(value); });
      };
      if (result) { response.destroy(); return; }
      if (request.method !== 'POST' || request.url !== match[2]) {
        reply(404, { status: 'rejected', reason: 'unexpected endpoint' }); return;
      }
      if (receiving) { reply(409, { status: 'rejected', reason: 'already receiving' }); return; }
      receiving = true;
      try {
        const header = (name) => {
          const values = request.rawHeaders.filter((_, index) => index % 2 === 0)
            .filter((key) => key.toLowerCase() === name);
          if (values.length !== 1) throw Error(`requires one ${name} header`);
          return request.headers[name];
        };
        const length = header('content-length'), expectedHash = header('x-forgeax-report-sha256');
        if (!/^[0-9]+$/.test(length ?? '') || Number(length) < 1 || Number(length) > 65536
          || request.headers['transfer-encoding'] || header('content-type').split(';')[0].trim().toLowerCase() !== 'application/json'
          || header('x-forgeax-report-bytes') !== length || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw Error('invalid report headers or size');
        const parts = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > Number(length) || size > 65536 || Date.now() >= stoppedAt) throw Error('report exceeds body or time bounds');
          parts.push(chunk);
        }
        const body = Buffer.concat(parts);
        if (size !== Number(length) || hash(body) !== expectedHash) throw Error('report hash or length mismatch');
        const report = JSON.parse(body.toString('utf8'));
        if (report.kind !== 'forgeax-worker-capabilities' || report.schema !== 1
          || report.runId !== manifest.runId || !isDeepStrictEqual(report.source, manifest.source)
          || !reasons.includes(report.reason) || !Number.isFinite(report.startedAt)
          || !Number.isFinite(report.finishedAt) || report.finishedAt < report.startedAt
          || !Array.isArray(report.workers) || report.workers.length > 2
          || !Array.isArray(report.errors) || report.errors.length > 16) throw Error('unexpected or unfinished Worker report');
        if (report.reason === 'v2-not-admitted'
          && (report.facts?.standardWorker === true || report.workers.length !== 0)) throw Error('inconsistent admission result');
        if (result || Date.now() >= stoppedAt) { finish({ status: 'timeout', reason: 'deadline' }); return; }
        // At most 64 KiB: finish this local write before the deadline callback can
        // settle. An async write could publish a report after a timeout receipt.
        writeFileSync(join(destination, 'report.json'), body, { flag: 'wx', mode: 0o600 });
        savedReceipt = { status: 'saved', bytes: size, sha256: expectedHash, kind: report.kind,
          runId: manifest.runId, source: manifest.source };
        reply(200, savedReceipt, true);
      } catch (error) {
        if (!result) reply(400, { status: 'rejected', reason: error.message }, true);
      }
    });
    server.headersTimeout = Math.min(10000, deadlineMs);
    server.requestTimeout = Math.min(10000, deadlineMs);
    server.listen(Number(match[1]), '127.0.0.1', () => {
      try { onReady?.({ status: 'listening', reportUrl, maxBytes: 65536, deadlineMs }); }
      catch (error) { finish({ status: 'failed', reason: error.message }); }
    });
  });
  const receipt = await completion;
  await writeFile(join(destination, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { publication: { type: 'string' }, out: { type: 'string' },
    'report-url': { type: 'string' }, 'deadline-ms': { type: 'string' }, help: { type: 'boolean' } } });
  const usage = 'node receive_worker_report.mjs --publication PROBE_DIRECTORY --out NEW_DIRECTORY --report-url http://127.0.0.1:PORT/PATH [--deadline-ms 180000]';
  if (values.help) console.log(usage);
  else {
    if (!values.publication || !values.out || !values['report-url']) throw Error(usage);
    const receipt = await receiveWorkerReport({ publication: values.publication, out: values.out,
      reportUrl: values['report-url'], deadlineMs: values['deadline-ms'] === undefined ? 180000 : Number(values['deadline-ms']),
      onReady: (value) => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.status === 'saved' ? 0 : 1;
  }
}
