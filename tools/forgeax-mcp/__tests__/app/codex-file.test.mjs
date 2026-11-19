import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { codexFileEntry, resolveViewFile } from '../../src/codex-file-entry.mjs';
import { FILE_OPEN_TOOL, FILE_UI_URI, TRANSPORT_TOOL, UI_URI } from '../../src/contract.ts';
const { openViewFile, createViewFileOpener } = await import(process.env.FORGEAX_TEST_FILE_OPEN ?? '../../src/app/file-open.ts');
const { createViewAppServer } = await import(process.env.FORGEAX_TEST_APP_SERVER ?? '../../src/app/mcp-server.mjs');

const meta = path => ({ 'openai/resource': { path } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const file = { projectRoot: '/project', sourcePath: 'assets/world.scene.pack.json' };
const running = { project: { id: 'project-id', root: '/project' }, projectStatus: { phase: 'running', sessionId: 'session', generation: 7 } };
function workspace({ state = running, sources, busy = false, ready = Promise.resolve() } = {}) {
  const calls = [], sessionListeners = new Set(), listeners = new Set();
  const client = {
    projectSession: { ready, getSnapshot: () => ({ busy }), subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
      open() { assert.fail('projectSession.open swallows errors and has no per-intent cancellation'); } },
    async getState() { return state; },
    async presentProject(options) { calls.push({ operation: 'present', options }); return state; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async openProject(root, options) { calls.push({ operation: 'project', root, options }); return state = running; },
    transport: { async request(service, input, options) { calls.push({ operation: 'sources', service, input, options }); return { sources: sources ?? [{ sourcePath: file.sourcePath, revision: 'revision', outputs: [{ guid: 'exact-guid', kind: 'scene' }] }], hasMore: false }; } },
    async listAssets(projectId, options) { calls.push({ operation: 'catalog', projectId, options }); return { assets: [] }; },
    async openAsset(guid, options) { calls.push({ operation: 'asset', guid, options }); },
    async revealPack(input, options) { calls.push({ operation: 'reveal', input, options }); return { ok: true }; },
  };
  return { client, calls, sessionListeners, listeners,
    busy(value) { busy = value; for (const listener of sessionListeners) listener({ busy }); },
    state(value) { state = value; for (const listener of listeners) listener(value); } };
}

test('native file entry uses the same full View carrier and workspace route, with no Resource global', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-file-carrier-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'carrier.html'), '<full-view>__FX_VIEW_ENTRY_SCOPE__:__FX_VIEW_ENTRY_KIND__</full-view>');
  const calls = [];
  const app = createViewAppServer({ root: directory }, { artifactRoot: new URL(`file://${directory}/`), fileEntry: codexFileEntry,
    routing: {
      async route(scope, hostMeta) { calls.push({ scope, hostMeta }); return { service: { async open() { return { url: 'http://127.0.0.1:1/' }; } } }; },
      async invoke(args, hostMeta, options) { calls.push({ action: args.action, hostMeta, scope: args.entryScope }); return args.action === 'file-context' ? options.fileContext() : {}; }, close() {},
    } });
  const client = new Client({ name: 'file-carrier-test', version: '1' });
  const [host, child] = InMemoryTransport.createLinkedPair();
  await app.server.connect(host); await client.connect(child);
  t.after(async () => { await client.close(); await app.close(); });
  const tools = (await client.listTools()).tools;
  const entry = tools.find(tool => tool.name === FILE_OPEN_TOOL);
  assert.ok(entry, 'file entry must be registered by the full View server');
  assert.equal(entry.title, 'ForgeAX View');
  assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'file', extensions: ['.pack.json', '.pack.ts'] }]);
  assert.deepEqual(entry._meta.ui.visibility, ['app']);
  assert.deepEqual(entry.inputSchema.properties.file.required.sort(), ['name', 'resourceUri']);
  assert.equal(entry._meta.ui.resourceUri, FILE_UI_URI);
  assert.equal(tools.some(tool => /resource_open|file_read/.test(tool.name)), false);
  assert.equal((await client.readResource({ uri: FILE_UI_URI })).contents[0].text, '<full-view>"workspace":"file"</full-view>');
  assert.equal((await client.readResource({ uri: UI_URI })).contents[0].text, '<full-view>"workspace":"view"</full-view>');
  const input = { file: { name: 'fake.pack.ts', resourceUri: 'opaque://host' } };
  const opened = await client.callTool({ name: FILE_OPEN_TOOL, arguments: input });
  assert.deepEqual(opened.structuredContent, input);
  assert.deepEqual(calls, [], 'static file callback must not acquire a route or start a service');
  await client.callTool({ name: TRANSPORT_TOOL, arguments: { action: 'view-document', entryScope: 'workspace' }, _meta: { threadId: 'this-chat' } });
  assert.equal(calls[0].scope, 'workspace');
  assert.equal(calls[0].hostMeta.threadId, 'this-chat');
  await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'forge.json'), '{}');
  const path = join(directory, 'assets/trusted.pack.json'); await writeFile(path, '{}');
  const result = await client.callTool({ name: TRANSPORT_TOOL, arguments: { action: 'file-context', payload: { path: '/fake.pack.ts' } }, _meta: meta(path) });
  assert.deepEqual(result.structuredContent, { ok: true, value: { projectRoot: await realpath(directory), sourcePath: 'assets/trusted.pack.json' } });
});

