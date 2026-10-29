import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookRayContext,
} from '@forgeax/engine-pack';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  MATERIAL_CONTEXT,
  materialRecordFixture,
} from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { MeshFilter, MeshRenderer } from '../components';
import { renderMaterialContext } from '../extract/material-context';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication } from '../publication/record';
import { worldRenderResources } from '../publication/resource-scope';
import {
  materialSurfaceProgramsForMaterial,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it('keeps cooked Forward and ShadowCaster programs when owned values change or a catalogue entry is replaced', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const record = materialRecordFixture({
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.8 },
    passes: [
      { name: 'Forward', program: { module: 'game::material' } },
      { name: 'ShadowCaster', program: { module: 'game::shadow' } },
    ],
  });
  const [firstPass, ...otherPasses] = record.resolved.passes;
  if (firstPass === undefined) throw new Error('Missing cooked passes');
  const base: MaterialAsset = {
    kind: 'material',
    ...record.resolved,
    passes: [firstPass, ...otherPasses],
    values: Object.fromEntries(
      Object.entries(record.resolved.values).filter(
        (entry): entry is [string, Exclude<(typeof entry)[1], null>] => entry[1] !== null,
      ),
    ),
  };
  publishRuntimeAssets(assets, [
    { guid: record.guid, asset: { ...base, cooked: record } as MaterialAsset },
  ]);
  const handle = (await assets.load(record.guid, 'material')).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  world.update(0).unwrap();
  const frameRead = () =>
    extractFrames([world], 0, assets, undefined, {
      materialContext: MATERIAL_CONTEXT,
      cull: 'none',
    }).renderables.at(0)?.materials[0]?.snapshot;
  const read = () =>
    resolveMaterialSnapshot(
      handle,
      worldRenderResources(world),
      assets,
      undefined,
      undefined,
      MATERIAL_CONTEXT,
    );
  const before = read();
  expect(frameRead()?.materialPublication).toEqual(before.materialPublication);
  expect(before.materialPublication?.identity).toMatchObject({
    materialGuid: record.guid,
    publicationGeneration: record.publicationGeneration,
  });
  expect(before.materialPublication?.programs.map((program) => program.specializationKey)).toEqual(
    Object.values(before.materialProgramKeys ?? {}),
  );
  expect(Object.isFrozen(before.materialPublication?.identity)).toBe(true);
  expect(Object.isFrozen(before.materialPublication?.programs)).toBe(true);
  const shader = assets.shaderRegistry.findMaterialArtifact(before.materialShaderId ?? '').unwrap();
  expect(before.materialParamSchema).toBe(shader.paramSchema);
  expect(frameRead()?.materialParamSchema).toBe(shader.paramSchema);
  expect(frameRead()?.materialProgramKeys).toEqual(before.materialProgramKeys);
  expect(Object.keys(before.materialProgramKeys ?? {})).toEqual(['Forward', 'ShadowCaster']);
  assets.update(handle, { values: { roughness: 0.25 } }).unwrap();
  expect(read().roughness).toBe(0.25);
  expect(read().materialParamSchema).toBe(shader.paramSchema);
  expect(frameRead()?.materialParamSchema).toBe(shader.paramSchema);
  expect(frameRead()?.materialProgramKeys).toEqual(before.materialProgramKeys);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
  publishRuntimeAssets(assets, [
    { guid: record.guid, asset: { ...base, values: { roughness: 0.6 } } },
  ]);
  // A latest GUID/catalogue entry must not relabel an existing World payload.
  expect(read().materialPublication).toEqual(before.materialPublication);
  expect(frameRead()?.materialPublication).toEqual(before.materialPublication);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
  assets.update(handle, { values: { roughness: 0.8 } }).unwrap();
  expect(read().roughness).toBeCloseTo(0.8);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
});

