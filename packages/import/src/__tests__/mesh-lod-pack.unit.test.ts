import { createSphereGeometry, decodeMeshBinary } from '@forgeax/engine-geometry';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { generatePackMeshLods, type PackMeshLodRequest } from '../mesh-lod-generator.js';
import { buildScriptablePack } from '../scriptable-pack-build.js';
import { createStandardAssetOutputProducerRegistry } from '../standard-output-producers.js';

const packageId = definePackageId('01900000-0000-7000-8000-0000000c0151');
const request: PackMeshLodRequest = {
  maxError: 0.02,
  levels: [
    { triangleRatio: 0.5, screenCoverage: 0.5 },
    { triangleRatio: 0.25, screenCoverage: 0.2 },
  ],
};
const derived = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key)).toLowerCase();

describe('Pack mesh LOD requests (X4)', () => {
  it('publishes the root and its derived levels through the ordinary Mesh producer', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: async ({ packageId: subject }) => {
        const lods = await generatePackMeshLods(
          subject,
          { 'mesh/ball': createSphereGeometry(1, 64, 32).unwrap() },
          { 'mesh/ball': request },
        );
        return lods.ok ? ok(lods.value.outputs) : lods;
      },
    });
    const built = await buildScriptablePack({
      definition,
      sourcePath: 'ball.pack.ts',
      outputs: createStandardAssetOutputProducerRegistry(),
    });
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const assets = built.value.product.assets;
    const keys = ['mesh/ball', 'mesh/ball/lod1', 'mesh/ball/lod2'];
    expect(assets.map((asset) => asset.guid.toLowerCase()).sort()).toEqual(
      keys.map(derived).sort(),
    );
    const decoded = keys.map((key) => {
      const asset = assets.find((entry) => entry.guid.toLowerCase() === derived(key));
      const body = asset?.artifacts.body;
      if (asset === undefined || body === undefined) throw new Error(key);
      const mesh = decodeMeshBinary(
        body.bytes,
        asset.refs.map((ref) => ref.guid),
      );
      if (mesh === undefined) throw new Error(`${key} does not decode`);
      return { asset, mesh };
    });
    const [root, lod1, lod2] = decoded as [
      (typeof decoded)[number],
      (typeof decoded)[number],
      (typeof decoded)[number],
    ];
    expect(root.asset.refs.map((ref) => ref.guid.toLowerCase())).toEqual(
      expect.arrayContaining([derived('mesh/ball/lod1'), derived('mesh/ball/lod2')]),
    );
    expect(
      root.mesh.lods?.map((level) => ({
        mesh: AssetGuid.format(level.mesh as never).toLowerCase(),
        screenCoverage: level.screenCoverage,
      })),
    ).toEqual([
      { mesh: derived('mesh/ball/lod1'), screenCoverage: 0.5 },
      { mesh: derived('mesh/ball/lod2'), screenCoverage: 0.2 },
    ]);
    const triangles = (entry: (typeof decoded)[number]) => (entry.mesh.indices?.length ?? 0) / 3;
    expect(triangles(lod1)).toBeLessThanOrEqual(triangles(root) * 0.5);
    expect(triangles(lod2)).toBeLessThanOrEqual(triangles(root) * 0.25);
    expect(lod1.mesh.lods).toBeUndefined();
  });

  it('derives level GUIDs from the subject package and reports each level', async () => {
    const result = await generatePackMeshLods(
      packageId,
      { 'mesh/ball': createSphereGeometry(1, 32, 16).unwrap() },
      { 'mesh/ball': request },
    );
    if (!result.ok) throw new Error(result.error.detail.reason);
    const generated = result.value;
    expect(Object.keys(generated.outputs).sort()).toEqual([
      'mesh/ball',
      'mesh/ball/lod1',
      'mesh/ball/lod2',
    ]);
    expect(generated.reports['mesh/ball']?.map((report) => report.error <= 0.02)).toEqual([
      true,
      true,
    ]);
  });

  it('applies a per-level error budget over the request default', async () => {
    const ball = createSphereGeometry(1, 64, 32).unwrap();
    const levels = [
      { triangleRatio: 0.2, screenCoverage: 0.5 },
      { triangleRatio: 0.1, screenCoverage: 0.2, maxError: 0.05 },
    ];
    const result = await generatePackMeshLods(
      packageId,
      { 'mesh/ball': ball },
      { 'mesh/ball': { maxError: 0.0005, levels } },
    );
    if (!result.ok) throw new Error(result.error.detail.reason);
    const [fine, coarse] = result.value.reports['mesh/ball'] ?? [];
    expect(fine?.error).toBeLessThanOrEqual(0.0005);
    expect(fine?.targetReached).toBe(false);
    // The sphere's pole fans make the first collapse open a hole; the topology gate locks the
    // defect rings and retries, so the target is approached but not required to be met.
    expect(coarse?.error).toBeGreaterThan(0.0005);
    expect(coarse?.error).toBeLessThanOrEqual(0.05);
    expect(coarse?.triangleCount).toBeLessThan(fine?.triangleCount ?? 0);
    const invalid = await generatePackMeshLods(
      packageId,
      { 'mesh/ball': ball },
      { 'mesh/ball': { maxError: 0.01, levels: [{ ...levels[0], maxError: 2 } as never] } },
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { detail: { reason: 'mesh/ball: a level maxError must lie in [0, 1]' } },
    });
  });

  it('rejects missing or non-mesh roots, taken level keys, and invalid options by source key', async () => {
    const ball = createSphereGeometry(1, 16, 8).unwrap();
    const missing = await generatePackMeshLods(packageId, {}, { 'mesh/ball': request });
    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: 'mesh-lod-generation-invalid',
        detail: { reason: expect.stringMatching(/^mesh\/ball: /) },
      },
    });
    const scene = await generatePackMeshLods(
      packageId,
      { 'scene/main': { kind: 'scene', entities: {} } },
      { 'scene/main': request },
    );
    expect(scene).toMatchObject({ ok: false, error: { code: 'mesh-lod-generation-invalid' } });
    const taken = await generatePackMeshLods(
      packageId,
      { 'mesh/ball': ball, 'mesh/ball/lod1': ball },
      { 'mesh/ball': request },
    );
    expect(taken).toMatchObject({
      ok: false,
      error: { detail: { reason: expect.stringContaining('mesh/ball/lod1') } },
    });
    const ratios = await generatePackMeshLods(
      packageId,
      { 'mesh/ball': ball },
      { 'mesh/ball': { maxError: 0.02, levels: [{ triangleRatio: 1.5, screenCoverage: 0.5 }] } },
    );
    expect(ratios).toMatchObject({
      ok: false,
      error: { detail: { reason: expect.stringMatching(/^mesh\/ball: triangleRatio/) } },
    });
  });
});
