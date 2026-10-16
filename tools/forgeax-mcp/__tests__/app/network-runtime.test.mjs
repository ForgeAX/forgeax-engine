import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNetworkRuntime } from '../../src/app/network-runtime.ts';
const reply = { status: 200, headers: {}, bytes: 2, base64: Buffer.from('ok').toString('base64') };

test('MCP fetch preserves Request bodies, headers and abort signal', async () => {
  let received;
  const realm = { fetch, Request, __fxMcpLocation: 'prior' };
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
  assert.equal(realm.fetch, fetch);
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
