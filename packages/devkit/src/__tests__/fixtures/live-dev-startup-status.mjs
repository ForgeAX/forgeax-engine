import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'forgeax-live-startup-status-')));
const originalWrite = fs.writeFile;
let release, entered;
const publication = new Promise((resolve) => {
  entered = resolve;
});
const waiting = new Promise((resolve) => {
  release = resolve;
});
const sessionPath = join(root, '.forgeax/dev-session.json');
let delayed = false;
fs.writeFile = async (...args) => {
  // Session publication is atomic (temporary file, then rename), so hold the
  // first write that targets the session record or its temporary sibling.
  if (!delayed && String(args[0]).startsWith(sessionPath)) {
    delayed = true;
    entered();
    await waiting;
  }
  return originalWrite(...args);
};
syncBuiltinESMExports();
const { runLiveDevDaemon } = await import(new URL('../../../dist/index.mjs', import.meta.url));
const { createServer } = await import('node:net');
const portServer = createServer();
await new Promise((ok, fail) => {
  portServer.once('error', fail);
  portServer.listen(0, '127.0.0.1', ok);
});
const port = portServer.address().port;
await new Promise((ok) => portServer.close(ok));
const lifetime = new AbortController();
const closed = runLiveDevDaemon(root, port, undefined, { signal: lifetime.signal });
const report = { status: 'RUNNING', root, port, observations: [] };
try {
  await Promise.race([
    publication,
    closed.then(() => {
      throw Error('Owner closed before publication');
    }),
  ]);
  const status = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(500),
      headers: { connection: 'close' },
    });
    const result = await response.json();
    assert.equal(result.ok, true);
    report.observations.push(result.value);
    return result.value;
  };
  const before = await status();
  assert.equal(before.phase, 'starting');
  release();
  const deadline = Date.now() + 10_000;
  let phase;
  while (phase !== 'failed' && Date.now() < deadline) {
    phase = (await status()).phase;
    if (phase !== 'failed') await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(phase, 'failed');
  report.projectLog = await fs.readFile(join(root, '.forgeax/dev.log'), 'utf8');
  assert.equal(report.projectLog.match(/live project: loading DevKit host/g)?.length, 1);
  report.status = 'PASS';
} finally {
  release();
  fs.writeFile = originalWrite;
  syncBuiltinESMExports();
  lifetime.abort();
  await closed;
  await fs.rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
