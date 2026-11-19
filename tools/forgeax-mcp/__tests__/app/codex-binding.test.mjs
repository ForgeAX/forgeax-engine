import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCodexBindingStore } from '../../src/codex-binding.mjs';
import { createCodexRouting } from '../../src/codex-routing.mjs';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'forgeax-binding-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'), target = join(temp, 'worktree');
  await mkdir(source); await mkdir(target);
  const binding = { root: join(temp, 'global'), enginePackage: '/engine', hostPack: '/pack',
    codexContext: { home: temp, command: '/unused' } };
  const calls = [];
  let failPreparation = false, hostAvailable = true;
  const options = {
    retainInstance: async () => ({ close() {} }),
    directoryReader: { async read() { if (!hostAvailable) throw new Error('Host unavailable'); return source; }, close() {} },
    async createClient(selected) { return { root: selected.root, async request(operation) { calls.push({ root: selected.root, operation }); return { ok: true, value: selected.root }; } }; },
    createPresentation(client) { return {
      async open() { return { root: client.root, url: 'http://localhost/', presentationId: client.root }; },
      async prepare() { if (failPreparation) throw new Error('Preparation failed'); },
      async bind() { if (failPreparation) throw new Error('Preparation failed'); },
      async invoke(input) { calls.push({ root: client.root, action: input.action }); return { root: client.root }; }, close() {},
    }; },
  };
  const router = () => { const value = createCodexRouting(binding, options); t.after(() => value.close()); return value; };
  return { source, target, router, calls, binding, fail() { failPreparation = true; }, offline() { hostAvailable = false; } };
}

test('explicit chat binding survives router replacement and stops depending on host cwd', async t => {
  const f = await fixture(t), app = f.router();
  const result = await app.bind(f.target, { threadId: 'chat-a' });
  assert.equal(result.phase, 'ready');
  assert.equal(result.directory, await realpath(f.target));
  f.offline();
  const business = f.router();
  assert.equal((await business.request('view.status', {}, { threadId: 'chat-a' })).value, result.root);
  await assert.rejects(business.route('workspace', { threadId: 'chat-b' }), /Host unavailable/);
});

test('migration waits for exact chat documents to retire and leaves another chat on the source', async t => {
  const f = await fixture(t), app = f.router(), business = f.router();
  const a = { threadId: 'chat-a' }, b = { threadId: 'chat-b' };
  const first = await app.route('workspace', a), other = await app.route('workspace', b);
  assert.notEqual(first.root, other.root);
  const documentA = randomUUID(), documentB = randomUUID();
  const invoke = (id, meta, action) => app.invoke({ action, entryScope: 'workspace', appDocumentId: id }, meta);
  await invoke(documentA, a, 'view-document'); await invoke(documentB, b, 'view-document');
  const switching = app.bind(f.target, a);
  let notice;
  for (let index = 0; index < 100; index++) {
    notice = await invoke(documentA, a, 'binding-read');
    if (notice.phase === 'retiring') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(notice.phase, 'retiring');
  await assert.rejects(business.request('view.status', {}, a), /migrating/);
  assert.equal((await business.request('view.status', {}, b)).value, other.root);
  await invoke(documentA, a, 'app-close');
  const result = await switching;
  assert.equal(result.phase, 'ready'); assert.equal(result.root, first.root);
  assert.equal((await business.request('view.status', {}, a)).value, result.root);
  assert.equal((await invoke(documentB, b, 'http')).root, other.root);
  await assert.rejects(invoke(documentA, a, 'http'), /Open this App document/);
});

test('failed destination preparation keeps the original binding and live document', async t => {
  const f = await fixture(t), app = f.router(), meta = { threadId: 'chat-a' };
  const first = await app.route('workspace', meta), id = randomUUID();
  await app.invoke({ action: 'view-document', entryScope: 'workspace', appDocumentId: id }, meta);
  f.fail();
  await assert.rejects(app.bind(f.target, meta), /Preparation failed/);
  assert.equal((await app.route('workspace', meta)).root, first.root);
  assert.equal((await app.invoke({ action: 'http', entryScope: 'workspace', appDocumentId: id }, meta)).root, first.root);
});

test('an unacknowledged live page blocks migration and preserves the committed route', async t => {
  const f = await fixture(t), app = f.router(), meta = { threadId: 'chat-a' };
  const first = await app.route('workspace', meta);
  await app.invoke({ action: 'view-document', entryScope: 'workspace', appDocumentId: randomUUID() }, meta);
  const controller = new AbortController();
  const switching = app.bind(f.target, meta, controller.signal);
  setTimeout(() => controller.abort(new Error('Cancelled test migration')), 150);
  await assert.rejects(switching, /Cancelled/);
  assert.equal((await app.route('workspace', meta)).root, first.root);
});

test('destination path and chat identity are validated before changing any route', async t => {
  const f = await fixture(t), app = f.router();
  await assert.rejects(app.bind('relative/worktree', { threadId: 'chat-a' }), /absolute/);
  await assert.rejects(app.bind(f.target, {}), /unambiguous/);
  await assert.rejects(app.bind(join(f.target, 'gone'), { threadId: 'chat-a' }), /ENOENT/);
});

test('explicit binding repairs unavailable host metadata without changing another chat', async t => {
  const f = await fixture(t), app = f.router();
  f.offline();
  const moved = await app.bind(f.target, { threadId: 'chat-a' });
  assert.equal((await app.request('view.status', {}, { threadId: 'chat-a' })).value, moved.root);
  await assert.rejects(app.request('view.status', {}, { threadId: 'chat-b' }), /Host unavailable/);
});

test('binding the same directory is idempotent and does not retire an existing page', async t => {
  const f = await fixture(t), app = f.router(), meta = { threadId: 'chat-a' };
  const first = await app.bind(f.target, meta);
  const id = randomUUID();
  await app.invoke({ action: 'view-document', entryScope: 'workspace', appDocumentId: id }, meta);
  const second = await app.bind(f.target, meta);
  assert.equal(second.revision, first.revision);
  assert.equal((await app.invoke({ action: 'http', entryScope: 'workspace', appDocumentId: id }, meta)).root, first.root);
});


test('a crashed project switch recovers the last committed directory on its fixed backend', async t => {
  const f = await fixture(t), app = f.router(), meta = { threadId: 'chat-a' };
  const first = await app.route('workspace', meta);
  const store = createCodexBindingStore(f.binding);
  await store.set('chat-a', { ...(await store.get('chat-a')), migration: { pid: 2147483647, directory: f.target, phase: 'retiring' } });
  const business = createCodexRouting(f.binding, { directoryReader: { read() { throw new Error('Unexpected host read'); }, close() {} } });
  t.after(() => business.close());
  await assert.rejects(business.request('view.status', {}, meta), /Reopen/);
  const recovered = await app.route('workspace', meta);
  assert.equal(recovered.root, first.root);
  assert.equal(recovered.directory, await realpath(f.source));
  assert.equal((await store.get('chat-a')).migration, undefined);
});