test('trusted host metadata resolves canonical source and nearest regular project without executing Pack code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-file-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'forge.json'), '{}'); await mkdir(join(root, 'nested/assets'), { recursive: true });
  await writeFile(join(root, 'nested/forge.json'), '{}');
  const source = join(root, 'nested/assets/scene.pack.ts');
  await writeFile(source, 'throw new Error("must never execute");');
  const alias = join(root, 'alias.pack.ts'); await symlink(source, alias);
  assert.deepEqual(await resolveViewFile(meta(alias)), { ok: true, value: { projectRoot: await realpath(join(root, 'nested')), sourcePath: 'assets/scene.pack.ts' } });
  assert.equal((await resolveViewFile({})).error.code, 'view-file-context-missing');
  assert.equal((await resolveViewFile(meta('relative.pack.ts'))).error.code, 'view-file-context-missing');
  assert.equal((await resolveViewFile({ 'openai/resource': 42 })).error.code, 'view-file-context-invalid');
  assert.equal((await resolveViewFile(meta(join(root, 'notes.ts')))).error.code, 'view-file-unsupported');
  assert.equal((await resolveViewFile(meta(join(root, 'missing.pack.json')))).error.code, 'view-file-unavailable');
  const nonregular = join(root, 'dir.pack.json'); await mkdir(nonregular);
  assert.equal((await resolveViewFile(meta(nonregular))).error.code, 'view-file-unavailable');
  if (process.platform !== 'win32') {
    const fifo = join(root, 'pipe.pack.ts'); execFileSync('mkfifo', [fifo]);
    assert.equal((await resolveViewFile(meta(fifo))).error.code, 'view-file-unavailable');
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(resolveViewFile(meta(source), abort.signal), { name: 'AbortError' });
});

test('guarded openProject waits for ready and idle, preserves session generation and passes intent cancellation', async () => {
  const ready = deferred(), probe = workspace({ state: { ...running, project: { id: 'old', root: '/old' } }, ready: ready.promise, busy: true });
  const signal = new AbortController().signal;
  const opening = openViewFile(probe.client, file, signal);
  await tick(); assert.deepEqual(probe.calls, []);
  ready.resolve(); await tick(); assert.deepEqual(probe.calls, []);
  probe.busy(false); await opening;
  assert.equal(probe.calls[0].operation, 'present');
  const selection = probe.calls.find(call => call.operation === 'project');
  assert.deepEqual(selection.options.expectedProject, { kind: 'session', sessionId: 'session', generation: 7 });
  assert.equal(selection.options.signal, signal);
  assert.equal(probe.calls.at(-1).guid, 'exact-guid');
  assert.equal(probe.sessionListeners.size, 0);
});

