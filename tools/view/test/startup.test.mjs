import viewRoot from '../src/plugin.ts';
import { startNativePlugin } from '@forgeax/engine-plugin';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDevKitBackend } from '@forgeax/engine/devkit';
import { createBackendHost } from '@forgeax/engine-host';
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import display from '../packages/view-plugin-display/src/backend.ts';
import workspaceBackend from '../packages/view-workspace-core/src/backend.ts';
import { createViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';
import viewPlugin from '../src/plugin.ts';
import { attachViewPage } from '../src/page.ts';
import { VIEW_STATUS_SERVICE, VIEW_STATUS_TOPIC } from '../packages/view-plugin-display/src/identity.ts';

function call(host, operation, sourceId, args = {}) {
  const api = host.context.toolApi;
  const owner = api.describe(operation, sourceId).find(record => record.callable)?.owner;
  assert.ok(owner, operation);
  return api.run(operation, args, { ...owner }).terminal.then(terminal => {
    assert.equal(terminal.outcome, 'succeeded', JSON.stringify(terminal));
    return terminal.result;
  });
}

async function until(probe) {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await new Promise(done => setTimeout(done, 20));
  }
}

test('View native plugin start/stop and removal preserve the owning Engine Host', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'view-startup-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-startup-fixture', type: 'module', dependencies: { '@forgeax/engine': '0.2.0' } }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>View fixture</title>');
  await writeFile(join(root, 'forge.json'), JSON.stringify({
    schemaVersion: '3.0.0', id: 'fixture', name: 'Fixture', roots: {},
  }));
  const engine = await createDevKitBackend(root);
  try {
    const host = engine.host;
    const workspace = host.context.engineWorkspace;
    let fiber = await host.context.plugin(viewPlugin, { staticRoot: root });
    await fiber.await();
    const start = () => call(host, 'view.start', 'view-launcher');
    const first = await start();
    assert.equal(first.phase, 'ready');
    assert.match(first.presentationId, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(first.url)).status, 200);
    assert.equal(workspace.project, undefined);
    assert.deepEqual(await start(), first, 'reopening preserves the current View presentation');
    assert.equal((await call(host, 'view.stop', 'view-launcher')).phase, 'stopped');
    assert.equal(host.context.engineWorkspace, workspace);
    assert.ok(host.context.toolApi.describe('engine.project.open', 'engine-workspace').some(record => record.callable));
    await fiber.dispose();
    fiber = await host.context.plugin(viewPlugin, { staticRoot: root, port: Number(new URL(first.url).port) });
    await fiber.await();
    const second = await start();
    assert.equal(second.url, first.url, 'a replacement may reuse the exact public URL');
    assert.notEqual(second.presentationId, first.presentationId, 'presentation identity belongs to the owner lifetime, not its URL');
    await fiber.dispose();
    assert.equal(host.context.engineWorkspace, workspace);
    assert.equal(host.context.get('devkitWorkspaceFrontend'), undefined);
    assert.equal(host.context.toolApi.describe('view.start', 'view-launcher').filter(record => record.callable).length, 0);
    await assert.rejects(fetch(second.url));
  } finally { await engine.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('observation requires an exact independent binding and discards late results', { timeout: 12_000 }, async () => {
  const host = await createBackendHost({ pairs: [] });
  const context = host.context;
  context.provide('viewWorkspaceCore', {});
  let calls = [];
  let complete;
  let result = { status: { runId: 'a', phase: 'ready' }, screenshot: 'old' };
  const schema = toolJsonSchema({ type: 'object' });
  const provider = context.toolApi.registerProvider({
    sourceId: 'engine-workspace', providerId: 'fixture', realm: 'host', module: 'fixture',
    tools: [defineTool({ id: 'engine.run.observe', path: ['engine', 'run', 'observe'], title: 'Observe', summary: 'Fixture', realm: 'host', argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [] }, args => {
      calls.push(args.root);
      if (args.root === '/pending') return new Promise(resolve => { complete = resolve; });
      return result;
    })],
  });
  const fiber = await context.plugin(display);
  await fiber.await();
  const bind = args => call(host, 'view.display.bind', 'view-backend', args);
  const snapshot = () => context.viewStatus();
  try {
    assert.equal(snapshot().status, 'idle');
    assert.deepEqual(calls, []);
    await bind({ root: '/pending', runId: 'a' });
    await until(() => complete);
    await bind({ root: '/new', runId: 'b' });
    assert.equal(snapshot().observation, null);
    complete(result);
    await until(() => calls.includes('/new'));
    assert.equal(snapshot().status, 'unavailable');
    assert.equal(snapshot().observation, null);
    result = { status: { runId: 'b', phase: 'ready' }, screenshot: 'new' };
    await bind({ root: '/new', runId: 'b' });
    await until(() => snapshot().status === 'running');
    assert.deepEqual(snapshot().binding, { root: '/new', runId: 'b' });
    assert.equal(snapshot().observation.screenshot, 'new');
    await bind({ root: null });
    assert.equal(snapshot().observation, null);
    const count = calls.length;
    await new Promise(done => setTimeout(done, 1100));
    assert.equal(calls.length, count);
    await fiber.dispose();
    assert.equal(host.transport.snapshot('forgeax.view.status.get'), undefined);
  } finally { await provider.revoke(); await host.dispose(); }
});

test('discovers a project run once and never follows a replacement without another bind', { timeout: 12_000 }, async () => {
  const host = await createBackendHost({ pairs: [] });
  const context = host.context;
  context.provide('viewWorkspaceCore', {});
  let runId = 'discovered-run';
  let complete;
  const schema = toolJsonSchema({ type: 'object' });
  const provider = context.toolApi.registerProvider({
    sourceId: 'engine-workspace', providerId: 'discovery', realm: 'host', module: 'fixture',
    tools: [defineTool({ id: 'engine.run.observe', path: ['engine', 'run', 'observe'], title: 'Observe', summary: 'Fixture', realm: 'host', argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [] }, args => {
      if (args.root === '/pending') return new Promise(resolve => { complete = resolve; });
      return { status: { runId, phase: 'ready' }, image: { png: `data:image/png;base64,${runId}` } };
    })],
  });
  const fiber = await context.plugin(display);
  await fiber.await();
  const bind = args => call(host, 'view.display.bind', 'view-backend', args);
  const snapshot = () => context.viewStatus();
  try {
    await bind({ root: '/project' });
    await until(() => snapshot().status === 'running');
    assert.deepEqual(snapshot().binding, { root: '/project', runId: 'discovered-run' });
    runId = 'replacement';
    await until(() => snapshot().status === 'unavailable');
    assert.equal(snapshot().binding.runId, 'discovered-run');
    assert.equal(snapshot().observation.image.png, 'data:image/png;base64,discovered-run');
    await bind({ root: '/project' });
    await until(() => snapshot().status === 'running');
    assert.equal(snapshot().binding.runId, 'replacement');
    const pending = bind({ root: '/pending' });
    await until(() => complete);
    await bind({ root: null });
    complete({ status: { runId: 'late', phase: 'ready' } });
    await pending;
    assert.equal(snapshot().binding, null);
    assert.equal(snapshot().observation, null);
  } finally { await fiber.dispose(); await provider.revoke(); await host.dispose(); }
});

test('Display bindings and topic deliveries belong to each frontend connection', { timeout: 12_000 }, async () => {
  const host = await createBackendHost({ pairs: [] });
  const context = host.context;
  context.provide('viewWorkspaceCore', {});
  context.provide('engineWorkspace', { project: { target: { sessionId: 'display-session', targetId: 'display-target' } } });
  let observedA = 0;
  const schema = toolJsonSchema({ type: 'object' });
  const provider = context.toolApi.registerProvider({
    sourceId: 'engine-workspace', providerId: 'two-runs', realm: 'host', module: 'fixture',
    tools: [defineTool({ id: 'engine.run.observe', path: ['engine', 'run', 'observe'], title: 'Observe', summary: 'Fixture', realm: 'host', argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [] }, args => {
      if (args.root === '/a') observedA += 1;
      return {
        status: { runId: args.root === '/a' ? 'a' : 'b', phase: 'ready' }, screenshot: args.root,
      }; })],
  });
  const fiber = await context.plugin(display);
  await fiber.await();
  const a = host.transport.connect({ kind: 'frontend', sourceId: 'forgeax-workspace:display-session:display-target' });
  const b = host.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const eventsA = []; const eventsB = [];
  const unsubscribeA = a.subscribe(VIEW_STATUS_TOPIC, state => eventsA.push(state));
  const unsubscribeB = b.subscribe(VIEW_STATUS_TOPIC, state => eventsB.push(state));
  const owner = context.toolApi.describe('view.display.bind', 'view-backend').find(record => record.callable)?.owner;
  assert.ok(owner);
  const bind = async (client, root, runId) => {
    const terminal = await context.toolApi.run('view.display.bind', { root, runId }, { ...owner, caller: client.caller }).terminal;
    assert.equal(terminal.outcome, 'succeeded', JSON.stringify(terminal));
  };
  try {
    await bind(a, '/a', 'a');
    await until(() => eventsA.some(event => event.observation?.screenshot === '/a'));
    assert.equal(eventsB.length, 0);
    assert.equal((await a.request(VIEW_STATUS_SERVICE)).binding.root, '/a');
    assert.equal((await b.request(VIEW_STATUS_SERVICE)).status, 'idle');
    assert.equal(context.viewStatus(a.caller).binding.root, '/a');
    assert.equal(context.viewStatus(b.caller).status, 'idle');
    await bind(b, '/b', 'b');
    await until(() => eventsB.some(event => event.observation?.screenshot === '/b'));
    assert.ok(eventsA.every(event => event.binding?.root === '/a'));
    assert.ok(eventsB.every(event => event.binding?.root === '/b'));
    assert.equal(context.viewStatus().status, 'idle');
    context.engineWorkspace.project = undefined;
    a.close();
    const observationsAfterClose = observedA;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(observedA, observationsAfterClose, 'retiring the project before disconnect must stop page observation');
    assert.equal((await b.request(VIEW_STATUS_SERVICE)).binding.root, '/b');
  } finally {
    unsubscribeA(); unsubscribeB(); b.close();
    await fiber.dispose(); await provider.revoke(); await host.dispose();
  }
});

test('Display binding keeps the frontend caller through workspace ToolApi routing', { timeout: 12_000 }, async () => {
  const host = await createBackendHost({ pairs: [] });
  const context = host.context;
  const schema = toolJsonSchema({ type: 'object' });
  const provider = context.toolApi.registerProvider({
    sourceId: 'engine-workspace', providerId: 'missing-run', realm: 'host', module: 'fixture',
    tools: [defineTool({ id: 'engine.run.observe', path: ['engine', 'run', 'observe'], title: 'Observe', summary: 'Fixture', realm: 'host', argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [] }, () => ({ status: { runId: 'some-other-run', phase: 'ready' } }))],
  });
  const workspace = await context.plugin(workspaceBackend);
  await workspace.await();
  const fiber = await context.plugin(display);
  await fiber.await();
  const raw = host.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  context.viewWorkspaceCore.attachPageSession(raw.caller, host.transport);
  const client = createViewWorkspaceClient({ transport: raw, clientId: 'view-frontend', token: context.viewWorkspaceAccessToken });
  const events = [];
  const unsubscribe = raw.subscribe(VIEW_STATUS_TOPIC, state => events.push(state));
  try {
    await client.call('display.bind', { root: '/project', runId: 'exact-missing-run' });
    await until(() => events.some(event => event.status === 'unavailable'));
    assert.match((await raw.request(VIEW_STATUS_SERVICE)).error, /no longer active/);
    const second = host.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    context.viewWorkspaceCore.attachPageSession(second.caller, host.transport);
    const cliRaw = host.transport.connect();
    const cli = createViewWorkspaceClient({ transport: cliRaw, clientId: 'view-cli', token: context.viewWorkspaceAccessToken });
    await assert.rejects(() => cli.openAsset('scene-guid', { projectId: 'project' }),
      error => error.code === 'view-page-ambiguous');
    cliRaw.close(); second.close();
  } finally {
    unsubscribe(); raw.close();
    await fiber.dispose(); await workspace.dispose(); await provider.revoke(); await host.dispose();
  }
});

test('borrowed Page cleanup normalizes its URL and rolls back failed mounting', async () => {
  let url = 'about:blank';
  const page = { async goto(next) { url = next; }, url: () => url, isClosed: () => false, async waitForFunction() {} };
  const attached = await attachViewPage({ page, url: 'http://localhost:3000' });
  await attached.dispose();
  assert.equal(url, 'about:blank');
  page.waitForFunction = async () => { throw new Error('mount failed'); };
  await assert.rejects(attachViewPage({ page, url: 'http://localhost:3000' }), /mount failed/);
  assert.equal(url, 'about:blank');
  page.waitForFunction = async () => {};
  const borrowed = await attachViewPage({ page, url: 'http://localhost:3000' });
  url = 'http://user.example/';
  await borrowed.dispose();
  assert.equal(url, 'http://user.example/');
});

test('native removal joins in-flight View socket setup and leaves no listener', { timeout: 10_000 }, async () => {
  const { Server } = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'view-start-race-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>View fixture</title>');
  const engine = await createDevKitBackend(root);
  const originalListen = Server.prototype.listen;
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  try {
    const installed = await startNativePlugin(engine.host.context, viewRoot, { staticRoot: root });
    assert.equal(installed.ok, true);
    Server.prototype.listen = function (...args) {
      release = () => originalListen.apply(this, args);
      enter(this);
      return this;
    };
    const api = engine.host.context.toolApi;
    const owner = api.describe('view.start', 'view-launcher').find(record => record.callable).owner;
    const run = api.run('view.start', {}, owner);
    const socketServer = await entered;
    const disposed = installed.value.dispose();
    Server.prototype.listen = originalListen;
    release();
    await disposed;
    await run.terminal;
    assert.equal(socketServer.listening, false);
    assert.equal(engine.host.context.get('devkitWorkspaceFrontend'), undefined);
    assert.ok(api.describe('engine.project.open', 'engine-workspace').some(record => record.callable));
  } finally {
    Server.prototype.listen = originalListen;
    await engine.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test('failed socket cleanup remains failed on repeat close', async () => {
  const { startViewHostServer } = await import('../packages/view-workspace-core/src/resident.ts');
  const host = await createBackendHost();
  const resident = await startViewHostServer({ backendHost: host, accessToken: 'fixture' });
  const realClose = resident.server.close.bind(resident.server);
  resident.server.close = callback => realClose(() => callback(new Error('injected close failure')));
  try {
    const closing = resident.close();
    await assert.rejects(closing, /cleanup failed/);
    assert.equal(resident.close(), closing);
    await assert.rejects(resident.close(), /cleanup failed/);
    assert.equal(resident.server.listening, false);
  } finally { await host.dispose(); }
});

test('View reports failed domain cleanup after native teardown consumes the effect', async () => {
  const { Server } = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'view-close-race-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>View fixture</title>');
  const engine = await createDevKitBackend(root);
  const originalClose = Server.prototype.close;
  try {
    const installed = await startNativePlugin(engine.host.context, viewRoot, { staticRoot: root });
    assert.equal(installed.ok, true);
    const api = engine.host.context.toolApi;
    await call(engine.host, 'view.start', 'view-launcher');
    Server.prototype.close = function (callback) {
      return originalClose.call(this, () => callback(new Error('injected domain cleanup failure')));
    };
    const product = [...engine.host.context.registry.values()].find(runtime => runtime.name === 'forgeax.view.product');
    await [...product.fibers][0].dispose();
    Server.prototype.close = originalClose;
    const owner = api.describe('view.stop', 'view-launcher').find(record => record.callable).owner;
    assert.equal((await api.run('view.stop', {}, owner).terminal).outcome, 'failed');
    assert.equal((await call(engine.host, 'view.status', 'view-launcher')).phase, 'failed');
    const startOwner = api.describe('view.start', 'view-launcher').find(record => record.callable).owner;
    assert.equal((await api.run('view.start', {}, startOwner).terminal).outcome, 'failed');
  } finally {
    Server.prototype.close = originalClose;
    await engine.dispose(); await rm(root, { recursive: true, force: true });
  }
});
