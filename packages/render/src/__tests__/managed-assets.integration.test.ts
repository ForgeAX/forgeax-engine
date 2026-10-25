import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createMeshBuilder, createPrimitiveMesh } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import type { Buffer, Result, RhiError } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

describe('managed assets in persistent rendering', () => {
  it('adopts one shared material update with no entity extraction or binding changes', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    registerPropagateTransforms(world);
    const mesh = assets.create(BUILTIN_CUBE).unwrap();
    const material = assets
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 },
      } as const)
      .unwrap();
    world
      .spawn({ component: Transform, data: { pos: [0, 0, 30] } }, { component: Camera, data: {} })
      .unwrap();
    for (let i = 0; i < 256; i++)
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    world.update(0).unwrap();
    const lease = createRenderReadLease(world);
    const device = new RhiNullDevice(
      new RhiNullQueue(),
      (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
    );
    const scene = new PersistentRenderScene({ getDevice: () => device });
    const caches = scene.materialSnapshotCacheStore();
    const owner = { cameraOwner: 0, resourceOwner: 0 };
    let requestedEntities = 0;
    const draw = () =>
      scene.extractComposition(
        [world],
        owner,
        assets,
        (request) => {
          if (typeof request !== 'string' && request.kind === 'partial')
            for (const entities of request.entitiesByWorld)
              requestedEntities += entities?.size ?? 0;
          return extractFrames([world], owner, assets, caches, {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          });
        },
        [lease],
      );
    try {
      draw();
      const first = draw();
      expect(first.renderables).toHaveLength(256);
      const resource = first.renderables.at(0)?.material;
      if (resource === undefined) throw new Error('missing shared material');
      expect(resource).toBeDefined();
      const prior = resource.snapshot;
      expect(prior.roughness).toBe(0.5);
      requestedEntities = 0;
      const retained = scene.compositionRetainedScene();
      expect(retained?.isSourceCurrent()).toBe(true);
      const unrelated = assets.create(BUILTIN_CUBE).unwrap();
      assets
        .writeRange(unrelated, {
          attribute: 'position',
          first: 0,
          values: new Float32Array([10, 10, 10]),
        })
        .unwrap();
      expect(retained?.isSourceCurrent()).toBe(true);
      draw();
      expect(retained?.isCurrent()).toBe(true);
      expect(retained?.isSourceCurrent()).toBe(true);
      assets.update(material, { values: { roughness: 0.2 } }).unwrap();
      expect(retained?.isSourceCurrent()).toBe(false);
      const next = draw();
      expect(retained?.isCurrent()).toBe(false);
      expect(scene.compositionRetainedScene()?.isSourceCurrent()).toBe(true);
      expect(requestedEntities).toBe(0);
      expect(next.renderables).toBe(first.renderables);
      expect(resource.snapshot.roughness).toBe(0.2);
      expect(prior.roughness).toBe(0.5);
      expect(scene.compositionGpuDrivenState()?.structureMetrics?.sceneTableUploadBytes).toBe(16);
      draw();
      expect(scene.compositionGpuDrivenState()?.structureMetrics?.sceneTableUploadBytes).toBe(0);
      const passes: import('@forgeax/engine-types').MaterialPassList = [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 3000 },
        },
        {
          name: 'ShadowCaster',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ];
      assets.update(material, { passes }).unwrap();
      const structural = draw();
      expect(requestedEntities).toBe(0);
      expect(structural.renderables).toBe(first.renderables);
      expect(resource.snapshot.passes).toEqual(passes);
      expect(prior.passes).toHaveLength(1);
      expect(resource.snapshot.materialShaderId).toBe('forgeax::default-unlit');
      expect(structural.dispatch).toHaveLength(512);
      expect(structural.dispatch.filter((pass) => pass.tags.LightMode === 'Forward')).toHaveLength(
        256,
      );
      expect(
        structural.dispatch.filter((pass) => pass.tags.LightMode === 'ShadowCaster'),
      ).toHaveLength(256);
      expect(
        structural.dispatch.every((pass) => pass.materialShaderId === 'forgeax::default-unlit'),
      ).toBe(true);
      expect(
        structural.dispatch
          .filter((pass) => pass.tags.LightMode === 'Forward')
          .every((pass) => pass.queue === 3000),
      ).toBe(true);
      expect(first.dispatch).toHaveLength(256);
      expect(first.dispatch.every((pass) => pass.queue === 2000)).toBe(true);
    } finally {
      scene.dispose();
      lease.dispose();
      assets.dispose();
    }
  });
});

