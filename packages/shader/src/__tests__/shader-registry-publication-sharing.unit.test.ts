import { createHash } from 'node:crypto';
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

  it('reports a native digest failure without adopting manifest entries', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(
      new Error('crypto unavailable'),
    );
    const registry = new ShaderRegistry({
      manifestUrl: '/digest-failure',
      readText: async () => '{"entries":[]}',
    });
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