test('project failures and selection replacement propagate without opening a stale asset', async () => {
  for (const next of [{ ...running, project: { id: 'foreign', root: '/foreign' } }, { ...running, projectStatus: { phase: 'failed', failure: { hint: 'cook failed' } } }]) {
    const probe = workspace({ state: { ...running, projectStatus: { ...running.projectStatus, phase: 'preparing' } } });
    const opening = openViewFile(probe.client, file, new AbortController().signal);
    await tick(); assert.equal(probe.listeners.size, 2); probe.state(next);
    await assert.rejects(opening, /changed|cook failed|superseded/);
    assert.deepEqual(probe.calls.map(call => call.operation), ['present']); assert.equal(probe.listeners.size, 0);
  }
  const probe = workspace({ state: { project: { id: 'old', root: '/old' } } });
  await assert.rejects(openViewFile(probe.client, file, new AbortController().signal), /current project session/);
});

test('exact Pack source outputs open one GUID or reveal multiple outputs with current revision', async () => {
  const probe = workspace({ sources: [
    { sourcePath: 'other/world.scene.pack.json', outputs: [{ guid: 'wrong-basename' }] },
    { sourcePath: '/project/assets/./world.scene.pack.json', outputs: [{ guid: 'exact' }] },
  ] });
  await openViewFile(probe.client, file, new AbortController().signal);
  assert.equal(probe.calls.at(-1).guid, 'exact'); assert.equal(probe.calls.some(call => call.operation === 'catalog'), false);
  const multi = workspace({ sources: [{ sourcePath: file.sourcePath, revision: 'revision', packageId: 'pack', outputs: [{ guid: 'a' }, { guid: 'b' }] }] });
  await openViewFile(multi.client, file, new AbortController().signal);
  assert.deepEqual(multi.calls.at(-1).input, { projectId: 'project-id', sourcePath: file.sourcePath, revision: 'revision', packageId: 'pack' });
  assert.equal(multi.calls.some(call => call.operation === 'asset'), false);
});

test('materialized script Pack catalog uses exact sourcePath or path, never basename or another evaluation', async () => {
  const script = { ...file, sourcePath: 'assets/scene.pack.ts' };
  for (const field of ['sourcePath', 'path']) {
    const probe = workspace({ sources: [{ sourcePath: script.sourcePath, revision: 'script-rev', outputs: [], diagnostic: { code: 'pack-source-unmaterialized', hint: 'static index' } }] });
    probe.client.listAssets = async () => ({ assets: [
      { guid: 'wrong', sourcePath: 'other/scene.pack.ts' },
      { guid: 'exact-script', [field]: '/project/assets/scene.pack.ts' },
    ] });
    await openViewFile(probe.client, script, new AbortController().signal);
    assert.equal(probe.calls.at(-1).guid, 'exact-script');
  }
  const zero = workspace({ sources: [{ sourcePath: script.sourcePath, revision: 'script-rev', outputs: [], diagnostic: { code: 'pack-source-unmaterialized' } }] });
  await openViewFile(zero.client, script, new AbortController().signal);
  assert.equal(zero.calls.at(-1).operation, 'reveal');
});

test('missing, bounded, diagnostic and reveal errors reach the caller', async () => {
  for (const [inventory, pattern] of [
    [{ sources: [], hasMore: false }, /not an asset source/],
    [{ sources: [], hasMore: true }, /inventory limit/],
    [{ sources: [{ sourcePath: file.sourcePath, diagnostic: { code: 'invalid', hint: 'invalid source' } }], hasMore: false }, /invalid source/],
    [{ sources: [{ sourcePath: file.sourcePath, outputs: [] }], hasMore: false }, /no current revision/],
  ]) {
    const probe = workspace(); probe.client.transport.request = async () => inventory;
    await assert.rejects(openViewFile(probe.client, file, new AbortController().signal), pattern);
    assert.deepEqual(probe.calls.map(call => call.operation), ['present']);
  }
  const probe = workspace({ sources: [{ sourcePath: file.sourcePath, revision: 'revision', outputs: [] }] });
  probe.client.revealPack = async () => ({ ok: false, code: 'stale-revision' });
  await assert.rejects(openViewFile(probe.client, file, new AbortController().signal), /stale-revision/);
});