it('fences transitive resource edits and retires dependencies on rebind and removal', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const texture = () =>
    assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      } as const)
      .unwrap();
  const firstTexture = texture(),
    secondTexture = texture();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: { baseColorTexture: { texture: firstTexture } },
    } as const)
    .unwrap();
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 30] } }, { component: Camera, data: {} })
    .unwrap();
  const scene = new PersistentRenderScene();
  const lease = createRenderReadLease(world);
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  let extracted = 0;
  const draw = () => {
    world.update(0).unwrap();
    return scene.extractComposition(
      [world],
      owner,
      assets,
      (request) => {
        if (typeof request !== 'string' && request.kind === 'partial')
          extracted += request.entitiesByWorld.reduce(
            (total, rows) => total + (rows?.size ?? 0),
            0,
          );
        return extractFrames([world], owner, assets, scene.materialSnapshotCacheStore(), {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        });
      },
      [lease],
    );
  };
  try {
    draw();
    const initial = scene.compositionRetainedScene();
    extracted = 0;
    assets.update(firstTexture, { data: new Uint8Array([255, 0, 0, 255]) }).unwrap();
    expect(initial?.isSourceCurrent()).toBe(false);
    draw();
    expect(initial?.isCurrent()).toBe(false);
    expect(extracted).toBe(0);
    assets.update(material, { values: { baseColorTexture: { texture: secondTexture } } }).unwrap();
    draw();
    const rebound = scene.compositionRetainedScene();
    assets.update(firstTexture, { data: new Uint8Array([0, 255, 0, 255]) }).unwrap();
    expect(rebound?.isSourceCurrent()).toBe(true);
    draw();
    expect(rebound?.isCurrent()).toBe(true);
    assets.update(secondTexture, { data: new Uint8Array([0, 0, 255, 255]) }).unwrap();
    expect(rebound?.isSourceCurrent()).toBe(false);
    draw();
    expect(extracted).toBe(0);
    world.despawn(entity).unwrap();
    draw();
    const removed = scene.compositionRetainedScene();
    assets.update(secondTexture, { data: new Uint8Array([255, 0, 0, 255]) }).unwrap();
    expect(removed?.isSourceCurrent()).toBe(true);
    draw();
    expect(removed?.isCurrent()).toBe(true);
    scene.detach(world);
    expect(scene.compositionRetainedScene()).toBeUndefined();
  } finally {
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
});