it('carries both accepted Surface programs through value edits and detached publication', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const receiverAssets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const context: MaterialCookRayContext = {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'ray',
    geometry: 'mesh',
    pass: 'ray-hit',
    profile: 'forgeax-material-ray-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  };
  const publishMaterial = async (generation: number) => {
    const record = materialRecordFixture({
      generation,
      parameters: [
        { name: 'roughness', type: 'f32', default: 0.8 },
        { name: 'alphaCutoff', type: 'f32', default: 0 },
      ],
      passes: [{ name: 'Forward', program: { module: 'game::material' } }],
    });
    const bytes = new TextEncoder().encode(`ray fixture generation ${generation}`);
    const digest = createMaterialArtifactDigest(bytes);
    const ray = {
      specializationKey: `program/${digest}`,
      artifact: { mediaType: 'text/wgsl' as const, path: 'ray.wgsl', bytes, digest },
      selections: [{ pass: 'Forward', context, entry: 'cs_surface' }],
    };
    const cardBytes = new TextEncoder().encode(`card fixture generation ${generation}`);
    const cardDigest = createMaterialArtifactDigest(cardBytes);
    const card = {
      specializationKey: `program/${cardDigest}`,
      artifact: {
        mediaType: 'text/wgsl' as const,
        path: 'card.wgsl',
        bytes: cardBytes,
        digest: cardDigest,
      },
      selections: [
        {
          pass: 'Forward',
          context: { ...context, pass: 'card-capture' as const },
          entry: 'vs_card',
        },
      ],
    };
    const programs = [...record.programs, ray, card];
    const artifactDigest = createMaterialProgramSetDigest(programs, record.resolved.passes);
    const cooked = {
      ...record,
      programs,
      artifactDigest,
      receipt: { ...record.receipt, identity: { ...record.receipt.identity, artifactDigest } },
    };
    const [first, ...rest] = cooked.resolved.passes;
    if (
      !first ||
      !cooked.parameterContract ||
      !cooked.sourceClosure ||
      cooked.specializationKey === undefined ||
      cooked.artifactDigest === undefined
    )
      throw new Error('incomplete fixture');
    const material: MaterialAsset = {
      kind: 'material',
      parameters: cooked.resolved.parameters,
      passes: [first, ...rest],
      values: {},
    };
    publishRuntimeAssets(assets, [
      { guid: cooked.guid, asset: { ...material, cooked } as MaterialAsset },
    ]);
    const loaded = (await assets.load(cooked.guid, 'material')).unwrap();
    return {
      guid: cooked.guid,
      material: runtimeAssets(assets).resolveAsset<MaterialAsset>(loaded).unwrap(),
      key: ray.specializationKey,
      bytes,
      cardKey: card.specializationKey,
      cardBytes,
    };
  };
  const first = await publishMaterial(1);
  for (const context of [
    { ...MATERIAL_CONTEXT, backend: 'webgl2' as const },
    { ...MATERIAL_CONTEXT, capability: 'uniform-fallback' as const },
    { ...MATERIAL_CONTEXT, geometry: 'skinned' as const },
    { ...MATERIAL_CONTEXT, instrumentation: 'validation' as const },
  ])
    expect(
      materialSurfaceProgramsForMaterial(first.material, assets, context, first.material),
    ).toBeUndefined();
  const handle = (await assets.load(first.guid, 'material')).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  world.update(0).unwrap();
  const read = () =>
    resolveMaterialSnapshot(
      handle,
      worldRenderResources(world),
      assets,
      undefined,
      undefined,
      MATERIAL_CONTEXT,
    );
  const frameRead = () =>
    extractFrames([world], 0, assets, undefined, {
      materialContext: MATERIAL_CONTEXT,
      cull: 'none',
    }).renderables.at(0)?.material.snapshot;
  expect(read().materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  expect(
    materialSurfaceProgramsForMaterial(
      first.material,
      assets,
      { ...MATERIAL_CONTEXT, capability: 'storage-buffer-atmosphere' },
      first.material,
    )?.['ray-hit']?.programKey,
  ).toBe(first.key);
  expect(frameRead()?.materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  expect(read().materialSurfacePrograms?.['card-capture']?.programKey).toBe(first.cardKey);
  expect(frameRead()?.materialSurfacePrograms?.['card-capture']?.programKey).toBe(first.cardKey);
  expect(read().materialSurfacePrograms?.['ray-hit']?.evaluateCoverage).toBe(false);
  assets.update(handle, { values: { alphaCutoff: 0.5 } }).unwrap();
  expect(read().materialSurfacePrograms?.['ray-hit']).toEqual({
    programKey: first.key,
    evaluateCoverage: true,
  });
  expect(frameRead()?.materialSurfacePrograms?.['ray-hit']).toEqual(
    read().materialSurfacePrograms?.['ray-hit'],
  );
  assets.update(handle, { values: { alphaCutoff: 0 } }).unwrap();
  expect(read().materialSurfacePrograms?.['ray-hit']?.evaluateCoverage).toBe(false);
  // An arbitrary Surface can cut holes even with zero Standard alphaCutoff.
  expect(
    materialSurfaceProgramsForMaterial(first.material, assets, MATERIAL_CONTEXT, {
      ...first.material,
      surface: { model: 'standard', module: 'game::cut-holes' },
    })?.['ray-hit']?.evaluateCoverage,
  ).toBe(true);

  assets.update(handle, { values: { roughness: 0.25 } }).unwrap();
  expect(read().roughness).toBe(0.25);
  expect(read().materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  const latest = await publishMaterial(2);
  expect(latest.key).not.toBe(first.key);
  expect(read().materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  expect(frameRead()?.materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  expect(read().materialSurfacePrograms?.['card-capture']?.programKey).toBe(first.cardKey);
  expect(frameRead()?.materialSurfacePrograms?.['card-capture']?.programKey).toBe(first.cardKey);
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const identity = { source: 'ray-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, {
    ...device.caps,
    backendKind: 'webgpu',
  });
  try {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    expect(packet.programs.some((program) => program.key === first.key)).toBe(true);
    expect(packet.programs.some((program) => program.key === first.cardKey)).toBe(true);
    expect(packet.programs.some((program) => program.key === latest.cardKey)).toBe(false);
    expect(packet.programs.some((program) => program.key === latest.key)).toBe(false);
    const accepted = new RenderPublicationReceiver(identity)
      .accept(encodeRenderPublication(packet), receiverAssets)
      .unwrap();
    const material = accepted.frame.renderables.at(0)?.material.snapshot;
    expect(material?.materialParamSchema).toBe(
      receiverAssets.shaderRegistry.findMaterialArtifact(material?.materialShaderId ?? '').unwrap()
        .paramSchema,
    );
    expect(
      accepted.frame.renderables.at(0)?.material.snapshot.materialSurfacePrograms?.['ray-hit']
        ?.programKey,
    ).toBe(first.key);
    expect(receiverAssets.getMaterialArtifact(first.key)?.bytes).toEqual(first.bytes);
    expect(
      accepted.frame.renderables.at(0)?.material.snapshot.materialSurfacePrograms?.['card-capture']
        ?.programKey,
    ).toBe(first.cardKey);
    expect(receiverAssets.getMaterialArtifact(first.cardKey)?.bytes).toEqual(first.cardBytes);
    expect(receiverAssets.getMaterialArtifact(latest.key)).toBeUndefined();
    assets.update(handle, { values: { roughness: 0.8 } }).unwrap();
    expect(read().roughness).toBeCloseTo(0.8);
    expect(read().materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  } finally {
    publisher.dispose();
  }
});

it.each([
  [16, 'storage-buffer-minimum'],
  [20, 'storage-buffer-minimum'],
  [21, 'storage-buffer-projector'],
  [23, 'storage-buffer-projector'],
  [24, 'storage-buffer-projector'],
  [25, 'storage-buffer'],
  [30, 'storage-buffer'],
  [31, 'storage-buffer'],
  [32, 'storage-buffer-atmosphere'],
] as const)('selects the published texture topology at device limit %s', async (limit, capability) => {
  const context = renderMaterialContext(
    { backendKind: 'webgpu', storageBuffer: true },
    { maxSampledTexturesPerShaderStage: limit },
  ).materialContext;
  expect(context?.capability).toBe(capability);
  const record = materialRecordFixture({ contexts: [{ ...MATERIAL_CONTEXT, capability }] });
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const material = { kind: 'material', ...record.resolved } as MaterialAsset;
  const payload = { ...material, cooked: record };
  publishRuntimeAssets(assets, [{ guid: record.guid, asset: payload }]);
  const world = new World({ assets });
  const handle = (await assets.load(record.guid, 'material')).unwrap();
  const snapshot = resolveMaterialSnapshot(
    handle,
    worldRenderResources(world),
    assets,
    undefined,
    undefined,
    context,
  );
  expect(Object.values(snapshot.materialProgramKeys ?? {})).toEqual([
    record.programs[0]?.specializationKey,
  ]);
});
