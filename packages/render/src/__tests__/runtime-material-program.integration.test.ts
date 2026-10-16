import { AssetRegistry, HANDLE_CUBE, RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
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
import { MeshFilter, MeshRenderer } from '../components';
import { renderMaterialContext } from '../extract/material-context';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import {
  materialSurfaceProgramsForMaterial,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

it('keeps cooked Forward and ShadowCaster programs when World values change or a catalogue entry is replaced', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const world = new World();
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
  assets.catalog(record.guid, base).unwrap();
  if (
    !record.sourceClosure ||
    !record.parameterContract ||
    record.publicationGeneration === undefined ||
    record.specializationKey === undefined ||
    record.artifactDigest === undefined
  )
    throw new Error('Missing cooked metadata');
  assets.recordMaterialReadiness(record.guid, {
    status: 'Ready',
    record: {
      ...record,
      materialGuid: record.guid,
      publicationGeneration: record.publicationGeneration,
      specializationKey: record.specializationKey,
      artifactDigest: record.artifactDigest,
      sourceClosure: record.sourceClosure,
      parameterContract: record.parameterContract,
      programs: record.programs,
    },
  });
  const handle = world.internSharedRef('MaterialAsset', base);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  world.update(0).unwrap();
  const frameRead = () =>
    extractFrames([world], 0, assets, undefined, undefined, {
      materialContext: MATERIAL_CONTEXT,
      cull: 'none',
    }).renderables[0]?.materials[0];
  const read = () =>
    resolveMaterialSnapshot(handle, world, assets, undefined, undefined, MATERIAL_CONTEXT);
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
  const content = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'roughness',
        kind: 0,
        value: [0.25],
      },
    })
    .unwrap();
  expect(read().roughness).toBe(0.25);
  expect(read().materialParamSchema).toBe(shader.paramSchema);
  expect(frameRead()?.materialParamSchema).toBe(shader.paramSchema);
  expect(frameRead()?.materialProgramKeys).toEqual(before.materialProgramKeys);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
  assets.catalog(record.guid, { ...base, values: { roughness: 0.6 } }).unwrap();
  // A latest GUID/catalogue entry must not relabel an existing World payload.
  expect(read().materialPublication).toEqual(before.materialPublication);
  expect(frameRead()?.materialPublication).toEqual(before.materialPublication);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
  world.despawn(content).unwrap();
  expect(read().roughness).toBeCloseTo(0.8);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
});

it('carries both accepted Surface programs through value edits and detached publication', async () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const receiverAssets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const world = new World();
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
  const publishMaterial = (generation: number) => {
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
    assets.catalog(cooked.guid, material).unwrap();
    assets.recordMaterialReadiness(cooked.guid, {
      status: 'Ready',
      record: {
        ...cooked,
        materialGuid: cooked.guid,
        publicationGeneration: generation,
        specializationKey: cooked.specializationKey,
        artifactDigest: cooked.artifactDigest,
        sourceClosure: cooked.sourceClosure,
        parameterContract: cooked.parameterContract,
        programs: cooked.programs,
      },
    });
    return {
      material,
      key: ray.specializationKey,
      bytes,
      cardKey: card.specializationKey,
      cardBytes,
    };
  };
  const first = publishMaterial(1);
  for (const context of [
    { ...MATERIAL_CONTEXT, backend: 'webgl2' as const },
    { ...MATERIAL_CONTEXT, capability: 'uniform-fallback' as const },
    { ...MATERIAL_CONTEXT, geometry: 'skinned' as const },
    { ...MATERIAL_CONTEXT, instrumentation: 'validation' as const },
  ])
    expect(
      materialSurfaceProgramsForMaterial(first.material, assets, context, first.material),
    ).toBeUndefined();
  const handle = world.internSharedRef('MaterialAsset', first.material);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  world.update(0).unwrap();
  const read = () =>
    resolveMaterialSnapshot(handle, world, assets, undefined, undefined, MATERIAL_CONTEXT);
  const frameRead = () =>
    extractFrames([world], 0, assets, undefined, undefined, {
      materialContext: MATERIAL_CONTEXT,
      cull: 'none',
    }).renderables[0]?.material;
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
  const coverage = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'alphaCutoff',
        kind: 0,
        value: [0.5],
      },
    })
    .unwrap();
  expect(read().materialSurfacePrograms?.['ray-hit']).toEqual({
    programKey: first.key,
    evaluateCoverage: true,
  });
  expect(frameRead()?.materialSurfacePrograms?.['ray-hit']).toEqual(
    read().materialSurfacePrograms?.['ray-hit'],
  );
  world.despawn(coverage).unwrap();
  expect(read().materialSurfacePrograms?.['ray-hit']?.evaluateCoverage).toBe(false);
  // An arbitrary Surface can cut holes even with zero Standard alphaCutoff.
  expect(
    materialSurfaceProgramsForMaterial(first.material, assets, MATERIAL_CONTEXT, {
      ...first.material,
      surface: { model: 'standard', module: 'game::cut-holes' },
    })?.['ray-hit']?.evaluateCoverage,
  ).toBe(true);

  const source = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'roughness',
        kind: 0,
        value: [0.25],
      },
    })
    .unwrap();
  expect(read().roughness).toBe(0.25);
  expect(read().materialSurfacePrograms?.['ray-hit']?.programKey).toBe(first.key);
  const latest = publishMaterial(2);
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
      .accept(packet, receiverAssets)
      .unwrap();
    const material = accepted.frame.renderables[0]?.material;
    expect(material?.materialParamSchema).toBe(
      receiverAssets.shaderRegistry.findMaterialArtifact(material?.materialShaderId ?? '').unwrap()
        .paramSchema,
    );
    expect(
      accepted.frame.renderables[0]?.material.materialSurfacePrograms?.['ray-hit']?.programKey,
    ).toBe(first.key);
    expect(receiverAssets.getMaterialArtifact(first.key)?.bytes).toEqual(first.bytes);
    expect(
      accepted.frame.renderables[0]?.material.materialSurfacePrograms?.['card-capture']?.programKey,
    ).toBe(first.cardKey);
    expect(receiverAssets.getMaterialArtifact(first.cardKey)?.bytes).toEqual(first.cardBytes);
    expect(receiverAssets.getMaterialArtifact(latest.key)).toBeUndefined();
    world.despawn(source).unwrap();
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
  [24, 'storage-buffer'],
  [30, 'storage-buffer'],
  [31, 'storage-buffer-atmosphere'],
] as const)('selects the published texture topology at device limit %s', (limit, capability) => {
  const context = renderMaterialContext(
    { backendKind: 'webgpu', storageBuffer: true },
    { maxSampledTexturesPerShaderStage: limit },
  ).materialContext;
  expect(context?.capability).toBe(capability);
  const record = materialRecordFixture({ contexts: [{ ...MATERIAL_CONTEXT, capability }] });
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const material = { kind: 'material', ...record.resolved } as MaterialAsset;
  assets.catalog(record.guid, material).unwrap();
  assets.recordMaterialReadiness(record.guid, { status: 'Ready', record });
  const world = new World();
  const handle = world.internSharedRef('MaterialAsset', material);
  const snapshot = resolveMaterialSnapshot(handle, world, assets, undefined, undefined, context);
  expect(Object.values(snapshot.materialProgramKeys ?? {})).toEqual([
    record.programs[0]?.specializationKey,
  ]);
});
