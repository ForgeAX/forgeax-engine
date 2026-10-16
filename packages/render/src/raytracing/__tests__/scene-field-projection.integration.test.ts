import { createHash } from 'node:crypto';
import {
  AssetRegistry,
  createMaterialLoader,
  RuntimeMaterialValue,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
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
import { type MaterialAsset, type MeshAsset, toShared } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../../../../shader-compiler/src/material/pack-cooker';
import { MeshFilter, MeshRenderer } from '../../components';
import { buildGpuDrivenDraws } from '../../extract/gpu-driven';
import { renderMaterialContext } from '../../extract/material-context';
import { Materials } from '../../materials';
import { renderPublicationTransfers } from '../../publication/contract';
import { installPublicationPrograms } from '../../publication/programs';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import {
  defaultMaterialSnapshot,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../../render-system-extract';
import { PersistentRenderScene, RenderScene } from '../../scene/render-scene';
import { projectSceneFields } from '../scene-field-projection';

const matrix = (x = 0) => {
  const value = mat4.identity(mat4.create());
  value[12] = x;
  return value;
};
const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));

async function fixture(world = new World(), worldId = 0) {
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
  const materialHandle = Number(world.allocSharedRef('MaterialAsset', materialAsset));
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
    assetHandle: Number(world.allocSharedRef('MeshAsset', mesh)),
    transform: { world: matrix() },
    material,
    materials: [material, material],
    materialBindingSources: ['renderer-override', 'renderer-override'],
    gpuDrivenDraws: buildGpuDrivenDraws({
      submeshes: mesh.submeshes,
      indexed: true,
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
      [world],
      { maxInstances, maxFieldBytes: 1024 * 1024 },
      assets,
    );
  return { world, mesh, materialAsset, source, scene, update, project };
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
  expect(result.sources[0]?.field).toBe(f.mesh.distanceField);
  expect(result.sources[0]?.generation).toBe(0);
  expect(result.sources[0]?.materials.map((material) => material.materialSlot)).toEqual([1, 0]);
  const field = result.instances[0]?.field;
  if (!field || 'missing' in field) throw new Error('expected admitted field');
  const before = field.values.slice();
  f.mesh.distanceField?.values.fill(99);
  expect(field.values).toEqual(before);
  expect(field.values.buffer).not.toBe(f.mesh.distanceField?.values.buffer);
});

it('rejects a transparent section omitted by the actual GPU draw producer', async () => {
  const f = await fixture();
  const materials = [f.source.material, { ...f.source.material, transparent: true }];
  f.update({
    ...f.source,
    materials,
    gpuDrivenDraws: buildGpuDrivenDraws({
      submeshes: f.mesh.submeshes,
      indexed: true,
      materials,
      fallbackMaterial: f.source.material,
    }),
  });
  expect(f.scene.slotsSnapshot()[0]?.snapshot.gpuDrivenDraws).toHaveLength(1);
  expect(f.project().ok).toBe(false);
});

it('observes runtime vertex replacement and restoration through the owning resolver', async () => {
  const f = await fixture();
  const initial = f.project().unwrap();
  const entity = f.world
    .spawn({
      component: RuntimeMeshVertices,
      data: {
        asset: toShared<'MeshAsset'>(f.source.assetHandle),
        vertices: new Float32Array(f.mesh.vertices),
      },
    })
    .unwrap();
  expect(
    resolveAssetHandle<MeshAsset>(f.world, f.source.assetHandle as never).unwrap().distanceField,
  ).toBeUndefined();
  expect(f.project().ok).toBe(false);
  f.world.despawn(entity).unwrap();
  expect(f.project().unwrap().sources[0]?.mesh).toBe(initial.sources[0]?.mesh);
});

