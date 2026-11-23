import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { type MaterialRootAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePack } from '../scriptable-pack-build.js';
import { materialAssetOutputProducer } from '../scriptable-pack-output-producers.js';

const packageId = definePackageId('01900000-0000-7000-8000-0000000000c7');
const COUNT = 12;
const keys = Array.from(
  { length: COUNT },
  (_, index) => `material/m${String(index).padStart(2, '0')}`,
);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function paint(index: number): MaterialRootAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [index / COUNT, 0.2, 0.3, 1] },
  };
}

/**
 * The Pack shape of a modeling job: a serial custom cooker returns each material,
 * whose native material cook is the expensive, parallel step.
 */
function build(options: {
  readonly parallelMaterials: boolean;
  readonly failing?: ReadonlyMap<string, number>;
  readonly held?: ReadonlyMap<string, Promise<void>>;
}) {
  const observed = {
    serialPeak: 0,
    materialPeak: 0,
    serialOrder: [] as string[],
    materialStarted: [] as string[],
    materialFailed: [] as string[],
  };
  let serialActive = 0;
  let materialActive = 0;
  const { promise: overlapping, resolve: releaseOverlap } = testGate();
  const outputs = new AssetOutputProducerRegistry();
  outputs.register(materialAssetOutputProducer);
  const result = buildScriptablePack({
    definition: definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: () =>
        ok(
          Object.fromEntries(
            keys.map((key, index) => [
              key,
              { kind: 'test-job', execution: 'cooked' as const, source: { index } },
            ]),
          ),
        ),
    }),
    sourcePath: 'assets/job.pack.ts',
    outputs,
    availableGuids: new Set<string>(),
    cookers: [
      {
        key: 'test-job',
        async cook(raw: unknown) {
          const input = raw as { guid: string; sourceKey: string; source: { index: number } };
          observed.serialOrder.push(input.sourceKey);
          observed.serialPeak = Math.max(observed.serialPeak, ++serialActive);
          await delay(1);
          serialActive--;
          return {
            guid: input.guid,
            payload: paint(input.source.index),
            refs: [],
            artifacts: {},
            inputFingerprint: `job:${input.sourceKey}`,
          };
        },
      },
      {
        key: 'material',
        ...(options.parallelMaterials ? { concurrency: 'parallel' as const } : {}),
        async cook(raw: unknown) {
          const input = raw as { guid: string; sourceKey: string; source: MaterialRootAsset };
          observed.materialStarted.push(input.sourceKey);
          observed.materialPeak = Math.max(observed.materialPeak, ++materialActive);
          if (options.parallelMaterials) {
            if (materialActive >= 2) releaseOverlap();
            await overlapping;
          }
          await options.held?.get(input.sourceKey);
          // Earlier outputs take longer, so completion order inverts source order.
          const index = keys.indexOf(input.sourceKey);
          await delay(2 * (COUNT - index));
          materialActive--;
          const failAfter = options.failing?.get(input.sourceKey);
          if (failAfter !== undefined) {
            await delay(failAfter);
            observed.materialFailed.push(input.sourceKey);
            throw new Error(`material cook failed: ${input.sourceKey}`);
          }
          return {
            guid: input.guid,
            payload: { ...input.source, cooked: { program: input.sourceKey } },
            refs: [],
            artifacts: {
              [`programs/${index}.wgsl`]: {
                mediaType: 'text/wgsl',
                bytes: new TextEncoder().encode(`// ${input.sourceKey}`),
              },
            },
            inputFingerprint: `material:${input.sourceKey}`,
          };
        },
      },
    ],
  });
  return { result, observed };
}

describe('ScriptablePack output production concurrency', () => {
  it('refills a completed lane while earlier material cooks remain pending', async () => {
    const release = new Map<string, () => void>();
    const held = new Map(
      keys.map((key) => [key, new Promise<void>((resolve) => release.set(key, resolve))]),
    );
    const { result, observed } = build({ parallelMaterials: true, held });
    try {
      await vi.waitFor(() => expect([...observed.materialStarted]).toEqual(keys.slice(0, 4)));
      release.get(keys[3] ?? '')?.();
      await vi.waitFor(() => expect([...observed.materialStarted]).toEqual(keys.slice(0, 5)));
      expect(observed.materialPeak).toBe(4);
    } finally {
      for (const finish of release.values()) finish();
      await result;
    }
    const completed = await result;
    if (!completed.ok) throw completed.error;
    expect(completed.value.stagedOutputs.map((output) => output.sourceKey)).toEqual(keys);
  });

  it('stops refilling on failure and drains the already admitted cooks', async () => {
    const release = new Map<string, () => void>();
    const held = new Map(
      keys.map((key) => [key, new Promise<void>((resolve) => release.set(key, resolve))]),
    );
    const failedKey = keys[3] ?? '';
    const { result, observed } = build({
      parallelMaterials: true,
      held,
      failing: new Map([[failedKey, 0]]),
    });
    let settled = false;
    const completed = result.finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect([...observed.materialStarted]).toEqual(keys.slice(0, 4)));
      release.get(failedKey)?.();
      await vi.waitFor(() => expect([...observed.materialFailed]).toEqual([failedKey]));
      expect(settled).toBe(false);
      expect(observed.materialStarted).toEqual(keys.slice(0, 4));
    } finally {
      for (const finish of release.values()) finish();
      expect(await completed).toMatchObject({
        ok: false,
        error: { detail: { producer: `material cook failed: ${failedKey}` } },
      });
      expect(observed.materialStarted).toEqual(keys.slice(0, 4));
    }
  });

  it('overlaps parallel material cooks and publishes the same product as serial cooking', async () => {
    const serial = build({ parallelMaterials: false });
    const pooled = build({ parallelMaterials: true });
    const [serialResult, pooledResult] = [await serial.result, await pooled.result];
    if (!serialResult.ok || !pooledResult.ok) throw new Error('Pack build failed');
    expect(serial.observed.materialPeak).toBe(1);
    expect(pooled.observed.materialPeak).toBeGreaterThan(1);
    expect(pooled.observed.materialPeak).toBeLessThanOrEqual(4);
    // The serial custom cooker keeps one-at-a-time admission in source order.
    for (const observed of [serial.observed, pooled.observed]) {
      expect(observed.serialPeak).toBe(1);
      expect(observed.serialOrder).toEqual(keys);
    }
    expect(pooledResult.value.product.assets.map((asset) => asset.guid)).toEqual(
      keys.map((key) => AssetGuid.format(AssetGuid.derive(packageId, key))),
    );
    expect(pooledResult.value.stagedOutputs.map((output) => output.sourceKey)).toEqual(keys);
    expect(pooledResult.value.product.sourceRevision).toBe(
      serialResult.value.product.sourceRevision,
    );
    const bytes = (value: typeof pooledResult.value) =>
      Object.entries(value.product.artifacts).map(
        ([path, artifact]) => [path, Buffer.from(artifact.bytes).toString('hex')] as const,
      );
    expect(bytes(pooledResult.value)).toEqual(bytes(serialResult.value));
    expect(pooledResult.value).toEqual(serialResult.value);
  });

  it('reports the first failure in source order even when a later output fails first', async () => {
    // Both failures share one four-output batch; m01 fails after m03.
    const failing = new Map([
      ['material/m01', 40],
      ['material/m03', 0],
    ]);
    for (const parallelMaterials of [false, true]) {
      const { result } = build({ parallelMaterials, failing });
      expect(await result).toMatchObject({
        ok: false,
        error: { detail: { producer: 'material cook failed: material/m01' } },
      });
    }
  });
});
