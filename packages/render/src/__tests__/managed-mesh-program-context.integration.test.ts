import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { createMaterialArtifactDigest, createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin, skeletonContribution } from '@forgeax/engine-skinning';
import type { MaterialAsset, MaterialProgramAbi, MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  MATERIAL_CONTEXT,
  materialRecordFixture,
} from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { loadMaterialFixture } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { MeshFilter, MeshRenderer } from '../components';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { extractFrames } from '../render-system-extract-tail';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import { PersistentRenderScene } from '../scene/render-scene';

async function material(assets: AssetRegistry, id: number) {
  const initial = materialRecordFixture({
    guid: `019f0000-0000-7000-8000-000000000${id}`,
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.5 },
  });
  const programs = (['mesh', 'skinned'] as const).flatMap((geometry) =>
    [false, true].map((color) => {
      const bytes = new TextEncoder().encode(`program ${id} ${geometry} ${color}`);
      const digest = createMaterialArtifactDigest(bytes);
      const inputs: MaterialProgramAbi['vertexInputs'] = [
        ...(color
          ? [{ semantic: 'color' as const, location: 13, format: 'float32x4' as const }]
          : []),
        ...(geometry === 'skinned'
          ? [
              { semantic: 'skinIndex' as const, location: 4, format: 'uint32x4' as const },
              { semantic: 'skinWeight' as const, location: 5, format: 'float32x4' as const },
            ]
          : []),
      ];
      const abi: MaterialProgramAbi = {
        directEntry: 'vs_main',
        sceneIndexEntry: 'vs_scene_index',
        materialRow: { byteLength: 16, fields: [], addressUnitBytes: 16 },
        resourceSlots: [],
        uvSets: [],
        vertexInputs: inputs,
        alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
        reflection: { layoutIdentity: 'layout', resourceSlots: [], vertexInputs: inputs },
        receiptIdentity: `${geometry}:${color}`,
        generation: 1,
      };
      return {
        specializationKey: `program/${digest}`,
        artifact: { mediaType: 'text/wgsl' as const, path: `${digest}.wgsl`, bytes, digest },
        selections: (['direct', 'scene-index'] as const).map((address) => ({
          pass: 'Forward',
          context: { ...MATERIAL_CONTEXT, geometry },
          address,
          entry: address === 'direct' ? abi.directEntry : 'vs_scene_index',
          abi,
        })),
      };
    }),
  );
  const artifactDigest = createMaterialProgramSetDigest(programs, initial.resolved.passes);
  const record = {
    ...initial,
    programs,
    artifactDigest,
    receipt: { ...initial.receipt, identity: { ...initial.receipt.identity, artifactDigest } },
  };
  return (await loadMaterialFixture(assets, record)).unwrap().handle;
}