it('keeps identical numeric handles in different Worlds scoped to their actual payload', async () => {
  const first = await fixture(),
    second = await fixture(new World(), 1);
  expect(first.source.assetHandle).toBe(second.source.assetHandle);
  first.update({ ...second.source, transform: { world: matrix(20) } });
  const result = projectSceneFields(
    first.scene.slotsSnapshot(),
    [first.world, second.world],
    { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
    assets,
  ).unwrap();
  expect(result.sources.map((source) => source.scope)).toEqual([first.world, second.world]);
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
  transforms[12] = 9;
  generations[0] = 7;
  const second = f.project().unwrap();
  expect(first.sources[0]?.fieldSnapshot.artifact?.integrity.digest).toBe(digest);
  expect(first.sources[0]?.field).toBe(field);
  expect(second.sources[0]?.field).toBe(replacement);
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
    projectSceneFields(f.scene.slotsSnapshot(), [f.world], { maxInstances, maxFieldBytes }, assets);
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
  'skin',
  'skinPose',
  'morph',
] as const)('excludes deforming %s sources from the field and reports them', async (key) => {
  const f = await fixture();
  f.update({
    ...f.source,
    entityKey: 32,
    transform: { world: matrix(100) },
    [key]: {},
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
  if (fault === 'mesh-lod') Reflect.set(f.mesh, 'lods', [{}]);
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it('excludes a morph-target mesh as deforming instead of failing the field', async () => {
  const f = await fixture();
  Reflect.set(f.mesh, 'morphTargets', []);
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
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
});

it.each([
  'displacementScale',
  'clippingControl',
])('reads effective %s content rather than trusting the old material snapshot', async (parameter) => {
  const f = await fixture();
  Reflect.set(f.materialAsset, 'values', {
    displacementTexture: '11111111-1111-4111-8111-111111111111',
    displacementScale: 0,
    clippingControl: [0, 0, 0, 0],
  });
  expect(f.project().ok).toBe(true);
  const content = f.world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: toShared<'MaterialAsset'>(f.source.material.materialHandle ?? 0),
        parameter,
        value: parameter === 'displacementScale' ? [1] : [1, 0, 0, 0],
      },
    })
    .unwrap();
  expect(f.project()).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
  f.world.despawn(content).unwrap();
  expect(f.project().ok).toBe(true);
});

it('resolves inherited native values and records MASK as omitted alpha coverage', async () => {
  const f = await fixture();
  const parent = AssetGuid.random();
  assets
    .catalog(parent, {
      ...f.materialAsset,
      values: { alphaCutoff: 0.5, baseColor: [1, 1, 1, 0.5] },
    })
    .unwrap();
  const child: MaterialAsset = { kind: 'material', parent };
  const handle = Number(f.world.allocSharedRef('MaterialAsset', child));
  const material = { ...f.source.material, materialHandle: handle };
  f.update({ ...f.source, material, materials: [material, material] });
  const result = f.project().unwrap();
  expect(result.sources[0]?.materials[0]?.payload).toBe(child);
  expect(result.sources[0]?.materials[0]?.alphaCoverageOmitted).toBe(true);
  expect(result.sources[0]?.materials[0]?.facts.paramSnapshot?.alphaCutoff).toBe(0.5);
});

it('projects the actual transferred receiver mesh and rejects then restores runtime vertex content', async () => {
  const f = await fixture();
  const publisher = createRenderPublisher(f.world, assets, {
    source: 'field-projection',
    epoch: 1,
  });
  const receiver = new RenderPublicationReceiver({ source: 'field-projection', epoch: 1 });
  const scene = new PersistentRenderScene();
  f.world
    .spawn(
      { component: Transform, data: { pos: [3, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: toShared<'MeshAsset'>(f.source.assetHandle) } },
      {
        component: MeshRenderer,
        data: {
          materials: [
            toShared<'MaterialAsset'>(f.source.material.materialHandle ?? 0),
            toShared<'MaterialAsset'>(f.source.material.materialHandle ?? 0),
          ],
        },
      },
    )
    .unwrap();
  const publish = () => {
    f.world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    publisher.recycle(packet.revision, returned).unwrap();
    return projectSceneFields(
      scene.compositionSlots(),
      [accepted.resources],
      { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
      assets,
    );
  };
  try {
    const first = publish().unwrap();
    assert(first.sources[0]);
    const received = resolveAssetHandle<MeshAsset>(
      first.sources[0].scope,
      toShared(f.source.assetHandle),
    ).unwrap();
    expect(first.sources[0]?.mesh).toBe(received);
    expect(received).not.toBe(f.mesh);
    expect(first.instances[0]?.transform[12]).toBe(3);
    expect(first.sources[0]?.fieldSnapshot.values.buffer).not.toBe(
      received.distanceField?.values.buffer,
    );
    const content = f.world
      .spawn({
        component: RuntimeMeshVertices,
        data: {
          asset: toShared<'MeshAsset'>(f.source.assetHandle),
          vertices: new Float32Array(f.mesh.vertices),
        },
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
    f.world.despawn(content).unwrap();
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

it('keeps actual cooked material admission while effective World values override its publication', async () => {
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
  const payload = assets.catalog(guid, authored).unwrap();
  assets.recordMaterialReadiness(text, ready);
  const handle = f.world.allocSharedRef('MaterialAsset', payload);
  f.world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'alphaCutoff', value: [0.75] },
    })
    .unwrap();
  const snapshot = resolveMaterialSnapshot(
    Number(handle),
    f.world,
    assets,
    undefined,
    undefined,
    renderMaterialContext(
      { backendKind: 'webgpu', storageBuffer: true },
      { maxSampledTexturesPerShaderStage: 16 },
    ).materialContext,
  );
  f.update({ ...f.source, material: snapshot, materials: [snapshot, snapshot] });
  const result = f.project().unwrap();
  const material = result.sources[0]?.materials[0];
  expect(material?.payload).toBe(payload);
  expect(material?.effectivePayload).not.toBe(payload);
  expect(material?.projection).toBe(assets.getMaterialProjectionForPayload(payload));
  expect(material?.projection?.runtimeValues.alphaCutoff).toBe(0.5);
  expect(material?.facts.paramSnapshot?.alphaCutoff).toBe(0.75);
  expect(material?.alphaCoverageOmitted).toBe(true);
  const unsupported = f.world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'alphaHash', value: [1] },
    })
    .unwrap();
  expect(f.project().ok).toBe(false);
  f.world.despawn(unsupported).unwrap();
  expect(f.project().ok).toBe(true);
  // The packet carries real cooked programs but not the AssetRegistry's
  // payload-to-native-projection proof. Refuse that unqualified receiver.
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const caps = { ...device.caps, backendKind: 'webgpu' as const, storageBuffer: true };
  const publisher = createRenderPublisher(
    f.world,
    assets,
    { source: 'cooked-field', epoch: 1 },
    caps,
    [],
    undefined,
    { maxSampledTexturesPerShaderStage: 16 },
  );
  const receiver = new RenderPublicationReceiver({ source: 'cooked-field', epoch: 1 });
  const receiverAssets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const retained = new PersistentRenderScene();
  f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: toShared<'MeshAsset'>(f.source.assetHandle) } },
      { component: MeshRenderer, data: { materials: [handle, handle] } },
    )
    .unwrap();
  try {
    f.world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const received = receiver.accept(packet).unwrap();
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
