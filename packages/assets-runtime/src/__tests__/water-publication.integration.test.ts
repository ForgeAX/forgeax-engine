import { createWorldContext, defineComponent, World } from '@forgeax/engine-ecs';
import { definePackageId } from '@forgeax/engine-pack/source';
import {
  sceneAssetContribution,
  sceneEntityAddressKey,
  scenePlugin,
  WaterBodyInstance,
  WaterZoneInstance,
  worldDespawnScene,
  worldGetSceneInstanceState,
} from '@forgeax/engine-scene';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  type SceneAsset,
  standardSurfaceParameters,
  type WaterZoneAsset,
} from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  WaterSystem,
  waterAssetDecoderContributions,
} from '@forgeax/engine-water';
import { describe, expect, it, onTestFinished } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';
import { catalogPack } from './fixtures/catalog-pack';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const bodyGuid = '019a0000-0000-7000-8000-000000000101';
const lakeGuid = '019a0000-0000-7000-8000-000000000104';
const oceanGuid = '019a0000-0000-7000-8000-000000000105';
const customGuid = '019a0000-0000-7000-8000-000000000106';
const bodySceneGuid = '019a0000-0000-7000-8000-000000000107';
const zoneSceneGuid = '019a0000-0000-7000-8000-000000000108';
const SceneInstance = defineComponent('SceneInstance', {
  source: 'asset<scene>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});
const materialGuid = '019a0000-0000-7000-8000-000000000102';
const childMaterialGuid = '019a0000-0000-7000-8000-000000000109';
const zoneGuid = '019a0000-0000-7000-8000-000000000103';
const runtimeBodyPackageId = definePackageId('019a0000-0000-7000-8000-000000000110');

function closedBody(type: 'lake' | 'ocean'): Asset {
  const points = [...(body as Extract<Asset, { kind: 'water-body' }>).spline.points];
  const last = requiredFixtureValue(points[points.length - 1]);
  const collision =
    type === 'ocean'
      ? { type: 'none' as const, enabled: false }
      : { type: 'polygon' as const, enabled: true, channelDepthM: 1 };
  return {
    ...body,
    type,
    collision,
    ...(type === 'ocean' ? { oceanExtentM: [10, 10] as const } : {}),
    spline: { closed: true, points: [...points, { ...last, inputKey: 2, positionM: [1, 0, 1] }] },
  } as Asset;
}

const body: Asset = {
  kind: 'water-body',
  type: 'river',
  spline: {
    closed: false,
    points: [0, 1].map((inputKey) => ({
      inputKey,
      positionM: [inputKey, 0, 0] as const,
      arriveTangentM: [1, 0, 0] as const,
      leaveTangentM: [1, 0, 0] as const,
      up: [0, 1, 0] as const,
      rollAngle: 0,
      angleUnit: 'degrees',
      widthM: 1,
      depthM: 1,
      velocityMPerSec: 1,
      audioIntensity: 0,
    })),
  },
  baseHeightM: 0,
  overlapPriority: 0,
  maxWaveHeightM: 0,
  surfaceMaterialGuid: materialGuid,
  zoneGuid,
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'river-prism', enabled: true },
  queryFootprint: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
};

const zone: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 10, spanZM: 10 },
  tileSizeM: 1,
  tessellationFactor: 6,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 32, heightPx: 32 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
};

function installWater(assets: AssetRegistry) {
  for (const contribution of waterAssetDecoderContributions)
    assets.installDecoder(contribution.kind, contribution.decoder);
}

async function cookedRuntimeBody(source: Asset): Promise<Asset> {
  const body = source as Extract<Asset, { kind: 'water-body' }>;
  const cooked = await buildWaterPackOutputs(
    {
      'fixture/body': {
        ...body,
        ...(body.type === 'ocean' ? { centerOnWaterZone: false } : {}),
        flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
        renderOptions: { visible: false },
      },
    },
    { packageId: runtimeBodyPackageId },
  );
  if (!cooked.ok || cooked.value['fixture/body']?.kind !== 'water-body')
    throw new Error(`Water fixture must Pack cook: ${JSON.stringify(cooked)}`);
  return cooked.value['fixture/body'];
}

