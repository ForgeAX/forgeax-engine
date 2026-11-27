import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { createDistAssetFetch } from '../dist-asset-fetch.mjs';
import {
  decodeShaderManifestText,
  openShaderManifestPublication,
  readShaderManifestText,
} from '../shader-manifest.mjs';

function fixture(t, bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-shader-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, bytes);
  return path;
}

const document = '{"schemaVersion":1,"materials":{"probe":"shader-λ"}}\n';

test('borrowed producer bytes decode without another file read or changing their identity', () => {
  for (const bytes of [
    new TextEncoder().encode(document),
    zstdCompressSync(Buffer.from(document)),
  ]) {
    const original = Uint8Array.from(bytes);
    assert.equal(decodeShaderManifestText(bytes), document);
    assert.deepEqual(Uint8Array.from(bytes), original);
  }
});

test('smoke readers retain plain producer JSON text without transformation', (t) => {
  assert.equal(readShaderManifestText(fixture(t, document)), document);
});

test('smoke readers decode the production zstd frame before parsing JSON', (t) => {
  const path = fixture(t, zstdCompressSync(Buffer.from(document)));
  assert.equal(readShaderManifestText(path), document);
  assert.deepEqual(JSON.parse(readShaderManifestText(path)), JSON.parse(document));
});

test('smoke JSON consumers reject truncated production frames rather than accepting missing data', (t) => {
  const path = fixture(t, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  assert.throws(() => JSON.parse(readShaderManifestText(path)), SyntaxError);
});

test('smoke readers propagate corrupt production frame errors', (t) => {
  const path = fixture(t, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xff, 0xff, 0xff]));
  assert.throws(() => readShaderManifestText(path));
});

test('one owned publication serves identical sealed bytes to independent consumers and retires', async (t) => {
  const { openShaderManifestPublication } = await import('../shader-manifest.mjs');
  for (const bytes of [Buffer.from(document), zstdCompressSync(Buffer.from(document))]) {
    const publication = openShaderManifestPublication(fixture(t, bytes));
    t.after(() => publication.dispose());
    for (const response of await Promise.all([fetch(publication.url), fetch(publication.url)])) {
      const received = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(received, bytes);
      assert.equal(decodeShaderManifestText(received), document);
    }
    publication.dispose();
    await assert.rejects(fetch(publication.url), TypeError);
  }
});

test('process-owned native URLs preserve plain and sealed publication bytes', async (t) => {
  const { processShaderManifestUrl } = await import('../shader-manifest.mjs');
  for (const bytes of [Buffer.from(document), zstdCompressSync(Buffer.from(document))]) {
    const before = new Set(process.listeners('exit'));
    const url = processShaderManifestUrl(fixture(t, bytes));
    const owned = process.listeners('exit').filter((listener) => !before.has(listener));
    t.after(() => {
      for (const listener of owned) process.removeListener('exit', listener);
      URL.revokeObjectURL(url);
    });
    assert.match(url, /^blob:/);
    const received = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.deepEqual(received, bytes);
    assert.equal(decodeShaderManifestText(received), document);
    assert.equal(owned.length, 1);
    owned[0]();
    await assert.rejects(fetch(url), TypeError);
  }
});

function distFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-dist-fetch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Pack URLs retain their real emitted JSON and binary bodies', async (t) => {
  const root = distFixture(t);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'pack-index.json'), '{"entries":[]}');
  writeFileSync(join(root, 'assets/body.bin'), Buffer.from([0, 255, 17]));
  const fetch = createDistAssetFetch(root);
  assert.deepEqual(await (await fetch('/pack-index.json?current=1#root')).json(), { entries: [] });
  assert.deepEqual(
    Buffer.from(await (await fetch('assets/body.bin')).arrayBuffer()),
    Buffer.from([0, 255, 17]),
  );
  assert.equal((await fetch('/missing.pack.json')).status, 404);
});

test('plain and sealed Blob publications pass through the asset shim byte-for-byte', async (t) => {
  const root = distFixture(t);
  const fetch = createDistAssetFetch(root);
  for (const bytes of [
    Buffer.from('{"schemaVersion":1}'),
    zstdCompressSync(Buffer.from('{"schemaVersion":1}')),
  ]) {
    const path = join(root, 'manifest.json');
    writeFileSync(path, bytes);
    const publication = openShaderManifestPublication(path);
    t.after(publication.dispose);
    assert.deepEqual(Buffer.from(await (await fetch(publication.url)).arrayBuffer()), bytes);
    publication.dispose();
    await assert.rejects(fetch(publication.url), TypeError);
  }
  assert.equal(await (await fetch('data:text/plain,original')).text(), 'original');
});

test('fixture-origin Request and URL inputs share the emitted asset route', async (t) => {
  const root = distFixture(t);
  writeFileSync(join(root, 'pack-index.json'), '{}');
  const fetch = createDistAssetFetch(root, { origin: 'http://terrain.test' });
  for (const input of [
    new URL('http://terrain.test/pack-index.json'),
    new Request('http://terrain.test/pack-index.json'),
  ]) {
    assert.deepEqual(await (await fetch(input)).json(), {});
  }
});

test('foreign transports retain the original Request and cancellation inputs', async (t) => {
  const root = distFixture(t);
  const input = new Request('https://assets.test/manifest.json');
  const init = { signal: new AbortController().signal };
  let calls = 0;
  const fetch = createDistAssetFetch(root, {
    nativeFetch: async (actual, options) => {
      calls++;
      assert.equal(actual, input);
      assert.equal(options, init);
      return new Response('native');
    },
  });
  assert.equal(await (await fetch(input, init)).text(), 'native');
  assert.equal(calls, 1);
});

test('Blob transport with the fixture origin still delegates instead of reading a local path', async (t) => {
  const root = distFixture(t);
  const input = new URL('blob:http://forgeax-smoke.test/owned-publication');
  let calls = 0;
  const fetch = createDistAssetFetch(root, {
    nativeFetch: async (actual) => {
      calls++;
      assert.equal(actual, input);
      return new Response('native blob');
    },
  });
  assert.equal(await (await fetch(input)).text(), 'native blob');
  assert.equal(calls, 1);
});
