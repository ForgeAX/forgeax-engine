import { createHash } from 'node:crypto';
import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import {
  buildVisibilityDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { AssetHandle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../../shader-compiler/src/material/pack-cooker';
import { MeshFilter, MeshRenderer } from '../../components';
import { buildGpuDrivenDraws } from '../../extract/gpu-driven';
import { renderMaterialContext } from '../../extract/material-context';
import { MaterialResource } from '../../material-resource';
import { Materials } from '../../materials';
import { installPublicationPrograms } from '../../publication/programs';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../../publication/record';
import { worldRenderResources } from '../../publication/resource-scope';
import {
  defaultMaterialSnapshot,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import { PersistentRenderScene, RenderScene } from '../../scene/render-scene';
import { projectSceneFields, SceneFieldRows } from '../scene-field-projection';

const matrix = (x = 0) => {
  const value = mat4.identity(mat4.create());
  value[12] = x;
  return value;
};
async function fixture(world = new World(), worldId = 0) {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  world.bindAssets(assets).unwrap();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const positions = geometry.attributes.position as Float32Array;
  const indices = geometry.indices;
  assert(indices);
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.5,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const mesh: MeshAsset = {
    ...geometry,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 18,
        vertexCount: 12,
        materialSlot: 1,
        topology: 'triangle-list',
      },
      {
        indexOffset: 18,
        indexCount: 18,
        vertexCount: 12,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
    materialSlots: [{ slotName: 'second' }, { slotName: 'first' }],
    distanceField: {
      ...field,
      sectionSidedness: [0, 0],
      artifact: {
        integrity: {
          algorithm: 'sha256',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        assetCodec: { ...MESH_VISIBILITY_DISTANCE_FIELD_CODEC },
      },
    },
  };
  const materialAsset: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
  };
  const materialHandle = assets.create(materialAsset).unwrap();
  const material = {
    ...defaultMaterialSnapshot(),
    materialHandle,
    materialShaderId: 'forgeax::default-standard-pbr',
    renderState: { cullMode: 'back' as const },
    paramSnapshot: { alphaCutoff: 0 },
  };
  const source: RenderableSnapshot = {
    worldId,
    entityKey: 31,
    assetHandle: assets.create(mesh).unwrap(),
    transform: { world: matrix() },
    material: MaterialResource.from(material),
    materials: [MaterialResource.from(material), MaterialResource.from(material)],
    materialBindingSources: ['renderer-override', 'renderer-override'],
    gpuDrivenDraws: buildGpuDrivenDraws({
      mesh,
      deformation: 'rigid',
      materials: [material, material],
      fallbackMaterial: material,
    }),
  };
  const scene = new RenderScene();
  const update = (snapshot = source) =>
    scene.apply([
      { kind: 'update', worldId: snapshot.worldId, entityKey: snapshot.entityKey, snapshot },
    ]);
  update();
  const project = (maxInstances = 16) =>
    projectSceneFields(
      scene.slotsSnapshot(),
      [world].map(worldRenderResources),
      { maxInstances, maxFieldBytes: 1024 * 1024 },
      assets,
    );
  return { assets, world, mesh, materialAsset, materialHandle, source, scene, update, project };
}

it('projects complete retained slots times instances and shares one owned whole-mesh field', async () => {
  const f = await fixture();
  f.update({
    ...f.source,
    transform: { world: matrix(3) },
    instances: {
      transforms: new Float32Array([...matrix(2), ...matrix(4)]),
      instanceCount: 2,
      generations: new Uint32Array([7, 8]),
      cacheKey: 31,
      archVersion: 0,
    },
  });
  f.update({ ...f.source, entityKey: 32, transform: { world: matrix(100) } });
  f.update({ ...f.source, entityKey: 33, authorVisible: false });
  const result = f.project().unwrap();
  expect(result.instances).toHaveLength(3);
  expect(result.sources).toHaveLength(2);
  expect(result.instances.map((instance) => instance.transform[12])).toEqual([5, 7, 100]);
  expect(new Set(result.instances.map((instance) => instance.field)).size).toBe(1);
  expect(result.instances[0]?.field).not.toBe(f.mesh.distanceField);
  expect(result.sources[0]?.field).toEqual(f.mesh.distanceField);
  expect(result.sources[0]?.generation).toBe(0);
  expect(result.sources[0]?.materials.map((material) => material.materialSlot)).toEqual([1, 0]);
  const field = result.instances[0]?.field;
  if (!field || 'missing' in field) throw new Error('expected admitted field');
  const before = field.values.slice();
  f.mesh.distanceField?.values.fill(99);
  expect(field.values).toEqual(before);
  expect(field.values.buffer).not.toBe(f.mesh.distanceField?.values.buffer);
});

it('rejects a transparent section even when absent from supplied backend draws', async () => {
  const f = await fixture();
  const materials = [
    f.source.material,
    MaterialResource.from({ ...f.source.material.snapshot, transparent: true }),
  ];
  f.update({
    ...f.source,
    materials,
    gpuDrivenDraws: buildGpuDrivenDraws({
      mesh: f.mesh,
      deformation: 'rigid',
      materials: materials.map((resource) => resource.snapshot),
      fallbackMaterial: f.source.material.snapshot,
    }).filter((draw) => draw.materialSlot === 0),
  });
  expect(f.scene.slotsSnapshot().at(0)?.snapshot.gpuDrivenDraws).toHaveLength(1);
  expect(f.project().ok).toBe(false);
});

it('observes runtime vertex replacement and restoration through the owning resolver', async () => {
  const f = await fixture();
  const initial = f.project().unwrap();
  f.assets
    .update(f.source.assetHandle as AssetHandle<'mesh'>, {
      vertices: new Float32Array(f.mesh.vertices),
    })
    .unwrap();
  expect(
    runtimeAssets(f.world.assets)
      .resolveAsset<MeshAsset>(f.source.assetHandle as never)
      .unwrap().distanceField,
  ).toBeUndefined();
  expect(f.project().ok).toBe(false);
  f.assets.replace(f.source.assetHandle as AssetHandle<'mesh'>, f.mesh).unwrap();
  expect(f.project().unwrap().sources[0]?.mesh).toEqual(initial.sources[0]?.mesh);
});

it('keeps runtime handles scoped to their actual owners', async () => {
  const first = await fixture(),
    second = await fixture(new World(), 1);
  expect(first.source.assetHandle).not.toBe(second.source.assetHandle);
  first.update({ ...second.source, transform: { world: matrix(20) } });
  const result = projectSceneFields(
    first.scene.slotsSnapshot(),
    [first.world, second.world].map(worldRenderResources),
    { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
    first.assets,
  ).unwrap();
  expect(result.sources.map((source) => source.scope)).toEqual(
    [first.world, second.world].map(worldRenderResources),
  );
  expect(result.sources.map((source) => source.mesh)).toEqual([first.mesh, second.mesh]);
  expect(new Set(result.instances.map((instance) => instance.geometryId)).size).toBe(2);
  expect(new Set(result.instances.map((instance) => instance.field)).size).toBe(2);
  expect(result.instances.map((instance) => instance.transform[12])).toEqual([0, 20]);
});

it('freezes artifact, policy and instance facts across same-handle replacement and slot reuse', async () => {
  const f = await fixture();
  const transforms = new Float32Array([...matrix(2), ...matrix(4)]),
    generations = new Uint32Array([5, 6]);
  f.update({
    ...f.source,
    instances: {
      transforms,
      generations,
      instanceCount: 2,
      cacheKey: 31,
      archVersion: 0,
      revision: 2,
    },
  });
  const first = f.project().unwrap();
  const field = f.mesh.distanceField;
  assert(field?.artifact);
  const digest = field.artifact.integrity.digest;
  Reflect.set(field.artifact.integrity, 'digest', `sha256:${'f'.repeat(64)}`);
  const replacement = structuredClone(field);
  Reflect.set(f.mesh, 'distanceField', replacement);
  f.assets.replace(f.source.assetHandle as AssetHandle<'mesh'>, f.mesh).unwrap();
  transforms[12] = 9;
  generations[0] = 7;
  const second = f.project().unwrap();
  expect(first.sources[0]?.fieldSnapshot.artifact?.integrity.digest).toBe(digest);
  expect(first.sources[0]?.field).not.toBe(field);
  expect(second.sources[0]?.field).toEqual(replacement);
  expect(first.sources[0]?.instances?.generations).toEqual(new Uint32Array([5, 6]));
  expect(first.instances[0]?.transform[12]).toBe(2);
  f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 31 }]);
  f.update({ ...f.source, entityKey: 44 });
  const next = f.project().unwrap();
  expect(next.sources[0]?.slot).toBe(first.sources[0]?.slot);
  expect(next.sources[0]?.generation).not.toBe(first.sources[0]?.generation);
});

it('uses explicit complete-roster budgets and counts shared field bytes once', async () => {
  const f = await fixture();
  const field = f.mesh.distanceField;
  assert(field);
  const bytes = field.bricks.byteLength + field.values.byteLength;
  f.update({ ...f.source, entityKey: 32 });
  const project = (maxInstances: number, maxFieldBytes: number) =>
    projectSceneFields(
      f.scene.slotsSnapshot(),
      [f.world].map(worldRenderResources),
      { maxInstances, maxFieldBytes },
      f.assets,
    );
  expect(project(2, bytes).unwrap().instances).toHaveLength(2);
  for (const budget of [
    [1, bytes],
    [2, bytes - 1],
    [0, bytes],
    [1025, bytes],
    [2, 0],
    [2, Infinity],
  ])
    expect(project(budget[0] ?? 0, budget[1] ?? 0)).toMatchObject({
      ok: false,
      error: { code: 'ray-reference-limit' },
    });
});

it('admits a complete source without backend draws and rejects contradictory present ranges', async () => {
  const f = await fixture();
  const { gpuDrivenDraws, ...withoutDraws } = f.source;
  f.update(withoutDraws);
  expect(f.project().unwrap().instances).toHaveLength(1);
  assert(gpuDrivenDraws?.[0]);
  f.update({ ...f.source, gpuDrivenDraws: [{ ...gpuDrivenDraws[0], first: 3 }] });
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it.each([
  'skinBinding',
  'morph',
] as const)('excludes deforming %s sources from the field and reports them', async (key) => {
  const f = await fixture();
  f.update({
    ...f.source,
    entityKey: 32,
    transform: { world: matrix(100) },
    [key]: key === 'skinBinding' ? { skeleton: 7, joints: [19] } : {},
  } as RenderableSnapshot);
  const projected = f.project().unwrap();
  expect(projected.instances).toHaveLength(1);
  expect(projected.sources.map((s) => s.entityKey)).toEqual([31]);
  expect(projected.deforming).toEqual([expect.objectContaining({ worldId: 0, entityKey: 32 })]);
});

it.each([
  'lods',
  'spriteInstances',
  'pointsLines',
] as const)('atomically rejects unsupported offscreen %s sources', async (key) => {
  const f = await fixture();
  f.update({
    ...f.source,
    entityKey: 32,
    transform: { world: matrix(100) },
    [key]: key === 'lods' ? [{}] : {},
  } as RenderableSnapshot);
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it.each([
  'missing',
  'artifact',
  'codec',
  'sidedness',
  'partition',
  'mesh-lod',
])('rejects actual mesh %s failures', async (fault) => {
  const f = await fixture(),
    field = f.mesh.distanceField;
  assert(field?.artifact);
  if (fault === 'missing') Reflect.deleteProperty(f.mesh, 'distanceField');
  if (fault === 'artifact') Reflect.deleteProperty(field, 'artifact');
  if (fault === 'codec') Reflect.set(field.artifact.assetCodec, 'version', 'stale');
  if (fault === 'sidedness') Reflect.set(field, 'sectionSidedness', [1, 0]);
  if (fault === 'partition') Reflect.set(f.mesh, 'submeshes', f.mesh.submeshes.slice(1));
  if (fault === 'mesh-lod') {
    expect(
      f.assets.update(f.source.assetHandle as AssetHandle<'mesh'>, {
        lods: [{}] as unknown as NonNullable<MeshAsset['lods']>,
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    return;
  }
  f.assets.replace(f.source.assetHandle as AssetHandle<'mesh'>, f.mesh).unwrap();
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it('excludes a morph-target mesh as deforming instead of failing the field', async () => {
  const f = await fixture();
  Reflect.set(f.mesh, 'morphTargets', [
    { position: new Float32Array((f.mesh.attributes.position as Float32Array).length) },
  ]);
  f.assets.replace(f.source.assetHandle as AssetHandle<'mesh'>, f.mesh).unwrap();
  const projected = f.project().unwrap();
  expect(projected.instances).toHaveLength(0);
  expect(projected.deforming).toHaveLength(1);
});

it.each([
  'singular',
  'shear',
  'nonfinite',
  'projective',
  'instance-length',
  'instance-generation',
])('rejects %s transforms or instance identity', async (fault) => {
  const f = await fixture(),
    world = matrix();
  if (fault === 'singular') world[0] = 0;
  if (fault === 'shear') world[4] = 0.3;
  if (fault === 'nonfinite') world[12] = NaN;
  if (fault === 'projective') world[15] = 2;
  f.update({
    ...f.source,
    transform: { world },
    ...(fault.startsWith('instance')
      ? {
          instances: {
            transforms: fault === 'instance-length' ? new Float32Array(15) : matrix(),
            instanceCount: 1,
            generations: new Uint32Array([fault === 'instance-generation' ? 0 : 1]),
            cacheKey: 31,
            archVersion: 0,
          },
        }
      : {}),
  });
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it.each([
  'alphaHash',
  'opacity',
  'custom',
  'front-cull',
])('rejects actual material %s beyond sampled MASK approximation', async (fault) => {
  const f = await fixture();
  if (fault === 'alphaHash') Reflect.set(f.materialAsset, 'values', { alphaHash: 1 });
  if (fault === 'opacity') Reflect.set(f.materialAsset, 'values', { baseColor: [1, 1, 1, 0.5] });
  if (fault === 'custom')
    Reflect.set(f.materialAsset, 'passes', [
      { name: 'Forward', program: { module: 'custom::surface' } },
    ]);
  if (fault === 'front-cull')
    Reflect.set(f.materialAsset, 'passes', [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { cullMode: 'front' },
      },
    ]);
  f.assets.replace(f.materialHandle, f.materialAsset).unwrap();
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it.each([
  'displacementScale',
  'clippingControl',
])('reads effective %s content rather than trusting the old material snapshot', async (parameter) => {
  const f = await fixture();
  const texture = f.assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(4),
    })
    .unwrap();
  f.assets
    .update(f.materialHandle, {
      values: { displacementTexture: texture, displacementScale: 0, clippingControl: [0, 0, 0, 0] },
    })
    .unwrap();
  expect(f.project().ok).toBe(true);
  f.assets
    .update(f.materialHandle, {
      values: { [parameter]: parameter === 'displacementScale' ? 1 : [1, 0, 0, 0] },
    })
    .unwrap();
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
  f.assets
    .update(f.materialHandle, {
      values: { [parameter]: parameter === 'displacementScale' ? 0 : [0, 0, 0, 0] },
    })
    .unwrap();
  expect(f.project().ok).toBe(true);
});

it('resolves inherited native values and records MASK as omitted alpha coverage', async () => {
  const f = await fixture();
  const parent = AssetGuid.random();
  publishRuntimeAssets(f.assets, [
    {
      guid: AssetGuid.format(parent),
      asset: { ...f.materialAsset, values: { alphaCutoff: 0.5, baseColor: [1, 1, 1, 0.5] } },
    },
  ]);
  (await f.assets.load(parent, 'material')).unwrap();
  const child: MaterialAsset = { kind: 'material', parent };
  const handle = f.assets.create(child).unwrap();
  const material = MaterialResource.from({ ...f.source.material.snapshot, materialHandle: handle });
  f.update({ ...f.source, material, materials: [material, material] });
  const result = f.project().unwrap();
  expect(result.sources[0]?.materials[0]?.payload.parent).toBeUndefined();
  expect(result.sources[0]?.materials[0]?.alphaCoverageOmitted).toBe(true);
  expect(result.sources[0]?.materials[0]?.facts.paramSnapshot?.alphaCutoff).toBe(0.5);
});

it('projects the actual transferred receiver mesh and rejects then restores runtime vertex content', async () => {
  const f = await fixture();
  const publisher = createRenderPublisher(f.world, f.assets, {
    source: 'field-projection',
    epoch: 1,
  });
  const receiver = new RenderPublicationReceiver({ source: 'field-projection', epoch: 1 });
  const scene = new PersistentRenderScene({ assets: f.assets });
  f.world
    .spawn(
      { component: Transform, data: { pos: [3, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: f.source.assetHandle as AssetHandle<'mesh'> } },
      {
        component: MeshRenderer,
        data: {
          materials: [f.materialHandle, f.materialHandle],
        },
      },
    )
    .unwrap();
  const publish = () => {
    f.world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(encodeRenderPublication(packet)), {
      transfer: renderPublicationTransfers(encodeRenderPublication(packet)),
    });
    publisher.recycle(packet.revision, returned).unwrap();
    return projectSceneFields(
      scene.compositionSlots(),
      [accepted.resources],
      { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
      f.assets,
    );
  };
  try {
    const first = publish().unwrap();
    assert(first.sources[0]);
    assert(f.source.assetHandle !== undefined);
    const received = first.sources[0].scope.resolveAsset<MeshAsset>(f.source.assetHandle).unwrap();
    expect(first.sources[0]?.mesh).toBe(received);
    expect(received).not.toBe(f.mesh);
    expect(first.instances[0]?.transform[12]).toBe(3);
    expect(first.sources[0]?.fieldSnapshot.values.buffer).not.toBe(
      received.distanceField?.values.buffer,
    );
    f.assets
      .update(f.source.assetHandle as AssetHandle<'mesh'>, {
        vertices: new Float32Array(f.mesh.vertices),
      })
      .unwrap();
    expect(publish().ok).toBe(false);
    const originalField = f.mesh.distanceField;
    assert(originalField && f.mesh.indices);
    const replacement = (
      await buildVisibilityDistanceField(
        f.mesh.attributes.position as Float32Array,
        f.mesh.indices,
        {
          voxelSize: 0.25,
          triangleSidedness: new Uint8Array(f.mesh.indices.length / 3),
        },
      )
    ).unwrap();
    const bytes = (await encodeMeshDistanceField(replacement)).unwrap();
    Reflect.set(f.mesh, 'distanceField', {
      ...replacement,
      sectionSidedness: [0, 0],
      artifact: {
        integrity: {
          algorithm: 'sha256',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        assetCodec: { ...MESH_VISIBILITY_DISTANCE_FIELD_CODEC },
      },
    });
    f.assets.replace(f.source.assetHandle as AssetHandle<'mesh'>, f.mesh).unwrap();
    const restored = publish().unwrap();
    expect(restored.sources[0]?.scope.identity).toBe(first.sources[0]?.scope.identity);
    expect(restored.sources[0]?.assetHandle).toBe(first.sources[0]?.assetHandle);
    expect(restored.sources[0]?.mesh).not.toBe(first.sources[0]?.mesh);
    expect(restored.sources[0]?.field).not.toBe(first.sources[0]?.field);
    expect(restored.sources[0]?.fieldSnapshot.artifact).not.toEqual(
      first.sources[0]?.fieldSnapshot.artifact,
    );
    expect(first.sources[0]?.fieldSnapshot.values).toEqual(originalField.values);
  } finally {
    publisher.dispose();
  }
});

it('keeps cooked program admission while the owned material values advance', async () => {
  const f = await fixture();
  const guid = AssetGuid.random(),
    text = AssetGuid.format(guid);
  const authored = Materials.standard({ baseColor: [1, 1, 1, 1], alphaCutoff: 0.5 });
  const cooked = await createMaterialPackCooker().cook({ guid: text, source: authored });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({ guid: text, record, artifacts: cooked.artifacts }),
    loadReference: async () => true,
  }).load({ guid: text, specializationKey: record.specializationKey ?? '' });
  expect(ready.status).toBe('Ready');
  if (ready.status !== 'Ready') throw new Error(JSON.stringify(ready));
  publishRuntimeAssets(f.assets, [
    { guid: text, asset: { ...authored, cooked: ready.record } as MaterialAsset },
  ]);
  const handle = (await f.assets.load(guid, 'material')).unwrap();
  const original = f.assets.read(handle).unwrap();
  const projection = f.assets.getMaterialProjectionForPayload(
    runtimeAssets(f.assets).resolveAsset<MaterialAsset>(handle).unwrap(),
  );
  f.assets.update(handle, { values: { alphaCutoff: 0.75 } }).unwrap();
  const snapshot = resolveMaterialSnapshot(
    Number(handle),
    worldRenderResources(f.world),
    f.assets,
    undefined,
    undefined,
    renderMaterialContext(
      { backendKind: 'webgpu', storageBuffer: true },
      { maxSampledTexturesPerShaderStage: 16 },
    ).materialContext,
  );
  const resource = MaterialResource.from(snapshot);
  f.update({ ...f.source, material: resource, materials: [resource, resource] });
  const result = f.project().unwrap();
  const material = result.sources[0]?.materials[0];
  expect(material?.payload.values?.alphaCutoff).toBe(0.75);
  expect(original.values?.alphaCutoff).toBe(0.5);
  expect(material?.payload).toBe(runtimeAssets(f.assets).resolveAsset(handle).unwrap());
  expect(material?.projection).toBe(projection);
  expect(material?.projection?.runtimeValues.alphaCutoff).toBe(0.5);
  expect(material?.facts.paramSnapshot?.alphaCutoff).toBe(0.75);
  expect(material?.alphaCoverageOmitted).toBe(true);
  f.assets.update(handle, { values: { alphaHash: 1 } }).unwrap();
  expect(f.project().ok).toBe(false);
  f.assets.update(handle, { values: { alphaHash: 0 } }).unwrap();
  expect(f.project().ok).toBe(true);
  // The packet carries real cooked programs but not the AssetRegistry's
  // payload-to-native-projection proof. Refuse that unqualified receiver.
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const caps = { ...device.caps, backendKind: 'webgpu' as const, storageBuffer: true };
  const publisher = createRenderPublisher(
    f.world,
    f.assets,
    { source: 'cooked-field', epoch: 1 },
    caps,
    [],
    undefined,
    { maxSampledTexturesPerShaderStage: 16 },
  );
  const receiver = new RenderPublicationReceiver({ source: 'cooked-field', epoch: 1 });
  const receiverAssets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const retained = new PersistentRenderScene({ assets: f.assets });
  f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: f.source.assetHandle as AssetHandle<'mesh'> } },
      { component: MeshRenderer, data: { materials: [handle, handle] } },
    )
    .unwrap();
  try {
    f.world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const received = receiver.accept(encodeRenderPublication(packet)).unwrap();
    expect(packet.programs.length).toBeGreaterThan(0);
    installPublicationPrograms(receiverAssets, packet.programs);
    retained.consumePublication(received);
    const result = projectSceneFields(
      retained.compositionSlots(),
      [received.resources],
      { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
      receiverAssets,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ray-reference-invalid',
        detail: { cause: 'retained field requires accepted native Standard material provenance' },
      },
    });
  } finally {
    publisher.dispose();
  }
}, 60000);

it('re-admits only the D changed rows and keeps the roster revision across unrelated edits', async () => {
  const f = await fixture();
  const hidden = 2000;
  f.scene.apply(
    Array.from({ length: hidden }, (_, index) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: 1000 + index,
      snapshot: { ...f.source, entityKey: 1000 + index, authorVisible: false },
    })),
  );
  const identity = {};
  const rows = () => ({
    identity,
    slots: f.scene.slotsSnapshot(),
    materials: new MaterialFrame(undefined),
    meshes: new MeshFrame(),
  });
  const worlds = [f.world].map(worldRenderResources);
  const budget = { maxInstances: 16, maxFieldBytes: 1024 * 1024 };
  const fields = new SceneFieldRows();
  const cold = fields.update(rows(), worlds, budget, f.assets).unwrap();
  expect(cold.sources).toHaveLength(1);
  const coldVisits = fields.visits;
  expect(coldVisits).toBe(hidden + 1);
  const revision = fields.revision;

  // D unrelated row edits: D visits, no roster change, the same assembled projection.
  const D = 8;
  f.scene.apply(
    Array.from({ length: D }, (_, index) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: 1000 + index * 37,
      snapshot: {
        ...f.source,
        entityKey: 1000 + index * 37,
        authorVisible: false,
        transform: { world: matrix(index + 1) },
      },
    })),
  );
  const steady = fields.update(rows(), worlds, budget, f.assets).unwrap();
  expect(fields.visits - coldVisits).toBe(D);
  expect(fields.revision).toBe(revision);
  expect(steady).toBe(cold);

  // Moving the field source re-admits one row and changes only its transform.
  f.update({ ...f.source, transform: { world: matrix(5) } });
  const moved = fields.update(rows(), worlds, budget, f.assets).unwrap();
  expect(fields.visits - coldVisits).toBe(D + 1);
  expect(fields.revision).not.toBe(revision);
  expect(moved.instances[0]?.transform[12]).toBe(5);
  expect(moved.sources[0]?.fieldSnapshot).toBe(cold.sources[0]?.fieldSnapshot);

  // Recovery clears derived state and re-admits every row to the identical roster.
  fields.reset();
  const recovered = fields.update(rows(), worlds, budget, f.assets).unwrap();
  expect(recovered.instances.map((instance) => Array.from(instance.transform))).toEqual(
    moved.instances.map((instance) => Array.from(instance.transform)),
  );
  expect(recovered.sources.map(({ slot, generation }) => [slot, generation])).toEqual(
    moved.sources.map(({ slot, generation }) => [slot, generation]),
  );
});
