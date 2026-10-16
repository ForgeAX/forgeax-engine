import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import bridge from '../src/bridge.mjs';

const root = await mkdtemp(join(tmpdir(), 'forgeax-codex-bridge-disconnect-'));
let release;
let settleRun;
let running;
const started = new Promise(resolveStarted => { running = resolveStarted; });
const toolApi = {
  list: () => [{ callable: true, descriptor: { id: 'view.status' },
    owner: { sourceId: 'view', providerId: 'view', generation: 1 } }],
  run: () => {
    running();
    return { terminal: new Promise(resolveRun => { settleRun = resolveRun; }) };
  },
};
try {
  await bridge.apply({
    devkitBackend: { root, hostPackageRoot: resolve(import.meta.dirname, '..') },
    toolApi,
    get: () => undefined,
    effect: effect => { release = effect(); },
  });
  const state = JSON.parse(await readFile(join(root, '.forgeax', 'host', 'mcp-bridge.json'), 'utf8'));
  const socket = connect(state.socketPath);
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ id: state.id, root: state.root, token: state.token,
    tool: 'view.status', args: {} })}\n`);
  await started;
  socket.destroy();
  settleRun({ outcome: 'succeeded', result: { phase: 'stopped' } });
  await new Promise(done => setTimeout(done, 100));
  assert.equal(socket.destroyed, true);
  const idle = connect(state.socketPath);
  idle.on('error', () => {});
  await once(idle, 'connect');
  await Promise.race([
    release(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge retirement waited for an idle client')), 2000)),
  ]);
  release = undefined;
  assert.equal(idle.destroyed, true);
  console.log(JSON.stringify({ disconnectedClient: true, hostAlive: true, idleClientRetired: true }));
} finally {
  if (release) await release();
  await rm(root, { recursive: true, force: true });
}
