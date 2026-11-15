import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNetworkRuntime } from '../../src/app/network-runtime.ts';
const reply = { status: 200, headers: {}, bytes: 2, base64: Buffer.from('ok').toString('base64') };

test('MCP module loading borrows the physical importer and fences calls after retirement', async () => {
  const imported = [];
  const namespace = { value: 42 };
  const nativeImport = async url => { imported.push(url); return namespace; };
  const realm = { fetch, Request, __fxMcpImport: nativeImport };
  const runtime = installNetworkRuntime(realm, async () => { throw new Error('local modules must not use transport'); }, 'http://localhost:4000/');
  try {
    assert.strictEqual(await realm.__fxMcpImport('data:text/javascript,export const value=42'), namespace);
    assert.deepEqual(imported, ['data:text/javascript,export const value=42']);
  } finally { runtime.dispose(); }
  assert.notEqual(realm.__fxMcpImport, nativeImport);
  await assert.rejects(
    async () => realm.__fxMcpImport('data:text/javascript,export const late=1'),
    /MCP network runtime retired/,
  );
  assert.deepEqual(imported, ['data:text/javascript,export const value=42']);
});

test('MCP module loading rejects a missing physical document importer instead of creating another loader', async () => {
  const realm = { fetch, Request };
  const runtime = installNetworkRuntime(realm, async () => { throw new Error('local modules must not use transport'); }, 'http://localhost:4000/');
  try {
    await assert.rejects(async () => realm.__fxMcpImport('data:text/javascript,export const value=42'), /MCP native module loader is unavailable/);
  } finally { runtime.dispose(); }
});

test('retiring a network runtime rejects a late bundle without creating a Blob or invoking native import', async () => {
  let finishBundle, signal;
  let imports = 0;
  const created = [];
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url; };
  const realm = { fetch, Request, __fxMcpImport: async () => { imports++; return {}; } };
  const runtime = installNetworkRuntime(realm, (_args, options) => new Promise(resolve => { finishBundle = resolve; signal = options?.signal; }), 'http://localhost:4000/');
  try {
    const pending = realm.__fxMcpImport('./late.mjs');
    runtime.dispose();
    finishBundle({ base64: Buffer.from('export const value = 42;').toString('base64') });
    const [result] = await Promise.allSettled([pending]);
    assert.equal(result.status, 'rejected');
    assert.match(String(result.reason), /retired/);
    assert.equal(signal?.aborted, true);
    assert.equal(imports, 0);
    assert.deepEqual(created, []);
  } finally {
    runtime.dispose();
    URL.createObjectURL = create;
    for (const url of created) revoke(url);
  }
});

test('retirement revokes an imported Blob and rejects a native import that finishes later', async () => {
  let finishImport, importedUrl, started;
  const importing = new Promise(resolve => { started = resolve; });
  const realm = { fetch, Request, __fxMcpImport: url => {
    importedUrl = url;
    started();
    return new Promise(resolve => { finishImport = resolve; });
  } };
  const runtime = installNetworkRuntime(realm, async () => ({ base64: Buffer.from('export const value = 42;').toString('base64') }), 'http://localhost:4000/');
  try {
    const pending = realm.__fxMcpImport('./loading.mjs');
    await importing;
    assert.match(await (await fetch(importedUrl)).text(), /value = 42/);
    runtime.dispose();
    await assert.rejects(fetch(importedUrl));
    finishImport({ value: 42 });
    const [result] = await Promise.allSettled([pending]);
    assert.equal(result.status, 'rejected');
    assert.match(String(result.reason), /retired/);
  } finally { runtime.dispose(); }
});

