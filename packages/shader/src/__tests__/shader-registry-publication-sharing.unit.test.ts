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
    schemaVersion: '4.0.0',
    receipts: [],
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
});

describe('ShaderRegistry publication sharing', () => {
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