it('publishes every material program context across native cloning without entity upserts', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const colored = assets
    .create(
      createMeshBuilder({
        ...BUILTIN_CUBE,
        attributes: {
          ...BUILTIN_CUBE.attributes,
          color: new Float32Array(
            ((BUILTIN_CUBE.attributes.position as Float32Array).length / 3) * 4,
          ).fill(1),
        },
      })
        .build()
        .unwrap(),
    )
    .unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { roughness: 0.5 },
    } as const)
    .unwrap();
  const identity = { source: 'managed-assets', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
  const scene = new PersistentRenderScene({ getDevice: () => device, assets: new AssetRegistry() });
  for (let i = 0; i < 256; i++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: i % 2 === 0 ? mesh : colored } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    const frame = scene.consumePublication(accepted);
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return { packet, frame, accepted };
  };
  try {
    const first = publish();
    expect(first.packet.materials).toHaveLength(2);
    expect(first.frame.renderables).toHaveLength(256);
    expect(new Set(first.frame.renderables.map((row) => row.material)).size).toBe(2);
    const resource = first.frame.renderables.at(0)?.material;
    if (resource === undefined) throw new Error('missing shared material');
    const prior = resource.snapshot;
    const retained = scene.compositionRetainedScene();
    expect(retained?.isCurrent()).toBe(true);
    assets.update(material, { values: { roughness: 0.25 } }).unwrap();
    const abandoned = publisher.prepare(0).unwrap();
    expect(abandoned.packet.materials).toHaveLength(2);
    abandoned.discard();
    const retry = publisher.prepare(0).unwrap();
    const invalid = structuredClone(retry.packet);
    const values = invalid.materials as readonly { id: number; value: { roughness: number } }[];
    const invalidMaterial = values[0];
    if (invalidMaterial === undefined) throw new Error('missing published material');
    invalidMaterial.value.roughness = Number.NaN;
    expect(receiver.accept(encodeRenderPublication(invalid)).ok).toBe(false);
    expect(resource.snapshot).toBe(prior);
    retry.discard();
    const next = publish();
    expect(retained?.isCurrent()).toBe(false);
    expect(retained?.isSourceCurrent()).toBe(false);
    expect(scene.compositionRetainedScene()?.isSourceCurrent()).toBe(true);
    expect(next.packet.upserts).toHaveLength(0);
    expect(next.packet.templates).toHaveLength(0);
    expect(next.packet.materials).toHaveLength(2);
    expect(next.accepted.operations).toHaveLength(0);
    expect(resource.snapshot.roughness).toBe(0.25);
    expect(next.frame.renderables.every((row) => row.material.snapshot.roughness === 0.25)).toBe(
      true,
    );
    expect(prior.roughness).toBe(0.5);
    expect(scene.compositionGpuDrivenState()?.structureMetrics?.sceneTableUploadBytes).toBe(32);
    const idle = publish();
    expect(idle.packet.materials).toHaveLength(0);
    expect(idle.packet.assets).toHaveLength(0);
    for (const vertexColor of [true, false]) {
      assets
        .update(mesh, {
          attributes: {
            ...BUILTIN_CUBE.attributes,
            ...(vertexColor
              ? { color: assets.read(colored).unwrap().attributes.color as Float32Array }
              : {}),
          },
        })
        .unwrap();
      const layout = publish();
      expect(layout.packet.upserts).toHaveLength(0);
      const state = scene.compositionGpuDrivenState();
      if (state === undefined) throw new Error('missing accepted GPU composition');
      for (const slot of state.slots) {
        const expected = slot.snapshot.assetHandle === colored || vertexColor;
        const selected = state.drawSnapshotAt?.(slot.slot);
        expect(selected?.material.snapshot.materialContext).toEqual({
          geometry: 'mesh',
          vertexColor: expected,
        });
      }
    }
    const passes: import('@forgeax/engine-types').MaterialPassList = [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 3000 },
      },
    ];
    assets.update(material, { passes }).unwrap();
    const structural = publish();
    expect(structural.packet.upserts).toHaveLength(0);
    expect(structural.packet.templates).toHaveLength(0);
    expect(structural.packet.materials).toHaveLength(2);
    expect(structural.accepted.operations).toHaveLength(0);
    expect(resource.snapshot.passes).toEqual(passes);
    expect(resource.snapshot.materialShaderId).toBe('forgeax::default-unlit');
    expect(structural.frame.dispatch).toHaveLength(256);
    expect(structural.frame.dispatch.every((pass) => pass.queue === 3000)).toBe(true);
    expect(
      structural.frame.dispatch.every((pass) => pass.materialShaderId === 'forgeax::default-unlit'),
    ).toBe(true);
  } finally {
    scene.dispose();
    receiver.dispose();
    publisher.dispose();
    assets.dispose();
  }
});

class MaterialResizeQueue extends RhiNullQueue {
  readonly bytes = new Map<Buffer, Uint8Array>();
  readonly writes: { buffer: Buffer; offset: number; length: number }[] = [];
  override writeBuffer(
    buffer: Buffer,
    offset: number,
    input: ArrayBuffer | ArrayBufferView,
  ): Result<void, RhiError> {
    const result = super.writeBuffer(buffer, offset, input);
    if (!result.ok) return result;
    const source =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const previous = this.bytes.get(buffer);
    const bytes = new Uint8Array(Math.max(previous?.byteLength ?? 0, offset + source.byteLength));
    if (previous !== undefined) bytes.set(previous);
    bytes.set(source, offset);
    this.bytes.set(buffer, bytes);
    this.writes.push({ buffer, offset, length: source.byteLength });
    return result;
  }
}

