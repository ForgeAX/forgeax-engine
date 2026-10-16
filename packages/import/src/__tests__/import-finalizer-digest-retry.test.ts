import type { ImportContext, ImportResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

const GUID = '019f0000-0000-7000-8000-000000000071';
const SOURCE = 'assets/m71.fixture';

const meta: RunImportMeta = {
  importer: 'm71-fixture',
  source: SOURCE,
  subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'fixture:main', kind: 'reel-game-blob' }],
  importSettings: { revision: 'm71' },
};

function createRegistry(): ImporterRegistry {
  const registry = new ImporterRegistry();
  registry.register({
    key: meta.importer,
    import: async (ctx: ImportContext): Promise<ImportResult<unknown>> => {
      const source = await ctx.readSource();
      if (!source.ok) throw new Error('fixture source was not readable');
      return {
        ok: true,
        value: {
          assets: [
            {
              guid: GUID,
              kind: 'reel-game-blob',
              payload: { kind: 'reel-game-blob', title: 'M71 digest fixture' },
              refs: [],
              artifacts: {
                body: {
                  mediaType: 'application/x-forgeax-m71',
                  bytes: new Uint8Array([11, 71, 1, 9]),
                },
              },
            },
          ],
          sourceDependencies: [],
        },
      };
    },
  });
  return registry;
}

function createFs(reads: { count: number }) {
  const sourceBytes = new Uint8Array([77, 55, 49, 0]);
  return {
    readSource: async (path: string) => {
      reads.count += 1;
      return path === SOURCE
        ? { ok: true as const, value: sourceBytes }
        : { ok: false as const, error: new Error(`unexpected source path ${path}`) };
    },
  };
}

describe('public import finalizer digest recovery', () => {
  it('returns a structured finalization error and retries idempotently on the same registry', async () => {
    const registry = createRegistry();
    const reads = { count: 0 };
    const fs = createFs(reads);
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error('Web Crypto subtle is unavailable');
    const originalDigest = subtle.digest;
    const publishedDigests = new Set<string>();

    subtle.digest = async () => {
      throw new Error('M71 injected subtle.digest refusal');
    };

    let failed: Awaited<ReturnType<typeof runImport>>;
    try {
      failed = await runImport(meta, registry, fs);
    } finally {
      subtle.digest = originalDigest;
    }

    expect(failed.ok).toBe(false);
    expect(failed).not.toHaveProperty('value');
    if (!failed.ok) {
      expect(failed.error.code).toBe('import-internal-error');
      expect(failed.error.expected).toContain('finalization');
      expect(failed.error.detail).toEqual({
        reason: expect.stringMatching(/finalization.*digest.*M71 injected subtle\.digest refusal/),
      });
    }

    const repaired = await runImport(meta, registry, fs);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok || 'skipped' in repaired.value)
      throw new Error('repair must publish a product');
    expect(repaired.value.cookProducts).toHaveLength(1);
    expect(repaired.value.pack.assets).toHaveLength(1);
    const repairedDigest = repaired.value.cookProducts[0]?.digest;
    if (repairedDigest === undefined) throw new Error('repair must produce a digest');
    publishedDigests.add(repairedDigest);

    const third = await runImport(meta, registry, fs);
    expect(third.ok).toBe(true);
    if (!third.ok || 'skipped' in third.value)
      throw new Error('idempotent run must publish a product');
    expect(third.value.cookProducts[0]?.digest).toBe(repairedDigest);
    expect(third.value.pack).toEqual(repaired.value.pack);
    publishedDigests.add(third.value.cookProducts[0]?.digest ?? '');

    expect(publishedDigests.size).toBe(1);
    expect(registry.registeredImporters()).toEqual([meta.importer]);
    expect(reads.count).toBe(6);
  });
});
