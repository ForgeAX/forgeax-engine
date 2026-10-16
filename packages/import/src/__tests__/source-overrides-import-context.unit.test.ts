import type { Asset, ImportContext, ImportedAsset, Importer } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

const GUID = '11111111-1111-4111-8111-111111111111';

function registryFor(impl: (ctx: ImportContext) => readonly ImportedAsset[]): ImporterRegistry {
  const registry = new ImporterRegistry();
  registry.register({
    key: 'fixture',
    import: (ctx) => ({
      ok: true,
      value: {
        assets: impl(ctx),
        sourceDependencies: [],
      },
    }),
  } as Importer);
  return registry;
}

function meta(sourceOverrides?: Record<string, Record<string, unknown>>): RunImportMeta {
  return {
    importer: 'fixture',
    source: 'fixture.source',
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'mesh/main', kind: 'mesh' }],
  } as RunImportMeta;
}

function fs() {
  return { readSource: async () => ({ ok: true as const, value: new Uint8Array([1]) }) };
}

function asset(): ImportedAsset {
  return {
    guid: GUID,
    kind: 'mesh',
    payload: { vertices: new Float32Array(), indices: new Uint16Array(), attributes: {} } as Asset,
    refs: [],
    artifacts: {},
  };
}

describe('source override ImportContext', () => {
  it('passes producer-owned values by exact sourceKey', async () => {
    let received: unknown;
    const result = await runImport(
      meta({ 'mesh/main': { lod: 2, producerFlag: true } }),
      registryFor((ctx) => {
        received = ctx.sourceOverrides;
        return [asset()];
      }),
      fs(),
    );

    expect(result.ok).toBe(true);
    expect(received).toEqual({ 'mesh/main': { lod: 2, producerFlag: true } });
  });

  it('keeps legacy Meta calls free of overrides', async () => {
    let received: unknown = 'sentinel';
    const result = await runImport(
      meta(),
      registryFor((ctx) => {
        received = ctx.sourceOverrides;
        return [asset()];
      }),
      fs(),
    );

    expect(result.ok).toBe(true);
    expect(received).toBeUndefined();
  });

  it('rejects an unknown key before invoking the producer', async () => {
    const producer = vi.fn(() => [asset()]);
    const result = await runImport(meta({ 'mesh/other': { lod: 1 } }), registryFor(producer), fs());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'unknown-source-key',
        expected: 'sourceKey to be declared by the producer topology',
        actual: 'mesh/other',
        hint: expect.any(String),
      });
    }
    expect(producer).not.toHaveBeenCalled();
  });
});