it('grows one shared material through a stable GPU descriptor without rewriting its consumers', () => {
  const queue = new MaterialResizeQueue();
  const device = new RhiNullDevice(
    queue,
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const admitted = GpuScene.create(device, 256).unwrap();
  if (admitted.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = admitted.scene;
  const projection = new RenderScene();
  const initial: MaterialSnapshot = {
    passes: [],
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialShaderId: 'test::editable',
    materialParamSchema: [{ name: 'tint', type: 'color' }],
    paramSnapshot: { tint: [1, 0, 0, 1] },
  };
  const material = new MaterialResource(initial);
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const snapshots: RenderableSnapshot[] = Array.from({ length: 128 }, (_, entityKey) => ({
    worldId: 0,
    entityKey,
    assetHandle: 1,
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    transform: { world },
  }));
  try {
    scene
      .sync(
        projection.apply(
          snapshots.map((snapshot) => ({
            kind: 'update' as const,
            worldId: snapshot.worldId,
            entityKey: snapshot.entityKey,
            snapshot,
          })),
        ),
      )
      .unwrap();
    const descriptor = scene.materialIndexForSlot(0, 0);
    if (descriptor === undefined) throw new Error('missing descriptor');
    const inputBuffer = () => {
      const reads = scene.inputs.capture();
      try {
        return reads.buffer().unwrap().buffer;
      } finally {
        reads.release();
      }
    };
    const metadata = () => queue.bytes.get(inputBuffer()) ?? new Uint8Array();
    const address = () => new DataView(metadata().buffer).getUint32(descriptor * 4, true);
    expect(queue.writes.filter((write) => write.buffer === scene.materialBuffer)).toEqual([
      { buffer: scene.materialBuffer, offset: address() * 16, length: 16 },
    ]);
    const allocationRevision = scene.allocationRevision;
    const primitiveIndices = snapshots.map((_, slot) => scene.primitiveIndexForSlot(slot));
    queue.writes.length = 0;
    material.adopt({
      ...initial,
      materialParamSchema: [
        ...(initial.materialParamSchema ?? []),
        { name: 'roughness', type: 'f32' },
      ],
      paramSnapshot: { tint: [0, 1, 0, 1], roughness: 0.25 },
    });
    const delta = { ...projection.apply([]), materialUpdates: [material] };
    scene.sync(delta).unwrap();
    expect(scene.allocationRevision).toBe(allocationRevision);
    expect(snapshots.map((_, slot) => scene.primitiveIndexForSlot(slot))).toEqual(primitiveIndices);
    expect(new Set(snapshots.map((_, slot) => scene.materialIndexForSlot(slot, 0)))).toEqual(
      new Set([descriptor]),
    );
    const inputs = inputBuffer();
    expect(queue.writes.filter((write) => write.buffer === scene.primitiveBuffer)).toEqual([]);
    // Payload growth reuses the same start and displacement; descriptor bytes stay unchanged.
    expect(queue.writes.filter((write) => write.buffer === inputs)).toEqual([]);
    // Growth initializes the complete new capacity before the accepted payload upload.
    const materialWrites = queue.writes
      .filter((write) => write.buffer === scene.materialBuffer)
      .map(({ offset, length }) => ({ offset, length }));
    expect(materialWrites, JSON.stringify(materialWrites)).toEqual([
      { offset: 0, length: 32 },
      { offset: address() * 16, length: 32 },
    ]);
    expect(
      queue.writes.every(
        (write) => write.buffer === scene.materialBuffer || write.buffer === inputs,
      ),
    ).toBe(true);
    const values = queue.bytes.get(scene.materialBuffer);
    if (values === undefined) throw new Error('missing uploaded values');
    expect(new DataView(values.buffer).getFloat32(address() * 16 + 16, true)).toBe(0.25);
    queue.writes.length = 0;
    scene.sync(projection.apply([])).unwrap();
    expect(queue.writes).toHaveLength(0);
  } finally {
    scene.dispose();
  }
});