test('bare optional imports retain native package resolution instead of a source HTTP path', async () => {
  const remote = '@forgeax/engine/remote/server';
  const nativeLoads = [];
  const bundles = [];
  const realm = {
    fetch,
    Request,
    __fxMcpImport: (specifier) => {
      nativeLoads.push(specifier);
      return import(specifier);
    },
  };
  const runtime = installNetworkRuntime(realm, async (input) => {
    bundles.push(input);
    throw new Error(`Unexpected source request: ${input.url}`);
  }, 'http://localhost:4000/');
  const from = 'http://localhost:4000/@fs/engine/packages/app/dist/app-assembly.mjs';
  try {
    const native = await import(remote);
    assert.equal(await realm.__fxMcpImport(remote, from), native);
    await assert.rejects(realm.__fxMcpImport('@forgeax/missing-optional-transport', from), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    assert.deepEqual(nativeLoads, [
      remote,
      '@forgeax/missing-optional-transport',
    ]);
    assert.deepEqual(bundles, [], 'bare imports must not invent packages/app/dist/package URLs');
    const data = 'data:text/javascript,export default 42';
    assert.equal((await realm.__fxMcpImport(data, from)).default, 42);
    for (const specifier of ['./chunk.mjs', '../chunk.mjs', '/entry.mjs', '//localhost:4000/entry.mjs', 'http://localhost:4000/entry.mjs']) {
      await assert.rejects(realm.__fxMcpImport(specifier, from), /Unexpected source request/);
      assert.equal(bundles.at(-1).url, new URL(specifier, from).href);
    }
    runtime.dispose();
    assert.throws(() => realm.__fxMcpImport(remote, from), /retired/);
    assert.equal(nativeLoads.length, 3, 'retired native imports stay fenced');
  } finally {
    runtime.dispose();
  }
});

test('MCP fetch preserves Request bodies, headers and abort signal', async () => {
  let received;
  let nativeFetchCalls = 0;
  const nativeFetch = async () => {
    nativeFetchCalls += 1;
    return new Response('native response');
  };
  const realm = { fetch: nativeFetch, Request, __fxMcpLocation: 'prior' };
  const runtime = installNetworkRuntime(
    realm,
    async (input, options) => {
      received = { input, options };
      return reply;
    },
    'http://localhost:4000/',
  );
  try {
    const controller = new AbortController();
    const request = new Request('http://localhost:4000/upload', {
      method: 'POST',
      body: new Blob(['asset data']),
      headers: { 'x-test': 'asset' },
      signal: controller.signal,
    });
    assert.equal(await (await realm.fetch(request)).text(), 'ok');
    assert.equal(Buffer.from(received.input.body, 'base64').toString(), 'asset data');
    assert.equal(received.input.headers['x-test'], 'asset');
    controller.abort();
    assert.equal(received.options.signal.aborted, true);
  } finally {
    runtime.dispose();
  }
  assert.equal(realm.__fxMcpLocation, 'prior');
  assert.notEqual(realm.fetch, nativeFetch);
  await assert.rejects(realm.fetch('http://localhost:4000/late'), /MCP network runtime retired/);
  assert.equal(nativeFetchCalls, 0, 'retired requests must not escape through native fetch');
});

test('MCP fetch accepts URLSearchParams through the native Request body contract', async () => {
  let input;
  const realm = { fetch, Request };
  const runtime = installNetworkRuntime(
    realm,
    async (value) => {
      input = value;
      return reply;
    },
    'http://localhost:4000/',
  );
  try {
    await realm.fetch('/upload', { method: 'POST', body: new URLSearchParams({ name: 'asset' }) });
    assert.equal(Buffer.from(input.body, 'base64').toString(), 'name=asset');
    assert.match(input.headers['content-type'], /application\/x-www-form-urlencoded/);
  } finally {
    runtime.dispose();
  }
});

test('retired MCP runtime keeps Worker and module entrypoints fenced', () => {
  let nativeWorkerStarts = 0;
  let nativeModuleLoads = 0;
  class NativeWorker {
    constructor() {
      nativeWorkerStarts += 1;
    }
    terminate() {}
  }
  const realm = {
    fetch,
    Request,
    Worker: NativeWorker,
    __fxMcpImport: async () => {
      nativeModuleLoads += 1;
    },
  };
  const runtime = installNetworkRuntime(realm, async () => reply, 'http://localhost:4000/');
  runtime.dispose();

  assert.throws(() => new realm.Worker('/late-worker.js'), /MCP network runtime retired/);
  assert.throws(() => realm.__fxMcpImport('/late-module.js'), /MCP network runtime retired/);
  assert.equal(nativeWorkerStarts, 0);
  assert.equal(nativeModuleLoads, 0);
});

test('srcdoc exposes one logical document base to optional chains and aliased readers', () => {
  const nativeDocument = Object.create({
    get baseURI() {
      return 'http://reference-host:9000/';
    },
  });
  const realm = { fetch, Request, document: nativeDocument };
  const runtime = installNetworkRuntime(
    realm,
    async () => reply,
    'http://localhost:4200/?forgeaxWorkspaceTarget=scene',
  );
  try {
    const documentAlias = realm.document;
    assert.equal(
      new URL('/shaders/manifest.json', realm.document?.baseURI).href,
      'http://localhost:4200/shaders/manifest.json',
    );
    assert.equal(documentAlias.baseURI, realm.__fxMcpLocation.href);
  } finally {
    runtime.dispose();
  }
  assert.equal(nativeDocument.baseURI, 'http://reference-host:9000/');
  assert.equal(Object.hasOwn(nativeDocument, 'baseURI'), false);
});

test('parallel resource reads share bounded transport batches while retaining separate responses', async () => {
  const calls = [];
  const realm = { fetch, Request };
  const runtime = installNetworkRuntime(realm, async input => {
    calls.push(input);
    const response = item => ({ ...reply, status: item.url.endsWith('/missing') ? 404 : 200 });
    if (input.action === 'http-batch') return {
      mime: 'application/json',
      base64: Buffer.from(JSON.stringify(input.requests.map(item => ({ ok: true, value: response(item) })))).toString('base64'),
    };
    return response(input);
  }, 'http://localhost:4000/');
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => realm.fetch(i === 19 ? '/missing' : `/shader-${i}`)));
    assert.ok(calls.length <= 2, 'Twenty reads must not require twenty MCP calls');
    assert.ok(calls.every(input => input.requests.length <= 16));
    assert.equal(responses.at(-1).status, 404);
    assert.deepEqual(await Promise.all(responses.map(response => response.text())), Array(20).fill('ok'));
  } finally { runtime.dispose(); }
});

test('cancelling one batched read preserves its sibling and cancelling all releases transport', async () => {
  let respond, transportSignal;
  const realm = { fetch, Request };
  const runtime = installNetworkRuntime(realm, (input, options) => new Promise(resolve => {
    transportSignal = options.signal;
    respond = () => resolve({ base64: Buffer.from(JSON.stringify(input.requests.map(() => ({ ok: true, value: reply })))).toString('base64') });
  }), 'http://localhost:4000/');
  try {
    const first = new AbortController();
    const second = new AbortController();
    const a = realm.fetch('/a', { signal: first.signal });
    const b = realm.fetch('/b', { signal: second.signal });
    const rejected = assert.rejects(a, /first cancelled/);
    await new Promise(resolve => setTimeout(resolve, 0));
    first.abort(new Error('first cancelled'));
    await rejected;
    assert.equal(transportSignal.aborted, false);
    respond();
    assert.equal(await (await b).text(), 'ok');
    const c = realm.fetch('/c');
    const d = realm.fetch('/d');
    const retired = Promise.all([assert.rejects(c, /retired/), assert.rejects(d, /retired/)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    runtime.dispose();
    await retired;
    assert.equal(transportSignal.aborted, true);
    respond();
  } finally { runtime.dispose(); }
});