it.each([
  false,
  true,
])('prepares shared Mesh defaults and overrides by geometry and changed vertex layout (worker=%s)', async (worker) => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(skeletonContribution.kind, skeletonContribution.decoder);
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const first = await material(assets, 811),
    second = await material(assets, 812);
  const attributes = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const source: MeshAsset = {
    kind: 'mesh',
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    indices: new Uint16Array([0, 1, 2]),
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    materialSlots: [{ slotName: 'body', defaultMaterial: first }],
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
  };
  const mesh = assets.create(source).unwrap();
  const skeleton = assets
    .create({ kind: 'skeleton', jointCount: 1, inverseBindMatrices: mat4.identity(mat4.create()) })
    .unwrap();
  const joint = world.spawn({ component: Transform, data: {} }).unwrap();
  for (let i = 0; i < 128; i++) {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: i % 4 >= 2 ? [first] : [] } },
      )
      .unwrap();
    if (i % 2)
      world.addComponent(entity, { component: Skin, data: { skeleton, joints: [joint] } }).unwrap();
  }
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore(MATERIAL_CONTEXT);
  const lease = createRenderReadLease(world);
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const identity = { source: 'mesh-context', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, {
    ...device.caps,
    storageBuffer: true,
  });
  const receiver = new RenderPublicationReceiver(identity);
  let extracted = 0;
  let publishedPrograms = 0;
  let publishedProjections = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (worker) {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      if (packet.baseline) {
        const malformed = structuredClone(packet);
        const projection = malformed.assets.find(
          (row) => row.materialProjection != null,
        )?.materialProjection;
        if (projection === undefined || projection === null)
          throw new Error('Missing projection publication');
        const program = projection.passes[0]?.programs[0];
        if (program === undefined) throw new Error('Missing projection program');
        Object.assign(program, { specializationKey: 'missing-program' });
        expect(receiver.accept(encodeRenderPublication(malformed), assets).ok).toBe(false);
      }
      candidate.accept();
      extracted += packet.upserts.length;
      publishedPrograms = packet.programs.length;
      publishedProjections = packet.assets.filter(
        (row) => row.materialProjection !== undefined,
      ).length;
      const accepted = receiver.accept(encodeRenderPublication(packet), assets).unwrap();
      for (const patch of packet.assetPatches) {
        const payload = accepted.resources.resolveAsset<MaterialAsset>(patch.handle).unwrap();
        if (payload.kind === 'material')
          expect(assets.getMaterialProjectionForPayload(payload)).toBeDefined();
      }
      const result = scene.consumePublication(accepted);
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
      return result;
    }
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) => {
        if (request === 'full') extracted += 128;
        else if (typeof request === 'object')
          for (const entities of request.entitiesByWorld) extracted += entities?.size ?? 0;
        return extractFrames([world], 0, assets, caches, {
          materialContext: MATERIAL_CONTEXT,
          cull: 'none',
          renderables: request,
        });
      },
      [lease],
    );
  };
  const facts = (frame: ReturnType<typeof draw>) =>
    frame.renderables.map((row) => ({
      skin: row.skinBinding !== undefined,
      override: row.materialOverrides?.[0] !== undefined,
      program: row.material.snapshot.materialPublication?.programs[0],
    }));
  try {
    const initial = draw();
    expect(initial.renderables).toHaveLength(128);
    expect(facts(initial).filter((row) => row.skin)).toHaveLength(64);
    expect(
      facts(initial).every(
        (row) => row.program?.context.geometry === (row.skin ? 'skinned' : 'mesh'),
      ),
    ).toBe(true);
    const before = scene.shadowCasterProjection();
    if (before === undefined) throw new Error('Missing fixed frame');
    const oldKeys = initial.renderables.map((row) => row.material.snapshot.materialShaderId);
    const count = extracted;
    const colored = { ...attributes, color: new Float32Array(12).fill(1) };
    assets
      .update(mesh, {
        attributes: colored,
        vertices: packInterleavedVertexAttributes(colored, 3).unwrap().vertices,
        materialSlots: [{ slotName: 'body', defaultMaterial: second }],
      })
      .unwrap();
    const updated = draw();
    expect(extracted).toBe(count);
    expect(updated.renderables).toHaveLength(128);
    expect(
      facts(updated).every(
        (row) => row.program?.context.geometry === (row.skin ? 'skinned' : 'mesh'),
      ),
    ).toBe(true);
    for (const [i, row] of updated.renderables.entries()) {
      expect(row.material.snapshot.materialShaderId).not.toBe(oldKeys[i]);
      expect(row.material.snapshot.materialHandle).toBe(
        row.materialOverrides?.[0] === undefined ? second : first,
      );
    }
    expect(
      before.renderables
        .map((row) => meshDrawSnapshot(row, before.content.meshes).material)
        .map((resource) => before.content.materials.get(resource)?.snapshot.materialShaderId),
    ).toEqual(oldKeys);
    const resources = new Set(updated.renderables.map((row) => row.material));
    expect(resources.size).toBe(4);
    assets.update(first, { values: { roughness: 0.8 } }).unwrap();
    const edited = draw();
    expect(extracted).toBe(count);
    expect(
      edited.renderables
        .filter((row) => row.materialOverrides?.[0] !== undefined)
        .every((row) => row.material.snapshot.roughness === 0.8),
    ).toBe(true);
    if (worker) {
      expect(publishedPrograms).toBe(0);
      expect(publishedProjections).toBe(0);
    }
  } finally {
    publisher.dispose();
    receiver.dispose();
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
});

