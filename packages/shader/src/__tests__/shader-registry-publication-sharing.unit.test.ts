import { createHash } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShaderRegistry, shaderSourceDigestInput } from '../index.js';

// Regression: every renderer host owns a ShaderRegistry, and each one expanded
// its own copy of the engine publication (~500 MB of composed WGSL). Hosts kept
// alive together (apps/parity/mesh-io keeps six) exhausted the renderer V8 heap.

function publication(wgsl: string) {
  const digest = createHash('sha256')
    .update(shaderSourceDigestInput([createHash('sha256').update(wgsl).digest()]))
    .digest('hex');
  return {
    schemaVersion: '5.0.0',
    receipts: [],
    entryPoints: [],
    fragments: [wgsl],
    sources: { [digest]: [0] },
    entries: [{ hash: 'entry', bindings: '[]', sourceDigest: digest }],
    materialShaders: [
      {
        identifier: 'material',
        sourcePath: 'material.wgsl',
        paramSchema: '[]',
        sourceDigest: digest,
        variants: [{ definesKey: '', defines: {}, sourceDigest: digest }],
      },
    ],
  };
}

function serve(current: () => unknown) {
  // A fresh response string per request, like independent fetches in a browser.
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(current())));
}

async function loaded(manifestUrl: string) {
  const registry = new ShaderRegistry({ manifestUrl });
  const result = await registry.loadManifest();
  return { registry, result };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ShaderRegistry publication sharing', () => {
  it('preserves block order and tail bytes, with identical native and fallback identities', async () => {
    const a = 'a'.repeat(131_072);
    const b = 'b'.repeat(131_072);
    const load = async (wgsl: string) => {
      const registry = new ShaderRegistry({
        manifestUrl: '/chunked-text',
        readText: async () =>
          JSON.stringify({ entries: [{ hash: 'entry', wgsl, bindings: '[]' }] }),
      });
      expect((await registry.loadManifest()).ok).toBe(true);
      return registry;
    };
    const first = await load(`${a}${b}tail`);
    const reordered = await load(`${b}${a}tail`);
    const changedTail = await load(`${b}${a}edit`);
    const shortened = await load(`${b}${a}`);
    expect([...first.entries()][0]?.wgsl).toBe(`${a}${b}tail`);
    expect([...reordered.entries()][0]?.wgsl).toBe(`${b}${a}tail`);
    expect([...changedTail.entries()][0]?.wgsl).toBe(`${b}${a}edit`);
    expect([...shortened.entries()][0]?.wgsl).toBe(`${b}${a}`);
    vi.stubGlobal('crypto', undefined);
    const fallback = await load(`${b}${a}`);
    expect([...fallback.entries()][0]).toBe([...shortened.entries()][0]);
  });

  it('reports a native digest failure on re-admission without adopting manifest entries', async () => {
    const readText = async () => '{"entries":[]}';
    const first = new ShaderRegistry({ manifestUrl: '/digest-failure', readText });
    expect((await first.loadManifest()).ok).toBe(true);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(
      new Error('crypto unavailable'),
    );
    const registry = new ShaderRegistry({ manifestUrl: '/digest-failure', readText });
    const result = await registry.loadManifest();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('manifest-malformed');
    expect([...registry.entries()]).toEqual([]);
  });

  it('compares complete native text without collapsing distinct unpaired UTF-16 code units', async () => {
    const nativeText = (hash: string) =>
      `{"entries":[{"hash":"${hash}","wgsl":"fn main() {}","bindings":"[]"}]}`;
    const first = new ShaderRegistry({
      manifestUrl: '/native-text',
      readText: async () => nativeText('\uD800'),
    });
    const second = new ShaderRegistry({
      manifestUrl: '/native-text',
      readText: async () => nativeText('\uD801'),
    });
    expect((await first.loadManifest()).ok).toBe(true);
    expect((await second.loadManifest()).ok).toBe(true);
    expect([...first.entries()][0]?.hash).toBe('\uD800');
    expect([...second.entries()][0]?.hash).toBe('\uD801');
  });

  it('reuses the admitted manifest for a second registry once the deferred text digest settles', async () => {
    serve(() => publication('fn deferred() {}\n'));
    const first = await loaded('/deferred/manifest.json');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await loaded('/deferred/manifest.json');
    expect(first.result.ok && second.result.ok).toBe(true);
    expect([...second.registry.entries()][0]).toBe([...first.registry.entries()][0]);
  });

  it('keys a fetched manifest by its wire bytes: same bytes reuse, different bytes do not', async () => {
    const text = JSON.stringify(publication('fn wire() {}\n'));
    // Same decoded text, different wire bytes (extra JSON whitespace).
    const padded = `${text} `;
    let body = text;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
    const first = await loaded('/wire/manifest.json');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const same = await loaded('/wire/manifest.json');
    expect([...same.registry.entries()][0]).toBe([...first.registry.entries()][0]);
    body = padded;
    const different = await loaded('/wire/manifest.json');
    expect(different.result.ok).toBe(true);
    expect([...different.registry.entries()][0]).not.toBe([...first.registry.entries()][0]);
  });

  it('digests the wire bytes, not a per-character copy of the decoded text', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    serve(() => publication('fn sized() {}\n'));
    const wireLength = JSON.stringify(publication('fn sized() {}\n')).length;
    await loaded('/sized/manifest.json');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const keyed = digest.mock.calls.filter(
      (call) => (call[1] as ArrayBufferView).byteLength === wireLength,
    );
    expect(keyed.length).toBeGreaterThan(0);
  });

  it('does not keep the decoded manifest text alive while the wire reuse key is pending', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    // 48 MiB of trailing JSON whitespace: decoded into a one-byte string the
    // parsed manifest never references, so only a leaked closure can retain it.
    // The body is served as bytes, so the decoded text is the registry's only copy.
    const body = new TextEncoder().encode(
      `${JSON.stringify(publication('fn pending() {}\n'))}${' '.repeat(48 << 20)}`,
    );
    const native = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((algorithm, data) =>
      (data as ArrayBufferView).byteLength === body.byteLength
        ? new Promise<ArrayBuffer>(() => {})
        : native(algorithm, data),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
    gc();
    const before = process.memoryUsage().heapUsed;
    const { result } = await loaded('/pending-key/manifest.json');
    expect(result.ok).toBe(true);
    gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(24 << 20);
  });

  it('shares one verified expansion across registries loading identical manifest text', async () => {
    serve(() => publication('fn shared() {}\n'));
    const first = await loaded('/shared/manifest.json');
    const second = await loaded('/shared/manifest.json');
    expect(first.result.ok && second.result.ok).toBe(true);
    const [firstEntry] = first.registry.entries();
    const [secondEntry] = second.registry.entries();
    expect(firstEntry?.wgsl).toBe('fn shared() {}\n');
    expect(secondEntry).toBe(firstEntry);
    const [firstMaterial] = first.registry.materialShaderManifestEntries();
    const [secondMaterial] = second.registry.materialShaderManifestEntries();
    expect(secondMaterial).toBe(firstMaterial);
  });

  it('re-admits changed text at the same URL and still rejects corrupted sources', async () => {
    let current = publication('fn before() {}\n');
    serve(() => current);
    const before = await loaded('/changing/manifest.json');
    current = publication('fn after() {}\n');
    const after = await loaded('/changing/manifest.json');
    expect(before.result.ok && after.result.ok).toBe(true);
    expect([...after.registry.entries()][0]?.wgsl).toBe('fn after() {}\n');
    expect([...before.registry.entries()][0]?.wgsl).toBe('fn before() {}\n');

    const corrupted = publication('fn after() {}\n');
    corrupted.fragments[0] = 'fn tampered() {}\n';
    current = corrupted;
    const refused = await loaded('/changing/manifest.json');
    expect(refused.result.ok).toBe(false);
    if (!refused.result.ok) expect(refused.result.error.code).toBe('manifest-malformed');
    expect([...refused.registry.entries()]).toEqual([]);
  });
});
