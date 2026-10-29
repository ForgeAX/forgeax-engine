import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadScriptablePack } from '../scriptable-pack-node.js';

it('keeps the source line and column for a malformed author module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-source-diagnostic-'));
  const source = join(root, 'broken.pack.ts');
  try {
    await writeFile(source, 'export default {\n  build: () => { const = 1; }\n};\n');
    const loaded = await loadScriptablePack(source);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toMatchObject({
      detail: { diagnostic: expect.stringContaining(`${source}:2:`) },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  0, 17,
])('propagates worker exit %i during a build instead of waiting for timeout', async (code) => {
  const root = await mkdtemp(join(tmpdir(), 'pack-worker-exit-'));
  const source = join(root, 'exit.pack.ts');
  try {
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array([121,171,30,178,252,222,65,195,145,119,233,61,213,193,142,245]), build() { process.exit(${code}); } };`,
    );
    const loaded = await loadScriptablePack(source, { buildTimeoutMs: 1000 });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    await expect(
      loaded.value.build({
        packageId: loaded.value.packageId,
        readByGuid: async () => {
          throw new Error('unexpected read');
        },
      }),
    ).rejects.toThrow(`worker exited with code ${code}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses an undeclared externalAssets table from the isolated worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-external-'));
  const source = join(root, 'external.pack.ts');
  try {
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(5), externalAssets: [{ guid: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a31' }], build() { return { ok: true, value: {} }; } };`,
    );
    const loaded = await loadScriptablePack(source);
    expect(loaded).toMatchObject({
      ok: false,
      error: { code: 'pack-parameter-invalid', detail: { propertyPath: '$.externalAssets' } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a structured build throw structured across the isolated worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-worker-structured-throw-'));
  const source = join(root, 'derive.pack.ts');
  try {
    // Mirrors AssetGuid.derive: a TypeError carrying code/expected/hint/detail.
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(6), build() { throw Object.assign(new TypeError('AssetGuid.derive received invalid sourceKey'), { code: 'pack-source-key-invalid', expected: 'lower-case key', hint: 'use kebab-case', detail: { sourceKey: 'material/rockLight', suggestedSourceKey: 'material/rock-light' } }); } };`,
    );
    const loaded = await loadScriptablePack(source);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    await expect(
      loaded.value.build({
        packageId: loaded.value.packageId,
        readByGuid: async () => {
          throw new Error('unexpected read');
        },
      }),
    ).rejects.toMatchObject({
      name: 'TypeError',
      code: 'pack-source-key-invalid',
      expected: 'lower-case key',
      hint: 'use kebab-case',
      detail: { sourceKey: 'material/rockLight', suggestedSourceKey: 'material/rock-light' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
