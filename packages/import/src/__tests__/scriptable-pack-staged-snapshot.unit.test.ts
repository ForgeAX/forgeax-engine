import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidType, MeshAsset } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createScriptablePackStagedAssetSnapshotSource,
  type ScriptablePackStagedOwner,
} from '../index.js';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function mesh(seed: number): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([seed, 0, 0]),
    attributes: {},
    submeshes: [
      {
        topology: 'triangle-list',
        indexOffset: 0,
        indexCount: 0,
        vertexCount: 1,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

const ROOT = guid('019ffa97-2000-7000-8000-000000000001');
const DEPENDENCY = guid('019ffa97-2000-7000-8000-000000000002');
const HEALTHY = guid('019ffa97-2000-7000-8000-000000000003');

describe('ScriptablePack staged asset snapshot source', () => {
  it('lazily builds owners in one generation, memoizes, and returns private clones', async () => {
    const builds: string[] = [];
    const owners: ScriptablePackStagedOwner[] = [
      {
        id: 'dependency.pack.ts',
        guids: [DEPENDENCY],
        async build() {
          builds.push('dependency');
          return ok([
            {
              guid: DEPENDENCY,
              sourceKey: 'dependency',
              asset: mesh(2),
              digest: 'sha256:dependency',
            },
          ]);
        },
      },
      {
        id: 'root.pack.ts',
        guids: [ROOT],
        async build(source) {
          builds.push('root:start');
          const dependency = await source.readByGuid(DEPENDENCY);
          if (!dependency.ok) return dependency;
          builds.push('root:end');
          const value = dependency.value.asset as MeshAsset;
          return ok([{ guid: ROOT, sourceKey: 'root', asset: mesh(value.vertices[0] ?? 0) }]);
        },
      },
    ];
    const source = createScriptablePackStagedAssetSnapshotSource({ generation: 12, owners });
    const first = await source.readByGuid(ROOT);
    expect(first).toMatchObject({ ok: true, value: { generation: 12 } });
    if (!first.ok) return;
    expect(builds).toEqual(['root:start', 'dependency', 'root:end']);
    expect((first.value.asset as MeshAsset).vertices[0]).toBe(2);

    (first.value.asset as MeshAsset).vertices[0] = 99;
    const second = await source.readByGuid(ROOT);
    expect(second.ok && (second.value.asset as MeshAsset).vertices[0]).toBe(2);
    expect(builds).toEqual(['root:start', 'dependency', 'root:end']);
    expect(second.ok && second.value.digest).toMatch(/^sha256:/);
  });

  it('fails a content dependency cycle structurally', async () => {
    const owners: ScriptablePackStagedOwner[] = [
      {
        id: 'a.pack.ts',
        guids: [ROOT],
        async build(source) {
          const result = await source.readByGuid(DEPENDENCY);
          return result.ok
            ? ok([{ guid: ROOT, sourceKey: 'root', asset: result.value.asset }])
            : result;
        },
      },
      {
        id: 'b.pack.ts',
        guids: [DEPENDENCY],
        async build(source) {
          const result = await source.readByGuid(ROOT);
          return result.ok
            ? ok([{ guid: DEPENDENCY, sourceKey: 'dependency', asset: result.value.asset }])
            : result;
        },
      },
    ];
    const source = createScriptablePackStagedAssetSnapshotSource({
      generation: 1,
      owners,
    });
    const result = await source.readByGuid(ROOT);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-content-dependency-stalled',
        detail: {
          waitingGuids: [AssetGuid.format(ROOT)],
          pendingSubjects: ['a.pack.ts', 'b.pack.ts', 'a.pack.ts'],
        },
      },
    });
  });

  it('fails a content dependency without a local owner', async () => {
    const source = createScriptablePackStagedAssetSnapshotSource({
      generation: 1,
      owners: [
        {
          id: 'root.pack.ts',
          guids: [ROOT],
          async build(ownerSource) {
            const result = await ownerSource.readByGuid(DEPENDENCY);
            return result.ok
              ? ok([{ guid: ROOT, sourceKey: 'root', asset: result.value.asset }])
              : result;
          },
        },
      ],
    });

    await expect(source.readByGuid(ROOT)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'asset-not-imported',
        expected: 'a staged local owner for the requested GUID',
      },
    });
  });

  it('resolves declared direct Pack outputs in the same generation', async () => {
    const source = createScriptablePackStagedAssetSnapshotSource({
      generation: 3,
      declaredExternalOutputs: [{ guid: DEPENDENCY, sourceKey: 'dependency', asset: mesh(7) }],
      owners: [
        {
          id: 'root.pack.ts',
          guids: [ROOT],
          async build(ownerSource) {
            const dependency = await ownerSource.readByGuid(DEPENDENCY);
            return dependency.ok
              ? ok([
                  {
                    guid: ROOT,
                    sourceKey: 'root',
                    asset: mesh((dependency.value.asset as MeshAsset).vertices[0] ?? 0),
                  },
                ])
              : dependency;
          },
        },
      ],
    });
    const result = await source.readByGuid(ROOT);
    expect(result).toMatchObject({ ok: true, value: { generation: 3 } });
    expect(result.ok && (result.value.asset as MeshAsset).vertices[0]).toBe(7);
  });

  it('retries a refused local owner on the same source and coalesces repaired reads', async () => {
    let rootBuilds = 0;
    let dependencyBuilds = 0;
    let healthyBuilds = 0;
    let repaired = false;
    let releaseRepair!: () => void;
    const repairBuildGate = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const failure = new AssetError({
      code: 'asset-not-imported',
      expected: 'the repaired local ScriptablePack capability',
      hint: 'repair the local producer capability and retry the same source',
    });
    const owners: ScriptablePackStagedOwner[] = [
      {
        id: 'dependency.pack.ts',
        guids: [DEPENDENCY],
        async build() {
          dependencyBuilds += 1;
          return ok([
            {
              guid: DEPENDENCY,
              sourceKey: 'dependency',
              asset: mesh(2),
              digest: 'sha256:dependency',
            },
          ]);
        },
      },
      {
        id: 'root.pack.ts',
        guids: [ROOT],
        async build(source) {
          rootBuilds += 1;
          const dependency = await source.readByGuid(DEPENDENCY);
          if (!dependency.ok) return dependency;
          if (!repaired) return err(failure);
          await repairBuildGate;
          const value = dependency.value.asset as MeshAsset;
          return ok([
            {
              guid: ROOT,
              sourceKey: 'root',
              asset: mesh((value.vertices[0] ?? 0) + 1),
              digest: 'sha256:root',
            },
          ]);
        },
      },
      {
        id: 'healthy.pack.ts',
        guids: [HEALTHY],
        async build() {
          healthyBuilds += 1;
          return ok([
            { guid: HEALTHY, sourceKey: 'healthy', asset: mesh(7), digest: 'sha256:healthy' },
          ]);
        },
      },
    ];
    const source = createScriptablePackStagedAssetSnapshotSource({
      generation: 27,
      owners,
    });

    const refused = await source.readByGuid(ROOT);
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'asset-not-imported',
        expected: 'the repaired local ScriptablePack capability',
        hint: 'repair the local producer capability and retry the same source',
      },
    });
    expect(rootBuilds).toBe(1);
    expect(dependencyBuilds).toBe(1);

    const healthy = await source.readByGuid(HEALTHY);
    expect(healthy).toMatchObject({
      ok: true,
      value: { generation: 27, digest: 'sha256:healthy' },
    });
    expect(healthyBuilds).toBe(1);

    repaired = true;
    const repairedReads = [
      source.readByGuid(ROOT),
      source.readByGuid(ROOT),
      source.readByGuid(ROOT),
    ];
    expect(rootBuilds).toBe(2);
    releaseRepair();
    const [first, second, third] = await Promise.all(repairedReads);
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      !first.ok ||
      !second.ok ||
      !third.ok
    )
      throw new Error('repaired concurrent reads must all return snapshots');
    expect(first).toMatchObject({ ok: true, value: { generation: 27, digest: 'sha256:root' } });
    expect(second).toMatchObject({ ok: true, value: { generation: 27, digest: 'sha256:root' } });
    expect(third).toMatchObject({ ok: true, value: { generation: 27, digest: 'sha256:root' } });
    expect((first.value.asset as MeshAsset).vertices[0]).toBe(3);
    expect(rootBuilds).toBe(2);
    expect(dependencyBuilds).toBe(1);
    expect(healthyBuilds).toBe(1);

    const dependency = await source.readByGuid(DEPENDENCY);
    expect(dependency).toMatchObject({
      ok: true,
      value: { generation: 27, digest: 'sha256:dependency' },
    });
    (first.value.asset as MeshAsset).vertices[0] = 99;
    const memoized = await source.readByGuid(ROOT);
    expect(memoized).toMatchObject({ ok: true, value: { generation: 27, digest: 'sha256:root' } });
    expect(memoized.ok && (memoized.value.asset as MeshAsset).vertices[0]).toBe(3);
    expect(rootBuilds).toBe(2);
  });

  it('carries the staged generation into every locally built snapshot', async () => {
    const owner: ScriptablePackStagedOwner = {
      id: 'mesh.pack.ts',
      guids: [ROOT],
      async build() {
        return ok([{ guid: ROOT, sourceKey: 'mesh', asset: mesh(3), digest: 'sha256:mesh' }]);
      },
    };
    const first = await createScriptablePackStagedAssetSnapshotSource({
      generation: 8,
      owners: [owner],
    }).readByGuid(ROOT);
    const second = await createScriptablePackStagedAssetSnapshotSource({
      generation: 9,
      owners: [owner],
    }).readByGuid(ROOT);

    expect(first).toMatchObject({ ok: true, value: { generation: 8, digest: 'sha256:mesh' } });
    expect(second).toMatchObject({ ok: true, value: { generation: 9, digest: 'sha256:mesh' } });
  });
});
