import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { startOwnedServer, stopOwnedServer } from '../owned-dev-server.mjs';

const childServerSource = `
  import { spawn } from 'node:child_process';
  import { createServer } from 'node:http';
  import process from 'node:process';

  const portIndex = process.argv.indexOf('--port');
  const port = Number(process.argv[portIndex + 1]);
  const idleChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('owned');
  });
  server.listen(port, '127.0.0.1');
  const shutdown = () => {
    server.close(() => {
      idleChild.kill('SIGTERM');
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('occupied listener cannot satisfy readiness and owned process tree is cleaned', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'forgeax-owned-dev-server-'));
  const stateFile = join(tempRoot, 'owned.json');
  const fixtureFile = join(tempRoot, 'owned-server.mjs');
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(fixtureFile, childServerSource),
  );

  const foreignServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('foreign');
  });
  const foreignPort = await listen(foreignServer);

  let state;
  try {
    state = await startOwnedServer({
      command: process.execPath,
      args: [fixtureFile, '--port', '__PORT__'],
      cwd: tempRoot,
      requestedPort: foreignPort,
      stateFile,
      readinessPath: '/',
      writeEnvironment: false,
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    assert.equal(state.requestedPortOccupied, true);
    assert.notEqual(state.port, foreignPort);
    assert.equal(await fetch(state.url).then((response) => response.text()), 'owned');
    assert.equal(state.processAliveAtReadiness, true);
    assert.ok(state.listenerPids.some((pid) => state.treePidsAtReadiness.includes(pid)));
    assert.ok(state.treePidsAtReadiness.length >= 2);

    const cleanup = await stopOwnedServer({ stateFile });
    assert.deepEqual(cleanup.remainingTreePids, []);
    assert.deepEqual(cleanup.remainingListenerPids, []);

    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual(saved.cleanup.remainingTreePids, []);
    assert.deepEqual(saved.cleanup.remainingListenerPids, []);
  } finally {
    if (state?.cleanup === undefined) {
      await stopOwnedServer({ stateFile, allowMissing: true });
    }
    await new Promise((resolve) => foreignServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
