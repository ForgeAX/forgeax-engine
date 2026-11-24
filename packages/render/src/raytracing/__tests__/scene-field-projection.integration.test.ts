import { createHash } from 'node:crypto';
import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import {
  buildMeshDistanceField,
  buildVisibilityDistanceField,
  createBoxGeometry,
  describeMeshDraw,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  meshAttributeChannels,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { AssetHandle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
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
import { RowProjection } from '../../scene/row-projection';
import { adoptFieldEdit, diffFieldEdit, fieldEditState } from '../field-edit';
import { deriveFieldReceivers } from '../field-receiver';
import { packGlobalSdfComposition } from '../global-sdf';
import {
  prepareWorldAcceleration,
  WorldAccelerationGeometryIds,
  worldAccelerationEdit,
  worldAccelerationRoster,
} from '../renderer-world-acceleration';
import { projectSceneFields, SceneFieldRows } from '../scene-field-projection';
import { validateSdfSurfacePoolHeader } from '../sdf-surface-storage';
import { resolveVisibleSurfaceRange, VisibleSurfaceRows } from '../visible-surface';

const matrix = (x = 0) => {
  const value = mat4.identity(mat4.create());
  value[12] = x;
  return value;
};
function admittedFieldBytes(field: NonNullable<MeshAsset['distanceField']>) {
  const surface = field.surface;
  assert(surface);
  // AssetRegistry's Pack copy detaches each channel into its own tight buffer.
  // Include the canonical geometry that the retained snapshot now also owns.
  return [
    field.bricks,
    field.values,
    surface.positions,
    surface.indices,
    surface.nodes,
    surface.primitiveOrder,
    surface.triangleSidedness,
  ].reduce((bytes, channel) => bytes + channel.byteLength, 0);
}
async function fixture(world = new World(), sourceAssets?: AssetRegistry, sectionCount = 2) {
  const assets =
    sourceAssets ??
    new AssetRegistry({
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
    submeshes:
      sectionCount === 3
        ? Array.from({ length: 3 }, (_, index) => ({
            indexOffset: index * 12,
            indexCount: 12,
            vertexCount: 8,
            materialSlot: index % 2,
            topology: 'triangle-list' as const,
          }))
        : [
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
      sectionSidedness: new Array<0 | 1>(sectionCount).fill(0),
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
    entityKey: 31,
    assetHandle: assets.create(mesh).unwrap(),
    transform: { world: matrix() },
    material: MaterialResource.from(material),
    materials: [MaterialResource.from(material), MaterialResource.from(material)],
    materialBindingSources: ['renderer-override', 'renderer-override'],
    gpuDrivenDraws: buildGpuDrivenDraws({
      mesh: describeMeshDraw(mesh),
      deformation: 'rigid',
      materials: [material, material],
      fallbackMaterial: material,
    }),
  };
  const scene = new RenderScene();
  const update = (snapshot = source) =>
    scene.apply([{ kind: 'update', entityKey: snapshot.entityKey, snapshot }]);
  update();
  const project = (maxInstances = 16) =>
    projectSceneFields(
      scene.slotsSnapshot(),
      worldRenderResources(world),
      { maxInstances, maxFieldBytes: 1024 * 1024 },
      assets,
    );
  return { assets, world, mesh, materialAsset, materialHandle, source, scene, update, project };
}

it.each([
  { kept: [0, 2] },
  { kept: [0] },
  { kept: [2] },
])('identifies covered receiver sections around an admitted raster draw hole %j', async ({
  kept,
}) => {
  const f = await fixture(new World(), undefined, 3);
  const draws = f.source.gpuDrivenDraws;
  assert(draws?.length === 3);
  expect(draws.map((draw) => draw.drawItemIndex)).toEqual([0, 1, 2]);
  f.update({ ...f.source, gpuDrivenDraws: draws.filter((_, index) => kept.includes(index)) });
  const input = {
    identity: f.scene,
    slots: f.scene.slotsSnapshot(),
    materials: new MaterialFrame(undefined),
    meshes: new MeshFrame(),
  };
  const rows = new SceneFieldRows();
  const scope = worldRenderResources(f.world);
  const projected = rows
    .update(input, scope, { maxInstances: 4, maxFieldBytes: 1024 * 1024 }, f.assets)
    .unwrap();
  expect(projected.sources).toHaveLength(1);
  const raster = new VisibleSurfaceRows().update(input, 16).unwrap();
  const base = raster.entityBases.get(31);
  assert(base !== undefined);
  for (const section of kept)
    expect(resolveVisibleSurfaceRange(raster, base + section).unwrap()?.firstElement).toBe(
      section * 12,
    );
  // The strict covered-row decoder still rejects an uncovered address.
  expect(resolveVisibleSurfaceRange(raster, base + 1).ok).toBe(false);
  const composition = packGlobalSdfComposition(
    projected.instances,
    {
      origin: [-2, -2, -2],
      dimensions: [5, 5, 5],
      spacing: 1,
      maxDistance: 2,
      coverageDistance: 0.5,
    },
    { capacity: 1, index: false, sourceEpoch: 1 },
  ).unwrap();
  const expected = [
    composition.data.instances.byteLength / 4,
    composition.data.fields.byteLength / 4,
    projected.instances.length,
    1,
  ] as const;
  const result = deriveFieldReceivers({
    raster,
    sources: rows.receiverSources(),
    state: fieldEditState(projected.sources, projected.instances),
    sourceScope: scope,
    owner: { identity: rows, current: () => true },
    acceptedSource: expected,
    placement: {
      instances: projected.instances,
      instanceData: composition.data.instances,
      surface: composition.surface,
    },
  });
  expect(result.ok).toBe(true);
  const frame = result.unwrap();
  assert(frame.state === 'ready');
  for (const section of kept)
    expect(frame.resolve(base + section, 0, expected, rows).unwrap()).toMatchObject({
      state: 'identified',
      primitive: section * 4,
    });
  expect(frame.resolve(base + 1, 0, expected, rows).unwrap()).toMatchObject({
    state: 'unavailable',
  });
});

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
      mesh: describeMeshDraw(f.mesh),
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
    second = await fixture(first.world, first.assets);
  expect(first.source.assetHandle).not.toBe(second.source.assetHandle);
  first.update({
    ...second.source,
    entityKey: second.source.entityKey + 1,
    transform: { world: matrix(20) },
  });
  const result = projectSceneFields(
    first.scene.slotsSnapshot(),
    worldRenderResources(first.world),
    { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
    first.assets,
  ).unwrap();
  expect(result.sources.map((source) => source.scope)).toEqual(
    [first.world, second.world].map(worldRenderResources),
  );
  expect(
    result.sources.map(({ mesh }) => {
      const { attributeStorage, ...fields } = mesh;
      expect(attributeStorage).toBe('interleaved');
      return { ...fields, attributes: meshAttributeChannels(mesh) };
    }),
  ).toEqual([first.mesh, second.mesh]);
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
  f.scene.apply([{ kind: 'remove', entityKey: 31 }]);
  f.update({ ...f.source, entityKey: 44 });
  const next = f.project().unwrap();
  expect(next.sources[0]?.slot).toBe(first.sources[0]?.slot);
  expect(next.sources[0]?.generation).not.toBe(first.sources[0]?.generation);
});

it('names the sampled-visibility producer when a mesh carries a geometric field', async () => {
  const f = await fixture();
  const positions = f.mesh.attributes.position as Float32Array;
  const indices = f.mesh.indices;
  assert(indices);
  const geometric = (await buildMeshDistanceField(positions, indices, { twoSided: true })).unwrap();
  Reflect.set(f.mesh, 'distanceField', { ...geometric, sectionSidedness: [1, 1] });
  f.assets.replace(f.source.assetHandle as AssetHandle<'mesh'>, f.mesh).unwrap();
  const projected = f.project();
  assert(!projected.ok);
  expect(projected.error.code).toBe('ray-reference-invalid');
  expect(String(projected.error.detail?.cause)).toMatch(
    /sampled-visibility.*two-sided field.*buildVisibilityDistanceField/,
  );
});

it('uses explicit complete-roster budgets and counts shared field bytes once', async () => {
  const f = await fixture();
  const field = f.mesh.distanceField;
  assert(field);
  const bytes = admittedFieldBytes(field);
  f.update({ ...f.source, entityKey: 32 });
  const project = (maxInstances: number, maxFieldBytes: number) =>
    projectSceneFields(
      f.scene.slotsSnapshot(),
      worldRenderResources(f.world),
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
  expect(projected.deforming).toEqual([expect.objectContaining({ entityKey: 32 })]);
  const rows = new SceneFieldRows();
  rows
    .update(
      {
        identity: f.scene,
        slots: f.scene.slotsSnapshot(),
        materials: new MaterialFrame(undefined),
        meshes: new MeshFrame(),
      },
      worldRenderResources(f.world),
      { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
      f.assets,
    )
    .unwrap();
  expect([...rows.receiverSources()].map((source) => source.record.entityKey)).toEqual([31]);
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
  const rows = new SceneFieldRows();
  expect(
    rows.update(
      {
        identity: f.scene,
        slots: f.scene.slotsSnapshot(),
        materials: new MaterialFrame(undefined),
        meshes: new MeshFrame(),
      },
      worldRenderResources(f.world),
      { maxInstances: 4, maxFieldBytes: 1024 * 1024 },
      f.assets,
    ).ok,
  ).toBe(false);
  expect([...rows.receiverSources()]).toEqual([]);
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
  const material = MaterialResource.from({
    ...f.source.material.snapshot,
    materialHandle: handle,
    paramSnapshot: { alphaCutoff: 0.5, baseColor: [1, 1, 1, 0.5] },
  });
  f.update({ ...f.source, material, materials: [material, material] });
  const result = f.project().unwrap();
  expect(result.sources[0]?.materials[0]?.payload.parent).toBeUndefined();
  expect(result.sources[0]?.materials[0]?.alphaCoverageOmitted).toBe(true);
  expect(result.sources[0]?.materials[0]?.facts.paramSnapshot?.alphaCutoff).toBe(0.5);
});

it('retains opaque canonical primitives when another actual section has MASK coverage', async () => {
  const f = await fixture();
  const handle = f.assets.create({ ...f.materialAsset, values: { alphaCutoff: 0.5 } }).unwrap();
  const masked = MaterialResource.from({
    ...f.source.material.snapshot,
    materialHandle: handle,
    paramSnapshot: { alphaCutoff: 0.5 },
  });
  // Actual section 0 uses material slot 1; section 1 uses slot 0.
  f.update({ ...f.source, materials: [f.source.material, masked] });
  const projected = f.project().unwrap();
  expect(projected.sources[0]?.materials.map((part) => part.alphaCoverageOmitted)).toEqual([
    true,
    false,
  ]);
  expect(projected.instances[0]?.surfaceCoverage).toMatchObject({
    kind: 'partial',
    opaquePrimitives: new Uint32Array([0xfc0]),
  });
  const packed = packGlobalSdfComposition(
    projected.instances,
    {
      origin: [-2, -2, -2],
      dimensions: [5, 5, 5],
      spacing: 1,
      maxDistance: 2,
      coverageDistance: 0.5,
    },
    { capacity: 1, index: false, sourceEpoch: 1 },
  ).unwrap();
  expect(validateSdfSurfacePoolHeader(new Uint32Array(packed.data.fields.buffer), 0, 1).ok).toBe(
    true,
  );
  const state = fieldEditState(projected.sources, projected.instances);
  const coverage = projected.instances[0]?.surfaceCoverage;
  assert(typeof coverage === 'object');
  coverage.opaquePrimitives[0] = 0x3f;
  expect(diffFieldEdit(state, projected).rematerialized).toHaveLength(1);
});

it('detects same-handle alpha coverage edits without treating ordinary root values as row edits', async () => {
  const f = await fixture();
  const rows = new SceneFieldRows();
  const project = () =>
    rows
      .update(
        {
          identity: f.scene,
          slots: f.scene.slotsSnapshot(),
          materials: new MaterialFrame(undefined),
          meshes: new MeshFrame(),
        },
        worldRenderResources(f.world),
        { maxInstances: 16, maxFieldBytes: 1024 * 1024 },
        f.assets,
      )
      .unwrap();
  const before = project();
  const hardwareIds = new WorldAccelerationGeometryIds();
  const initialHardware = worldAccelerationRoster(before, hardwareIds);
  expect(initialHardware.instances[0]?.surfaceCoverage).toBe('opaque');
  const device = (
    await new RhiNullAdapter({
      rayQuery: {
        maxBlasGeometryCount: 4,
        maxBlasPrimitiveCount: 128,
        maxTlasInstanceCount: 16,
        maxAccelerationStructuresPerShaderStage: 1,
      },
    }).requestDevice()
  ).unwrap();
  const hardware = prepareWorldAcceleration(
    device,
    initialHardware,
    initialHardware.geometries,
  ).unwrap();
  const submit = () => {
    hardware.record(device.createCommandEncoder({}).unwrap()).unwrap();
    hardware.commit();
  };
  submit();
  rows.acceptChanges(rows.revision);
  const state = fieldEditState(before.sources, before.instances);
  f.assets.update(f.materialHandle, { values: { roughness: 0.25 } }).unwrap();
  for (const resource of new Set([f.source.material, ...f.source.materials]))
    resource.adopt({ ...resource.snapshot, paramSnapshot: { roughness: 0.25, alphaCutoff: 0 } });
  const colorOnly = project();
  expect(diffFieldEdit(state, colorOnly).rematerialized).toHaveLength(0);
  f.assets.update(f.materialHandle, { values: { alphaCutoff: 0.5 } }).unwrap();
  for (const resource of new Set([f.source.material, ...f.source.materials]))
    resource.adopt({ ...resource.snapshot, paramSnapshot: { roughness: 0.25, alphaCutoff: 0.5 } });
  const masked = project();
  const maskedHardware = worldAccelerationRoster(masked, hardwareIds);
  expect(maskedHardware.instances[0]?.surfaceCoverage).toBe('unknown');
  expect(maskedHardware.instances[0]?.geometryId).toBe(initialHardware.instances[0]?.geometryId);
  expect(masked.sources[0]?.materials.every((part) => part.alphaCoverageOmitted)).toBe(true);
  expect(diffFieldEdit(state, masked).rematerialized).toHaveLength(1);
  hardware
    .edit(worldAccelerationEdit(diffFieldEdit(state, masked), [], hardwareIds).unwrap())
    .unwrap();
  submit();
  expect(hardware.inspect()).toMatchObject({ blasBuilt: 1, tlasBuilt: 1, settled: true });
  const maskedState = fieldEditState(masked.sources, masked.instances);
  rows.acceptChanges(rows.revision);
  f.assets.update(f.materialHandle, { values: { alphaCutoff: 0 } }).unwrap();
  for (const resource of new Set([f.source.material, ...f.source.materials]))
    resource.adopt({ ...resource.snapshot, paramSnapshot: { roughness: 0.25, alphaCutoff: 0 } });
  const restored = project();
  expect(diffFieldEdit(maskedState, restored).rematerialized).toHaveLength(1);
  const restoredHardware = worldAccelerationRoster(restored, hardwareIds);
  expect(restoredHardware.instances[0]?.surfaceCoverage).toBe('opaque');
  expect(restoredHardware.instances[0]?.geometryId).toBe(initialHardware.instances[0]?.geometryId);
  hardware
    .edit(worldAccelerationEdit(diffFieldEdit(maskedState, restored), [], hardwareIds).unwrap())
    .unwrap();
  submit();
  expect(hardware.inspect()).toMatchObject({
    blasBuilt: 1,
    tlasBuilt: 1,
    settled: true,
    coverageWords: 0,
  });
  hardware.dispose();
});

it('uses accepted withParameters coverage independently for placements sharing the same asset handle', async () => {
  const f = await fixture();
  const masked = f.source.material.withParameters({ alphaCutoff: 0.5 });
  expect(masked.snapshot.materialHandle).toBe(f.source.material.snapshot.materialHandle);
  f.update({ ...f.source, materials: [f.source.material, masked] });
  const projected = f.project().unwrap();
  expect(projected.sources[0]?.materials.map((part) => part.alphaCoverageOmitted)).toEqual([
    true,
    false,
  ]);
  expect(projected.sources[0]?.materials[0]?.facts.paramSnapshot?.alphaCutoff).toBe(0.5);
  expect(projected.instances[0]?.surfaceCoverage).toMatchObject({
    kind: 'partial',
    opaquePrimitives: new Uint32Array([0xfc0]),
  });
});

it('keeps different placement overrides local while sharing the complete canonical Mesh', async () => {
  const f = await fixture();
  const masked = f.source.material.withParameters({ alphaCutoff: 0.5 });
  f.update({ ...f.source, entityKey: 32, materials: [f.source.material, masked] });
  const projected = f.project().unwrap();
  expect(projected.instances).toHaveLength(2);
  expect(projected.instances[0]?.surfaceCoverage).toBe('opaque');
  expect(projected.instances[1]?.surfaceCoverage).toMatchObject({
    kind: 'partial',
    opaquePrimitives: new Uint32Array([0xfc0]),
  });
  expect(projected.instances[0]?.field).toBe(projected.instances[1]?.field);
  expect(projected.instances[0]?.geometryId).toBe(projected.instances[1]?.geometryId);
  const hardware = worldAccelerationRoster(projected, new WorldAccelerationGeometryIds());
  expect(hardware.geometries).toHaveLength(1);
  expect(hardware.instances[0]?.geometryId).toBe(hardware.instances[1]?.geometryId);
  expect(hardware.instances[0]?.surfaceCoverage).toBe('opaque');
  expect(hardware.instances[1]?.surfaceCoverage).toMatchObject({
    kind: 'partial',
    opaquePrimitives: new Uint32Array([0xfc0]),
  });
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
      accepted.resources,
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
  resource.adopt({
    ...resource.snapshot,
    paramSnapshot: { ...resource.snapshot.paramSnapshot, alphaHash: 1 },
  });
  expect(f.project().ok).toBe(false);
  f.assets.update(handle, { values: { alphaHash: 0 } }).unwrap();
  resource.adopt({
    ...resource.snapshot,
    paramSnapshot: { ...resource.snapshot.paramSnapshot, alphaHash: 0 },
  });
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
      received.resources,
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
  const worlds = worldRenderResources(f.world);
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

it.each([128, 1024])('assembles and diffs only 8 changed field sources at N=%i', async (count) => {
  const f = await fixture();
  f.scene.apply(
    Array.from({ length: count }, (_, entityKey) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: { ...f.source, entityKey, transform: { world: matrix(entityKey) } },
    })),
  );
  // The fixture's original source is already in the requested roster.
  const identity = {},
    materials = new MaterialFrame(undefined),
    meshes = new MeshFrame();
  const rows = () => ({ identity, slots: f.scene.slotsSnapshot(), materials, meshes });
  const sourceScope = worldRenderResources(f.world);
  const budget = { maxInstances: 1024, maxFieldBytes: 1024 * 1024 };
  const fields = new SceneFieldRows();
  const cold = fields.update(rows(), sourceScope, budget, f.assets).unwrap();
  expect(cold.sources).toHaveLength(count);
  const state = fieldEditState(cold.sources, cold.instances);
  fields.acceptChanges(fields.revision);
  const enumerate = vi.spyOn(RowProjection.prototype, 'entries');
  const keys = vi.spyOn(state, 'keys');
  f.scene.apply(
    Array.from({ length: 8 }, (_, entityKey) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: { ...f.source, entityKey, transform: { world: matrix(entityKey + 10) } },
    })),
  );
  const visits = fields.visits;
  const changed = fields.changes(rows(), sourceScope, budget, f.assets).unwrap();
  expect(fields.visits - visits).toBe(8);
  expect(changed.sources).toHaveLength(8);
  expect(changed.instances).toHaveLength(8);
  expect(changed.sources[0]?.fieldSnapshot).toBe(cold.sources[0]?.fieldSnapshot);
  const edit = diffFieldEdit(state, changed);
  expect(edit.moved).toHaveLength(8);
  expect(edit.removed).toHaveLength(0);
  adoptFieldEdit(state, edit);
  fields.acceptChanges(fields.revision);
  expect(enumerate).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  enumerate.mockRestore();
  keys.mockRestore();
  expect(fields.changes(rows(), sourceScope, budget, f.assets).unwrap().sources).toHaveLength(0);
  expect(state.size).toBe(count);
});

it('retains deferred source changes through removal, slot reuse and recovery', async () => {
  const f = await fixture();
  const identity = {},
    materials = new MaterialFrame(undefined),
    meshes = new MeshFrame();
  const rows = () => ({ identity, slots: f.scene.slotsSnapshot(), materials, meshes });
  const sourceScope = worldRenderResources(f.world);
  const budget = { maxInstances: 16, maxFieldBytes: 1024 * 1024 };
  const fields = new SceneFieldRows();
  const cold = fields.update(rows(), sourceScope, budget, f.assets).unwrap();
  const state = fieldEditState(cold.sources, cold.instances);
  fields.acceptChanges(fields.revision);
  f.update({ ...f.source, transform: { world: matrix(5) } });
  const deferred = fields.changes(rows(), sourceScope, budget, f.assets).unwrap();
  expect(diffFieldEdit(state, deferred).moved).toHaveLength(1);
  const oldRevision = fields.revision;
  f.scene.apply([{ kind: 'remove', entityKey: f.source.entityKey }]);
  const removed = fields.changes(rows(), sourceScope, budget, f.assets).unwrap();
  fields.acceptChanges(oldRevision);
  expect(diffFieldEdit(state, removed).removed).toHaveLength(1);
  f.update({ ...f.source, transform: { world: matrix(7) } });
  const replaced = fields.changes(rows(), sourceScope, budget, f.assets).unwrap();
  const edit = diffFieldEdit(state, replaced);
  expect(edit.removed).toHaveLength(1);
  expect(edit.added).toHaveLength(1);
  adoptFieldEdit(state, edit, [0]);
  fields.acceptChanges(fields.revision);
  expect(
    diffFieldEdit(state, fields.changes(rows(), sourceScope, budget, f.assets).unwrap()),
  ).toEqual({
    moved: [],
    removed: [],
    added: [],
    rematerialized: [],
  });
  fields.reset();
  const recovered = fields.changes(rows(), sourceScope, budget, f.assets).unwrap();
  expect(recovered.changedSources).toBeUndefined();
  expect(diffFieldEdit(state, recovered).removed).toHaveLength(0);
});

it('keeps incremental placement, binding, mesh and field edits equal to cold projection', async () => {
  const f = await fixture();
  const identity = {},
    materials = new MaterialFrame(undefined),
    meshes = new MeshFrame();
  const rows = () => ({ identity, slots: f.scene.slotsSnapshot(), materials, meshes });
  const sourceScope = worldRenderResources(f.world);
  const budget = { maxInstances: 16, maxFieldBytes: 1024 * 1024 };
  const fields = new SceneFieldRows();
  const cold = fields.update(rows(), sourceScope, budget, f.assets).unwrap();
  const state = fieldEditState(cold.sources, cold.instances);
  fields.acceptChanges(fields.revision);
  let source = f.source;
  const apply = (kind: 'moved' | 'rematerialized' | 'added') => {
    const input = fields.changes(rows(), sourceScope, budget, f.assets).unwrap();
    const edit = diffFieldEdit(state, input);
    expect(edit[kind]).toHaveLength(1);
    if (kind === 'added') expect(edit.removed).toHaveLength(1);
    adoptFieldEdit(state, edit, kind === 'added' ? [0] : []);
    fields.acceptChanges(fields.revision);
    const complete = f.project().unwrap();
    expect(diffFieldEdit(state, complete)).toEqual({
      moved: [],
      removed: [],
      added: [],
      rematerialized: [],
    });
  };
  source = { ...source, transform: { world: matrix(4) } };
  f.update(source);
  apply('moved');
  const resource = new MaterialResource({ ...source.material.snapshot, roughness: 0.25 });
  source = { ...source, material: resource, materials: [resource, resource] };
  f.update(source);
  apply('rematerialized');
  source = { ...source, assetHandle: f.assets.create({ ...f.mesh }).unwrap() };
  f.update(source);
  apply('added');
  assert(source.assetHandle !== undefined);
  f.assets
    .update(source.assetHandle as AssetHandle<'mesh'>, {
      distanceField: structuredClone(
        f.mesh.distanceField as NonNullable<typeof f.mesh.distanceField>,
      ),
    })
    .unwrap();
  apply('added');
});

it.each([
  'placement',
  'instance-budget',
  'byte-budget',
] as const)('preserves the cold %s failure after an accepted field edit', async (failure) => {
  const f = await fixture();
  const field = f.mesh.distanceField;
  assert(field);
  const identity = {},
    materials = new MaterialFrame(undefined),
    meshes = new MeshFrame();
  const rows = () => ({ identity, slots: f.scene.slotsSnapshot(), materials, meshes });
  const sourceScope = worldRenderResources(f.world);
  const budget = {
    maxInstances: 1,
    maxFieldBytes: admittedFieldBytes(field),
  };
  if (failure === 'byte-budget') budget.maxInstances = 2;
  const fields = new SceneFieldRows();
  fields.update(rows(), sourceScope, budget, f.assets).unwrap();
  fields.acceptChanges(fields.revision);
  if (failure === 'placement') {
    const singular = matrix();
    singular[0] = 0;
    f.update({ ...f.source, transform: { world: singular } });
  } else {
    const assetHandle =
      failure === 'byte-budget'
        ? f.assets.create({ ...f.mesh, distanceField: structuredClone(field) }).unwrap()
        : f.source.assetHandle;
    f.update({ ...f.source, entityKey: 32, ...(assetHandle === undefined ? {} : { assetHandle }) });
  }
  const actual = fields.changes(rows(), sourceScope, budget, f.assets);
  const expected = projectSceneFields(f.scene.slotsSnapshot(), sourceScope, budget, f.assets);
  expect(actual.ok).toBe(false);
  expect(actual).toEqual(expected);
});