test('cold activation, repeated input, cancel and detached clients fence late results', async () => {
  const pending = [], reports = [], first = workspace(), second = workspace();
  const opener = createViewFileOpener(signal => new Promise(resolve => pending.push({ signal, resolve })), error => reports.push(error));
  opener.activate(); await tick(); assert.equal(pending.length, 0);
  const detach = opener.attach(first.client); await tick(); assert.equal(pending.length, 1);
  opener.activate(); assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ ok: true, value: file }); await tick(); assert.equal(pending.length, 2);
  pending[1].resolve({ ok: true, value: file }); await tick(); await tick();
  assert.equal(first.calls.filter(call => call.operation === 'asset').length, 1);
  opener.activate(); await tick(); detach(); opener.attach(second.client);
  pending[2].resolve({ ok: true, value: file }); await tick();
  assert.equal(pending.length, 4); pending[3].resolve({ ok: true, value: file }); await tick(); await tick();
  assert.equal(second.calls.filter(call => call.operation === 'asset').length, 1);
  opener.activate(); await tick(); opener.cancel(); pending[4].resolve({ ok: false, error: { hint: 'stale failure' } });
  await tick(); assert.equal(reports.some(error => error instanceof Error), false);
  opener.dispose(); opener.activate(); await tick(); assert.equal(pending.length, 5);
});

test('canceling unresolved session initialization releases the next activation after client replacement', async () => {
  const never = deferred(), first = workspace({ ready: never.promise }), second = workspace();
  const opener = createViewFileOpener(async () => ({ ok: true, value: file }), () => {});
  const detach = opener.attach(first.client); opener.activate(); await tick();
  detach(); opener.attach(second.client); await tick(); await tick();
  assert.equal(second.calls.at(-1)?.operation, 'asset');
  assert.deepEqual(first.calls, []); opener.dispose();
});

test('stale running state cannot inspect or open a file before its exact replacement document is ready', async () => {
  const ready = deferred(), frameListeners = new Set();
  const document = { sessionId: 'session', targetId: 'target', url: 'https://test.invalid/exact-document', browserGeneration: 2 };
  const probe = workspace({ state: { ...running, projectDocumentPresentation: 'presenter', projectDocument: document } });
  let snapshot = { phase: 'ready', document: { ...document, targetId: 'stale-target', url: 'https://test.invalid/stale-document' }, ready: Promise.resolve() };
  const frameOwner = { getSnapshot: () => snapshot,
    subscribe(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); } };
  const controller = new AbortController();
  const opening = openViewFile(probe.client, file, controller.signal, frameOwner);
  await tick(); await tick();
  assert.deepEqual(probe.calls.map(call => call.operation), ['present'], 'Stale running must not admit Pack inventory or asset operations');
  snapshot = { phase: 'preparing', document, ready: ready.promise };
  for (const listener of frameListeners) listener(snapshot);
  await tick();
  assert.deepEqual(probe.calls.map(call => call.operation), ['present'], 'Only the exact target and URL may satisfy readiness');
  probe.state({ ...running, projectStatus: { ...running.projectStatus, phase: 'starting' }, projectDocumentPresentation: 'presenter', projectDocument: document });
  snapshot = { ...snapshot, phase: 'ready' }; ready.resolve();
  for (const listener of frameListeners) listener(snapshot);
  await tick(); await tick();
  assert.deepEqual(probe.calls.map(call => call.operation), ['present'], 'Frame readiness must also wait for authoritative running after the handoff');
  probe.state({ ...running, projectDocumentPresentation: 'presenter', projectDocument: document });
  await opening;
  assert.equal(probe.calls.at(-1).guid, 'exact-guid');
  assert.equal(frameListeners.size, 0);
});

test('canceling a removed frame owner releases pending file work without inventory or stale open', async () => {
  const never = deferred();
  const document = { sessionId: 'session', targetId: 'target', url: 'https://test.invalid/exact-document', browserGeneration: 2 };
  const probe = workspace({ state: { ...running, projectDocumentPresentation: 'presenter', projectDocument: document } });
  const frameOwner = { getSnapshot: () => ({ phase: 'preparing', document, ready: never.promise }), subscribe() { return () => {}; } };
  const controller = new AbortController();
  const opening = openViewFile(probe.client, file, controller.signal, frameOwner);
  await tick(); controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(probe.calls.map(call => call.operation), ['present']);
});