it.each([
  'asset',
  'world',
] as const)('rejects a cross-source %s mutation before publishing queried Pass facts', async (mutation) => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const first = await material(assets, 913),
    second = await material(assets, 914);
  const cube = createPrimitiveMesh('cube').unwrap();
  const makeMesh = (handle: typeof first): MeshAsset => ({
    ...cube,
    materialSlots: [{ slotName: 'body', defaultMaterial: handle }],
  });
  const firstMesh = assets.create(makeMesh(first)).unwrap();
  const secondMesh = assets.create(makeMesh(second)).unwrap();
  let firstEntity: import('@forgeax/engine-ecs').EntityHandle | undefined;
  for (const assetHandle of [firstMesh, secondMesh]) {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    firstEntity ??= entity;
  }
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const scene = new PersistentRenderScene({ assets, getDevice: () => device });
  const caches = scene.materialSnapshotCacheStore(MATERIAL_CONTEXT);
  const lease = createRenderReadLease(world);
  const draw = () => {
    world.update(0).unwrap();
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) =>
        extractFrames([world], 0, assets, caches, {
          materialContext: MATERIAL_CONTEXT,
          cull: 'none',
          renderables: request,
        }),
      [lease],
    );
  };
  const native = scene.shared as unknown as {
    prepareMeshMaterial: (
      scope: import('../publication/resource-scope').RenderResourceScope | undefined,
      handle: number,
      geometry: import('../scene/mesh-materials').MeshMaterialGeometry,
      vertexColor: boolean,
      assets?: AssetRegistry,
    ) => import('../material-resource').MaterialResource;
  };
  const original = native.prepareMeshMaterial.bind(scene.shared);
  try {
    draw();
    const before = scene.shadowCasterProjection();
    if (before === undefined) throw Error('Missing accepted scene');
    const old = [...before.dispatch];
    const oldResource = before.renderables.at(0)?.material;
    if (oldResource === undefined) throw Error('Missing first material');
    let firstSeen = false,
      mutated = false;
    native.prepareMeshMaterial = (...args) => {
      const resource = original(...args);
      if (args[1] === first) firstSeen = true;
      if (args[1] === second && firstSeen && !mutated) {
        mutated = true;
        if (mutation === 'asset') assets.update(first, { values: { roughness: 0.125 } }).unwrap();
        else {
          if (firstEntity === undefined) throw Error('Missing entity');
          world.set(firstEntity, Transform, { pos: [3, 0, 0] }).unwrap();
        }
      }
      return resource;
    };
    assets
      .update(firstMesh, { materialSlots: [{ slotName: 'body', defaultMaterial: first }] })
      .unwrap();
    expect(draw).toThrow(
      mutation === 'asset'
        ? /Scene assets changed during Pass query/
        : /Scene source changed during Pass query/,
    );
    expect(mutated).toBe(true);
    expect(scene.shadowCasterProjection()).toBe(before);
    expect([...before.dispatch]).toEqual(old);
    expect(before.content.materials.get(oldResource)?.snapshot.roughness).toBe(0.5);
    native.prepareMeshMaterial = original;
    const recovered = draw();
    expect(recovered.renderables).toHaveLength(2);
    expect(
      scene.shadowCasterProjection()?.content.materials.get(oldResource)?.snapshot.roughness,
    ).toBe(mutation === 'asset' ? 0.125 : 0.5);
    expect(before.content.materials.get(oldResource)?.snapshot.roughness).toBe(0.5);
  } finally {
    native.prepareMeshMaterial = original;
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
});