describe('water source and Registry integration', () => {
  it('resolves a child material through its root for a WaterBody surface slot', async () => {
    const assets = new AssetRegistry();
    installWater(assets);
    const childBody = { ...body, surfaceMaterialGuid: childMaterialGuid };
    publishRuntimeAssets(assets, [
      {
        guid: materialGuid,
        asset: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          parameters: [{ name: 'roughness', type: 'f32' }],
          values: { roughness: 0.9 },
        },
      },
      {
        guid: childMaterialGuid,
        asset: { kind: 'material', parent: materialGuid, values: { roughness: 0.25 } },
        refs: [materialGuid],
      },
      { guid: bodyGuid, asset: childBody, refs: [childMaterialGuid, zoneGuid] },
      { guid: zoneGuid, asset: zone, refs: [] },
    ]);
    onTestFinished(() => assets.dispose());
    const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
    const materialHandle = (await assets.load(childMaterialGuid, 'material')).unwrap();
    expect(assets.read(bodyHandle).unwrap()).toMatchObject({
      surfaceMaterialGuid: childMaterialGuid,
    });
    expect(assets.read(materialHandle).unwrap()).toMatchObject({
      kind: 'material',
      passes: [{ name: 'main' }],
      values: { roughness: 0.25 },
    });
  });

  it('admits a deferred Zone body, binds on arrival, and invalidates retired Zone indices', async () => {
    const assets = new AssetRegistry();
    installWater(assets);
    const [cookedRiver, cookedLake, cookedOcean, cookedCustom] = await Promise.all([
      cookedRuntimeBody(body),
      cookedRuntimeBody(closedBody('lake')),
      cookedRuntimeBody(closedBody('ocean')),
      cookedRuntimeBody({
        ...body,
        type: 'custom',
        collision: { type: 'none', enabled: false },
        flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      }),
    ]);
    publishRuntimeAssets(assets, [
      {
        guid: materialGuid,
        asset: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: { roughness: 1 },
        },
      },
      { guid: bodyGuid, asset: cookedRiver, refs: [materialGuid, zoneGuid] },
      { guid: lakeGuid, asset: cookedLake, refs: [materialGuid, zoneGuid] },
      { guid: oceanGuid, asset: cookedOcean, refs: [materialGuid, zoneGuid] },
      { guid: customGuid, asset: cookedCustom, refs: [materialGuid, zoneGuid] },
      { guid: zoneGuid, asset: zone, refs: [] },
    ]);

    const zoneWorldMatrixM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 2, -7, 1];
    const liveZones = new Map<string, { generation: number; worldMatrixM: readonly number[] }>();
    let zoneGeneration = 0;
    const water = new WaterSystem((guid) => liveZones.get(guid));
    onTestFinished(() => assets.dispose());
    const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
    const bodyVersion = runtimeAssets(assets).version(bodyHandle).unwrap();
    const acceptedBody = assets.read(bodyHandle).unwrap();
    expect(
      assets.replace(bodyHandle, {
        ...acceptedBody,
        spline: {
          ...acceptedBody.spline,
          points: [{ ...requiredFixtureValue(acceptedBody.spline.points[0]), positionM: [0, 0] }],
        },
      } as unknown as Asset),
    ).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
    expect(runtimeAssets(assets).version(bodyHandle).unwrap()).toBe(bodyVersion);
    const accepted = water
      .mountBody(bodyGuid, bodyVersion, assets.read(bodyHandle).unwrap())
      .unwrap();
    expect(accepted.binding).toEqual({
      kind: 'zone-unbound',
      requestedGuid: zoneGuid,
      retryOnCatalogChange: true,
    });
    expect(assets.inspect().assets.some((asset) => asset.guid === zoneGuid)).toBe(false);
    for (const [guid, type] of [
      [lakeGuid, 'lake'],
      [oceanGuid, 'ocean'],
      [customGuid, 'custom'],
    ] as const) {
      const handle = (await assets.load(guid, 'water-body')).unwrap();
      const version = runtimeAssets(assets).version(handle).unwrap();
      expect(water.mountBody(guid, version, assets.read(handle).unwrap()).unwrap().asset.type).toBe(
        type,
      );
    }
    expect(water.snapshots()).toHaveLength(4);
    expect(water.snapshots().every((snapshot) => snapshot.binding.kind === 'zone-unbound')).toBe(
      true,
    );

    let zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
    zoneGeneration += 1;
    liveZones.set(zoneGuid, { generation: zoneGeneration, worldMatrixM: zoneWorldMatrixM });
    expect(water.snapshot(bodyGuid)?.binding).toMatchObject({
      kind: 'bound',
      zoneGuid,
      zoneGeneration,
      worldMatrixM: zoneWorldMatrixM,
    });
    const boundAfterZoneLoad = water.snapshot(bodyGuid)?.binding;
    if (boundAfterZoneLoad?.kind === 'bound') expect(boundAfterZoneLoad.worldMatrixM[12]).toBe(12);
    expect(water.snapshots().every((snapshot) => snapshot.binding.kind === 'bound')).toBe(true);
    water.bindZoneIndex(bodyGuid, zoneGuid, zoneGeneration, 7).unwrap();
    expect(water.zoneIndex(bodyGuid, zoneGuid, zoneGeneration)).toBe(7);

    assets.release(zoneHandle).unwrap();
    liveZones.delete(zoneGuid);
    zoneGeneration += 1;
    expect(water.snapshot(bodyGuid)?.binding.kind).toBe('zone-unbound');
    expect(water.zoneIndex(bodyGuid, zoneGuid, zoneGeneration - 1)).toBeUndefined();

    zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
    liveZones.set(zoneGuid, { generation: ++zoneGeneration, worldMatrixM: zoneWorldMatrixM });
    expect(water.snapshot(bodyGuid)?.binding).toMatchObject({
      kind: 'bound',
      zoneGuid,
      zoneGeneration,
      worldMatrixM: zoneWorldMatrixM,
    });
    expect(water.zoneIndex(bodyGuid, zoneGuid, zoneGeneration)).toBeUndefined();
    water.bindZoneIndex(bodyGuid, zoneGuid, zoneGeneration, 3).unwrap();
    expect(water.zoneIndex(bodyGuid, zoneGuid, zoneGeneration)).toBe(3);
    assets.release(zoneHandle).unwrap();
  });

  it('rejects a declared Zone edge whose target has the wrong published kind', async () => {
    const assets = new AssetRegistry();
    installWater(assets);
    publishRuntimeAssets(assets, [
      {
        guid: materialGuid,
        asset: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: { roughness: 1 },
        },
      },
      { guid: bodyGuid, asset: body, refs: [materialGuid, zoneGuid] },
      {
        guid: zoneGuid,
        asset: { kind: 'texture', width: 1, height: 1, format: 'rgba8unorm' },
        refs: [],
      },
    ]);
    onTestFinished(() => assets.dispose());
    const loaded = await assets.load(bodyGuid, 'water-body');
    expect(loaded).toMatchObject({
      ok: false,
      error: {
        code: 'asset-decode-failed',
        expected: expect.stringContaining('zoneGuid'),
        detail: {
          guid: bodyGuid,
          cause: {
            detail: {
              guid: bodyGuid,
              dependencyGuid: zoneGuid,
              expectedKind: 'water-zone',
              actualKind: 'texture',
            },
          },
        },
      },
    });
  });

  it('demands the late Zone catalog row without decoding its payload', async () => {
    const packageUrl = 'https://water.invalid/deferred.pack.json';
    const sourcePath = 'deferred.pack.ts';
    const produced = catalogPack(
      [
        {
          guid: materialGuid,
          kind: 'material',
          refs: [],
          artifacts: {},
          payload: {
            kind: 'material',
            passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
            values: { roughness: 1 },
          },
        },
        {
          guid: bodyGuid,
          kind: 'water-body',
          refs: [materialGuid, zoneGuid],
          artifacts: {},
          payload: body,
        },
        { guid: zoneGuid, kind: 'water-zone', refs: [], artifacts: {}, payload: zone },
      ],
      { sourcePath, packageUrl },
    );
    const row = (guid: string, kind: string) => ({
      guid,
      kind,
      packageUrl,
      sourcePath,
      publication: produced.publication,
    });
    const zoneRow = row(zoneGuid, 'water-zone');
    const { publication: _zonePublication, ...zoneDeclaration } = zoneRow;
    const catalogDemand: string[] = [];
    const zoneDecodes: string[] = [];
    const assets = new AssetRegistry();
    for (const contribution of waterAssetDecoderContributions) {
      const decoder =
        contribution.kind.kind === 'water-zone'
          ? {
              ...contribution.decoder,
              async decode(input: Parameters<typeof contribution.decoder.decode>[0]) {
                zoneDecodes.push(input.envelope.guid);
                return contribution.decoder.decode(input);
              },
            }
          : contribution.decoder;
      assets.installDecoder(contribution.kind, decoder);
    }
    assets.setCatalogSource(
      createCatalogSource({
        entries: [
          row(materialGuid, 'material'),
          row(bodyGuid, 'water-body'),
          { ...zoneDeclaration, lifecycle: 'missing' },
        ],
        fetch: async () => Response.json(produced.pack),
        importTransport: {
          async fetchPack(guid) {
            catalogDemand.push(guid);
            return { ok: true, entries: [zoneRow] };
          },
        },
      }),
    );
    onTestFinished(() => assets.dispose());
    const loaded = await assets.load(bodyGuid, 'water-body');
    expect(loaded.ok).toBe(true);
    expect(catalogDemand).toEqual([zoneGuid]);
    expect(zoneDecodes).toEqual([]);
    expect(assets.inspect().assets.some((asset) => asset.guid === zoneGuid)).toBe(false);
  });

  it('reloads a newer Water Pack publication and keeps the accepted closure when a dependency is missing', async () => {
    const assets = new AssetRegistry();
    installWater(assets);
    const waveGuid = '019a0000-0000-7000-8000-000000000110';
    const missingMaterialGuid = '019a0000-0000-7000-8000-000000000111';
    const brushGuid = '019a0000-0000-7000-8000-000000000112';
    const terrainGuid = '019a0000-0000-7000-8000-000000000113';
    const terrainGuidByKey = new Map<string, string>();
    const terrainDerivedGuid = (key: string) => {
      const existing = terrainGuidByKey.get(key);
      if (existing) return existing;
      const suffix = (0x120 + terrainGuidByKey.size).toString(16).padStart(12, '0');
      const derived = `019a0000-0000-7000-8000-${suffix}`;
      terrainGuidByKey.set(key, derived);
      return derived;
    };
    const layerMaterial = {
      kind: 'material' as const,
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [0.2, 0.35, 0.28, 1], roughness: 1 },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    };
    const terrainOutputs = buildTerrainAssets(
      {
        columns: 8,
        rows: 8,
        spacing: 1,
        subsectionVertices: 8,
        heights: Float32Array.from({ length: 64 }, (_, index) => Math.sin(index % 8) * 0.1),
        weights: new Float32Array(64).fill(1),
        layers: [{ material: materialGuid, blend: 'weight' }],
      },
      (key) => terrainDerivedGuid(key),
      { [materialGuid]: layerMaterial as unknown as Asset },
    ).unwrap();
    const terrainRoot = terrainOutputs.terrain as Extract<Asset, { kind: 'terrain' }>;
    const terrainPackAssets = Object.entries(terrainOutputs)
      .filter(([key]) => key !== 'terrain')
      .map(([key, payload]) => ({
        guid: terrainDerivedGuid(key),
        kind: payload.kind,
        refs:
          payload.kind === 'material'
            ? [
                terrainDerivedGuid('height'),
                terrainDerivedGuid('section/0/weights'),
                terrainDerivedGuid('control-sampler'),
              ]
            : [],
        artifacts: {},
        payload,
      }));
    terrainPackAssets.push({
      guid: terrainGuid,
      kind: 'terrain',
      refs: [
        ...new Set([
          ...terrainRoot.grids,
          ...terrainRoot.sections.flatMap((section) => [
            section.heightTexture,
            section.weightTexture,
            section.material,
          ]),
        ]),
      ],
      artifacts: {},
      payload: terrainRoot,
    });
    const terrainPackageUrl = 'https://water.invalid/catalog-refresh-terrain.pack.json';
    const terrainPublication = catalogPack(terrainPackAssets, {
      sourcePath: 'terrain-base.pack.ts',
      sourceRevision: 'terrain-r0-1',
      packageUrl: terrainPackageUrl,
    });
    const terrainEntries = terrainPackAssets.map((entry) => ({
      guid: entry.guid,
      kind: entry.kind,
      refs: entry.refs,
      sourcePath: 'terrain-base.pack.ts',
      packageUrl: terrainPackageUrl,
      publication: terrainPublication.publication,
    }));
    const makePublication = (revision: number, sourceBody: Asset, bodyRefs: string[]) => {
      const packageUrl = `https://water.invalid/catalog-refresh-${revision}.pack.json`;
      const produced = catalogPack(
        [
          {
            guid: materialGuid,
            kind: 'material',
            refs: [],
            artifacts: {},
            payload: {
              kind: 'material',
              passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
              values: {},
            },
          },
          { guid: zoneGuid, kind: 'water-zone', refs: [], artifacts: {}, payload: zone },
          {
            guid: waveGuid,
            kind: 'water-wave-set',
            refs: [],
            artifacts: {},
            payload: {
              kind: 'water-wave-set',
              sourceMode: 'predefined',
              waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 1 }],
              depthMaskM: 1,
              maxWaveHeightM: 1,
              timeSource: 'fixed-step',
            },
          },
          {
            guid: bodyGuid,
            kind: 'water-body',
            refs: bodyRefs,
            artifacts: {},
            payload: sourceBody,
          },
          {
            guid: brushGuid,
            kind: 'water-brush-recipe',
            refs: [bodyGuid, terrainGuid],
            artifacts: {},
            payload: {
              kind: 'water-brush-recipe',
              baseTerrainGuid: terrainGuid,
              sourceBodyGuids: [bodyGuid],
              orderedActors: ['river/main'],
              terrainCapture: {
                worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                boundsXZ: { minM: [-0.5, -0.5], maxM: [7.5, 7.5] },
                resolutionPx: [8, 8],
                layerNameToIndex: { water: 0 },
              },
              curves: [],
              textures: [],
              outputTerrainSourceKey: 'terrain/derived',
              rules: {
                falloff: { type: 'smooth', widthM: 2, strength: 1 },
                blend: { type: 'alpha', alpha: 1 },
                heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
                weightRules: { layer: 'water', value: 1, blend: 'replace' },
              },
            },
          },
        ],
        { sourcePath: 'water-r0.pack.ts', sourceRevision: String(revision), packageUrl },
      );
      const entries = produced.pack.assets.map((entry) => ({
        guid: entry.guid,
        kind: entry.kind,
        refs: entry.refs,
        sourcePath: 'water-r0.pack.ts',
        packageUrl,
        publication: produced.publication,
      }));
      return { produced, entries };
    };
    const usePublication = (published: ReturnType<typeof makePublication>) =>
      assets.setCatalogSource(
        createCatalogSource({
          entries: [...published.entries, ...terrainEntries],
          fetch: async (input) =>
            String(input) === terrainPackageUrl
              ? Response.json(terrainPublication.pack)
              : Response.json(published.produced.pack),
        }),
      );
    onTestFinished(() => assets.dispose());
    const initial = makePublication(1, { ...body, waveSetGuid: waveGuid }, [
      materialGuid,
      zoneGuid,
      waveGuid,
    ]);
    usePublication(initial);
    (await assets.reconcileCatalog()).unwrap();
    expect(terrainRoot).toMatchObject({ columns: 8, rows: 8, spacing: 1 });
    expect(assets.catalogEntry(terrainGuid)).toMatchObject({
      kind: 'terrain',
      refs: expect.arrayContaining([
        ...terrainRoot.grids,
        ...terrainRoot.sections.flatMap((section) => [
          section.heightTexture,
          section.weightTexture,
          section.material,
        ]),
      ]),
    });
    expect(assets.catalogEntry(brushGuid)).toMatchObject({
      kind: 'water-brush-recipe',
      refs: expect.arrayContaining([bodyGuid, terrainGuid]),
    });
    const handle = (await assets.load(bodyGuid, 'water-body')).unwrap();
    const first = assets.read(handle).unwrap() as Extract<Asset, { kind: 'water-body' }>;
    const firstSource = requiredFixtureValue(assets.source(handle).unwrap());
    expect(first.spline.points[0]?.widthM).toBe(1);
    expect(firstSource.publication).toMatchObject({
      sourceRevision: '1',
      generation: initial.produced.publication.generation,
      digest: initial.produced.publication.digest,
    });

    const unavailable = makePublication(
      2,
      { ...body, surfaceMaterialGuid: missingMaterialGuid, waveSetGuid: waveGuid },
      [missingMaterialGuid, zoneGuid, waveGuid],
    );
    usePublication(unavailable);
    (await assets.reconcileCatalog()).unwrap();
    expect((await assets.reload(handle, { conflict: 'overwrite' })).ok).toBe(false);
    expect(
      (assets.read(handle).unwrap() as Extract<Asset, { kind: 'water-body' }>).surfaceMaterialGuid,
    ).toBe(first.surfaceMaterialGuid);
    expect(assets.source(handle).unwrap()?.publication).toMatchObject({
      sourceRevision: '1',
      generation: initial.produced.publication.generation,
    });

    const accepted = makePublication(
      3,
      {
        ...body,
        waveSetGuid: waveGuid,
        spline: {
          ...body.spline,
          points: body.spline.points.map((point) => ({ ...point, widthM: 4 })),
        },
      },
      [materialGuid, zoneGuid, waveGuid],
    );
    usePublication(accepted);
    (await assets.reconcileCatalog()).unwrap();
    (await assets.reload(handle, { conflict: 'overwrite' })).unwrap();
    const reloaded = assets.read(handle).unwrap() as Extract<Asset, { kind: 'water-body' }>;
    expect(reloaded.spline.points[0]?.widthM).toBe(4);
    expect(assets.source(handle).unwrap()?.publication).toMatchObject({
      sourceRevision: '3',
      generation: accepted.produced.publication.generation,
      digest: accepted.produced.publication.digest,
    });
  });

  it('instantiates Scene body and Zone bindings through typed ECS components', async () => {
    const assets = new AssetRegistry({
      components: new Map([
        [WaterBodyInstance.name, WaterBodyInstance],
        [WaterZoneInstance.name, WaterZoneInstance],
      ]),
    });
    installWater(assets);
    assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    const cookedBodyAsset = await cookedRuntimeBody(body);
    const bodyScene: SceneAsset = {
      kind: 'scene',
      entities: { river: { components: { WaterBodyInstance: { body: 0 } } } },
    };
    const zoneScene: SceneAsset = {
      kind: 'scene',
      entities: { zone: { components: { WaterZoneInstance: { zone: 0 } } } },
    };
    publishRuntimeAssets(assets, [
      {
        guid: materialGuid,
        asset: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: { roughness: 1 },
        },
      },
      { guid: bodyGuid, asset: cookedBodyAsset, refs: [materialGuid, zoneGuid] },
      { guid: zoneGuid, asset: zone, refs: [] },
      { guid: bodySceneGuid, asset: bodyScene, refs: [bodyGuid] },
      { guid: zoneSceneGuid, asset: zoneScene, refs: [zoneGuid] },
    ]);
    const world = new World({ assets });
    const context = await createWorldContext(world, [scenePlugin()]);
    world.components.register(SceneInstance).unwrap();
    const liveZones = new Map<string, { generation: number }>();
    const water = new WaterSystem((guid) => liveZones.get(guid));
    try {
      const bodySceneHandle = (await assets.load(bodySceneGuid, 'scene')).unwrap();
      expect(assets.inspect().assets.some((asset) => asset.guid === zoneGuid)).toBe(false);
      const bodyRoot = assets.instantiate(bodySceneHandle, world).unwrap();
      const bodyState = worldGetSceneInstanceState(world, bodyRoot).unwrap();
      const bodyEntity = requiredFixtureValue(
        bodyState.bindings.get(sceneEntityAddressKey('river')),
      );
      const bodyBinding = world.get(bodyEntity, WaterBodyInstance).unwrap();
      const bodyAsset = assets.read(bodyBinding.body).unwrap();
      const acceptedBody = water
        .mountBody(bodyGuid, runtimeAssets(assets).version(bodyBinding.body).unwrap(), bodyAsset)
        .unwrap();
      expect(acceptedBody.binding.kind).toBe('zone-unbound');

      const zoneSceneHandle = (await assets.load(zoneSceneGuid, 'scene')).unwrap();
      const zoneRoot = assets.instantiate(zoneSceneHandle, world).unwrap();
      const zoneState = worldGetSceneInstanceState(world, zoneRoot).unwrap();
      const zoneEntity = requiredFixtureValue(
        zoneState.bindings.get(sceneEntityAddressKey('zone')),
      );
      const zoneBinding = world.get(zoneEntity, WaterZoneInstance).unwrap();
      expect(assets.guidOf(zoneBinding.zone)).toBe(zoneGuid);
      const zoneGeneration = 1;
      liveZones.set(zoneGuid, { generation: zoneGeneration });
      expect(water.snapshot(bodyGuid)?.binding).toMatchObject({
        kind: 'bound',
        zoneGuid,
        zoneGeneration,
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      });
      water.bindZoneIndex(bodyGuid, zoneGuid, zoneGeneration, 12).unwrap();
      worldDespawnScene(world, zoneRoot).unwrap();
      liveZones.delete(zoneGuid);
      expect(water.zoneIndex(bodyGuid, zoneGuid, zoneGeneration)).toBeUndefined();
      worldDespawnScene(world, bodyRoot).unwrap();
      assets.release(bodySceneHandle).unwrap();
      assets.release(zoneSceneHandle).unwrap();
    } finally {
      await context.fiber.dispose();
      assets.dispose();
    }
  });
});