test('losing presentation during exact frame readiness cancels the old file without querying or reclaiming', async () => {
  const ready = deferred(), listeners = new Set();
  const document = { sessionId: 'session', targetId: 'target', url: 'https://test.invalid/current-document' };
  const probe = workspace({ state: { ...running, projectDocumentPresentation: 'presenter', projectDocument: document } });
  const owner = { getSnapshot: () => ({ phase: 'preparing', document, ready: ready.promise }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const abort = new AbortController();
  const opening = openViewFile(probe.client, file, abort.signal, owner).then(() => 'completed', error => error);
  await tick(); await tick();
  probe.state({ ...running, projectDocumentPresentation: 'observer', projectDocument: document });
  const result = await Promise.race([opening, new Promise(resolve => setTimeout(() => resolve('still-pending'), 100))]);
  abort.abort(); await opening;
  assert.ok(result instanceof Error && result.name === 'AbortError', `Presentation loss must cancel immediately; received ${String(result)}`);
  assert.deepEqual(probe.calls.map(call => call.operation), ['present']);
  assert.equal(listeners.size, 0); assert.equal(probe.listeners.size, 0);
});

test('remote selection never claims presentation and rejects an observer before inventory', async () => {
  const observer = workspace({ state: { ...running, projectDocumentPresentation: 'observer' } });
  await assert.rejects(openViewFile(observer.client, file, new AbortController().signal, undefined, true), /no longer presents/);
  assert.deepEqual(observer.calls, [], 'Remote source selection cannot steal the presenter');
  const presenter = workspace({ state: { ...running, projectDocumentPresentation: 'presenter' } });
  await openViewFile(presenter.client, file, new AbortController().signal, undefined, true);
  assert.deepEqual(presenter.calls.map(value => value.operation), ['sources', 'asset']);
});

test('remote presenter loss while waiting on the exact frame rejects without present, inventory, or asset open', async () => {
  const ready = deferred();
  const document = { sessionId: 'session', targetId: 'target', url: 'https://test.invalid/current-document' };
  const probe = workspace({ state: { ...running, projectDocumentPresentation: 'presenter', projectDocument: document } });
  const owner = { getSnapshot: () => ({ phase: 'preparing', document, ready: ready.promise }), subscribe() { return () => {}; } };
  const opener = createViewFileOpener(() => { assert.fail('Remote selection cannot reread initial source'); }, () => {});
  opener.attach(probe.client, owner);
  const outcome = opener.select(file, new AbortController().signal).catch(error => error);
  await tick(); await tick();
  probe.state({ ...running, projectDocumentPresentation: 'observer', projectDocument: document });
  assert.equal((await outcome).name, 'AbortError');
  assert.deepEqual(probe.calls, []);
  opener.dispose();
});

test('remote selection acknowledgements follow completion and reject superseded, cancelled, or replaced work', async () => {
  const probe = workspace({ state: { ...running, projectDocumentPresentation: 'presenter' } });
  const waiting = deferred();
  probe.client.openAsset = async (guid, options) => { probe.calls.push({ operation: 'asset', guid, options }); await waiting.promise; };
  const opener = createViewFileOpener(() => { assert.fail('Remote selection cannot resolve a different initial file'); }, () => {});
  const detach = opener.attach(probe.client);
  let completed = false;
  const first = opener.select(file, new AbortController().signal);
  const firstOutcome = first.then(() => { completed = true; }, error => error);
  await tick(); await tick(); assert.equal(completed, false, 'Receipt must wait for the public asset.open operation');
  const cancellation = new AbortController();
  const second = opener.select(file, cancellation.signal).catch(error => error);
  assert.equal((await firstOutcome).name, 'AbortError');
  cancellation.abort(new Error('Caller cancelled'));
  assert.match((await second).message, /Caller cancelled/);
  waiting.resolve(); await tick(); await tick();
  const complete = opener.select(file, new AbortController().signal); await complete;
  assert.equal(probe.calls.some(value => value.operation === 'present'), false);
  const ready = deferred(); probe.client.projectSession.ready = ready.promise;
  const retired = opener.select(file, new AbortController().signal).catch(error => error);
  await tick(); detach(); assert.match((await retired).message, /retired/);
  opener.dispose();
});
