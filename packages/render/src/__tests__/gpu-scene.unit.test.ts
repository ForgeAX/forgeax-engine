import {
  AssetRegistry,
  HANDLE_CUBE,
  HANDLE_SPHERE,
  RuntimeMaterialValue,
} from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { type Buffer, type Result, RhiError } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import {
  Mobility,
  MobilityKindValue,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import {
  createStandardPbrArtifactReceipt,
  DEFAULT_SPRITE_PARAM_SCHEMA,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import * as materialTypes from '@forgeax/engine-types';
import { derive, err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, MotionBlur } from '../components';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { ShadowCasterClassifier } from '../gpu-driven/shadow-caster-classes';
import {
  GPU_SCENE_PRIMITIVE_MOTION_INVALID,
  GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE,
  GPU_SCENE_PRIMITIVE_REACTIVE,
  GpuScene,
} from '../gpu-scene';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { packMaterialProgramRow, packStandardPbrMaterialRow } from '../material-row';
import { Materials } from '../materials';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type {
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { classifySceneDataCoverage } from '../temporal/coverage';

interface WriteRecord {
  readonly buffer: Buffer;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class RecordingQueue extends RhiNullQueue {
  readonly writes: WriteRecord[] = [];
  readonly resident = new Map<Buffer, Uint8Array>();

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiError> {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const start = dataOffset ?? 0;
    const length = size ?? source.byteLength - start;
    this.writes.push({
      buffer,
      offset: bufferOffset,
      bytes: source.slice(start, start + length),
    });
    const result = super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
    if (result.ok) {
      const previous = this.resident.get(buffer);
      const bytes = new Uint8Array(Math.max(previous?.byteLength ?? 0, bufferOffset + length));
      if (previous !== undefined) bytes.set(previous);
      bytes.set(source.subarray(start, start + length), bufferOffset);
      this.resident.set(buffer, bytes);
    }
    return result;
  }
}

class FailingQueue extends RecordingQueue {
  failWrites = false;

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiError> {
    if (this.failWrites) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'temporal transform upload succeeds',
          hint: 'retry after the queue recovers',
        }),
      );
    }
    return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
  }
}

const material = {
  baseColor: new Float32Array([0.25, 0.5, 0.75]),
  metallic: 0.2,
  roughness: 0.8,
  materialHandle: 17,
} as MaterialSnapshot;

function snapshot(entityKey: number, translationX = 0): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 9,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function updateInstances(value: RenderableSnapshot) {
  if (value.instances === undefined) throw new Error('expected Instances payload');
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    instances: value.instances,
  };
}

function instanceSnapshot(entityKey: number, translationX: number): RenderableSnapshot {
  const base = snapshot(entityKey);
  const transforms = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translationX, 0, 0, 1]);
  return {
    ...base,
    instances: {
      transforms,
      instanceCount: 1,
      cacheKey: entityKey,
      archVersion: 0,
      revision: translationX + 1,
    },
  };
}

function multiInstanceSnapshot(
  entityKey: number,
  translations: readonly number[],
  generations: readonly number[],
): RenderableSnapshot {
  const base = snapshot(entityKey);
  const transforms = new Float32Array(translations.length * 16);
  for (let ordinal = 0; ordinal < translations.length; ordinal += 1) {
    const offset = ordinal * 16;
    transforms[offset] = 1;
    transforms[offset + 5] = 1;
    transforms[offset + 10] = 1;
    transforms[offset + 12] = translations[ordinal] ?? 0;
    transforms[offset + 15] = 1;
  }
  return {
    ...base,
    instances: {
      transforms,
      generations: new Uint32Array(generations),
      instanceCount: translations.length,
      cacheKey: entityKey,
      archVersion: 1,
      revision: 1,
    },
  };
}

function persistentFrame(
  renderables: readonly RenderableSnapshot[],
  cameras: ExtractedFrame['cameras'] = [],
): ExtractedFrame {
  return {
    cameras,
    auxiliaryCameras: [],
    cubeCameras: [],
    lights: { directional: undefined, directionalCount: 0, point: [], spot: [] },
    environment: undefined,
    environmentReady: true,
    renderables,
    dispatch: [],
    shadowCasterEntityKeys: new Set<number>(),
    shadowCasterDrawKeys: new Set<string>(),
    skylight: undefined,
    skylightCount: 0,
    skybox: undefined,
    skyboxCount: 0,
    fog: undefined,
    frustumStats: { culled: 0, total: renderables.length },
    visibilityStats: { explicitlyHidden: 0 },
    postProcessParams: new Map(),
    visibilitySnapshots: [],
    featureVisibilitySnapshots: [],
    hiddenEntityReports: [],
  } as unknown as ExtractedFrame;
}

function createDevice(queue: RecordingQueue): RhiNullDevice {
  return new RhiNullDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

describe('GpuScene', () => {
  it('uploads changed material row bytes while retaining draw preparation', () => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const created = GpuScene.create(device, 4).unwrap();
    if (created.status !== 'available') throw new Error('expected GPU scene');
    const projection = new RenderScene();
    const source: RenderableSnapshot = {
      ...snapshot(0),
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: 36,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'pbr',
          materialResourceClass: '',
        },
      ],
    };
    created.scene.sync(projection.apply([updateSnapshot(source)])).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const plan = topology.plan();
    expect(plan.candidateCount).toBe(1);
    queue.writes.length = 0;
    const changedMaterial = {
      ...material,
      baseColor: new Float32Array([0.75, 0.25, 0.5]),
      roughness: 0.3,
    } as MaterialSnapshot;
    const delta = projection.apply([
      updateSnapshot({ ...source, material: changedMaterial, materials: [changedMaterial] }),
    ]);
    expect(topology.apply(delta)).toBe(false);
    expect(topology.plan()).toBe(plan);
    created.scene.sync(delta).unwrap();
    const writes = queue.writes.filter((write) => write.buffer === created.scene.materialBuffer);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.bytes).toEqual(
      packStandardPbrMaterialRow(createStandardPbrArtifactReceipt(), changedMaterial).subarray(
        0,
        32,
      ),
    );
    created.scene.dispose();
  });

  it('uploads immutable material runtime values without a Catalog epoch change', () => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const world = new World();
    registerPropagateTransforms(world);
    const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    const freeze = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    const source = Materials.standard({
      baseColor: [1, 1, 1, 1],
      subsurfaceRadius: [9, 6, 3],
      subsurfaceWeight: 1,
    });
    freeze(source);
    const handle = world.allocSharedRef('MaterialAsset', source);
    const entities = [0, 2].map((x) =>
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [handle] } },
        )
        .unwrap(),
    );
    world
      .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {} })
      .unwrap();
    world.update(0).unwrap();
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene({ getDevice: () => device });
    const draw = () =>
      persistent.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets.catalogEpoch,
        (request) =>
          extractFrames([world], 0, assets, undefined, persistent.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          }),
        [lease],
      );
    try {
      const first = draw();
      const firstMaterial = first.renderables.find(
        (row) => row.entityKey === entities[0],
      )?.material;
      if (firstMaterial?.materialParamSchema === undefined)
        throw new Error('expected numeric material schema');
      expect(persistent.materialSnapshotCacheStore().get(world)?.get(handle)?.crossFrameSafe).toBe(
        true,
      );
      const radiusField = derive(firstMaterial.materialParamSchema).numericMembers.find(
        (field) => field.name === 'subsurfaceRadius',
      );
      if (radiusField === undefined) throw new Error('expected radius layout');
      const epoch = assets.catalogEpoch;
      // Establish the ordinary frozen source cache before adding runtime content.
      const radius = world
        .spawn({
          component: RuntimeMaterialValue,
          data: { asset: handle, parameter: 'subsurfaceRadius', kind: 2, value: [0, 0, 0] },
        })
        .unwrap();
      const weight = world
        .spawn({
          component: RuntimeMaterialValue,
          data: { asset: handle, parameter: 'subsurfaceWeight', kind: 0, value: [1] },
        })
        .unwrap();
      for (const r of [0, 3, 6, 12]) {
        queue.writes.length = 0;
        world.set(radius, RuntimeMaterialValue, { value: [r, (r * 2) / 3, r / 3] }).unwrap();
        world.update(0).unwrap();
        const frame = draw();
        const rows = frame.renderables.filter((row) =>
          entities.includes(row.entityKey as (typeof entities)[number]),
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.material.paramSnapshot?.subsurfaceRadius).toEqual([r, (r * 2) / 3, r / 3]);
          expect(row.material.materialProgramKeys).toEqual(firstMaterial.materialProgramKeys);
        }
        const state = persistent.compositionGpuDrivenState();
        if (state === undefined) throw new Error('expected GPU material consumer');
        const writes = queue.writes.filter((write) => write.buffer === state.scene.materialBuffer);
        expect(writes.length).toBeGreaterThan(0);
        const resident = queue.resident.get(state.scene.materialBuffer);
        if (resident === undefined) throw new Error('expected resident material bytes');
        for (const slot of [0, 1]) {
          const address = state.scene.materialIndexForSlot(slot, 0);
          if (address === undefined) throw new Error('expected material address');
          const view = new DataView(resident.buffer, address * 16);
          expect(
            [0, 1, 2].map((lane) => view.getFloat32(radiusField.offset + lane * 4, true)),
          ).toEqual([r, (r * 2) / 3, r / 3]);
        }
        expect(assets.catalogEpoch).toBe(epoch);
      }
      world.set(weight, RuntimeMaterialValue, { value: [0] }).unwrap();
      world.update(0).unwrap();
      expect(
        draw().renderables.every((row) => row.material.paramSnapshot?.subsurfaceWeight === 0),
      ).toBe(true);
      world.despawn(radius).unwrap();
      world.despawn(weight).unwrap();
      world.update(0).unwrap();
      const restored = draw();
      expect(
        restored.renderables.every(
          (row) => JSON.stringify(row.material.paramSnapshot?.subsurfaceRadius) === '[9,6,3]',
        ),
      ).toBe(true);
      expect(
        restored.renderables.every((row) => row.material.paramSnapshot?.subsurfaceWeight === 1),
      ).toBe(true);
      expect(assets.catalogEpoch).toBe(epoch);
    } finally {
      lease.dispose();
      persistent.dispose();
    }
  });

  it('observes World-owned material values written by a separately bundled Worker plugin', () => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const world = new World();
    registerPropagateTransforms(world);
    const workerMaterialValue = defineComponent('RuntimeMaterialValue', {
      asset: 'shared<MaterialAsset>',
      parameter: 'string',
      kind: { type: 'enum', labels: { number: 0, boolean: 1, vector: 2 }, default: 0 },
      value: 'array<f32>',
    }) as typeof RuntimeMaterialValue;
    world.components.register(workerMaterialValue).unwrap();
    const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      subsurfaceRadius: [9, 6, 3],
      subsurfaceWeight: 1,
    });
    const handle = world.allocSharedRef('MaterialAsset', material);
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: { materials: [handle] } },
      )
      .unwrap();
    world
      .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {} })
      .unwrap();
    world.update(0).unwrap();
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene({ getDevice: () => device });
    const draw = () =>
      persistent.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets.catalogEpoch,
        (request) =>
          extractFrames([world], 0, assets, undefined, persistent.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          }),
        [lease],
      );
    try {
      expect(
        draw().renderables.find((row) => row.entityKey === entity)?.material.paramSnapshot
          ?.subsurfaceRadius,
      ).toEqual([9, 6, 3]);
      const radius = world
        .spawn({
          component: workerMaterialValue,
          data: {
            asset: handle,
            parameter: 'subsurfaceRadius',
            kind: 2,
            value: [0, 0, 0],
          },
        })
        .unwrap();
      world.update(0).unwrap();
      expect(
        draw().renderables.find((row) => row.entityKey === entity)?.material.paramSnapshot
          ?.subsurfaceRadius,
      ).toEqual([0, 0, 0]);
      world.set(radius, workerMaterialValue, { value: [3, 2, 1] }).unwrap();
      world.update(0).unwrap();
      expect(
        draw().renderables.find((row) => row.entityKey === entity)?.material.paramSnapshot
          ?.subsurfaceRadius,
      ).toEqual([3, 2, 1]);
    } finally {
      lease.dispose();
      persistent.dispose();
    }
  });

  it('keeps renderer-owned tables resident across World detach and reattach', () => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const persistent = new PersistentRenderScene({ getDevice: () => device });
    const firstWorld = new World();
    const firstLease = createRenderReadLease(firstWorld);

    persistent.extractComposition(
      [firstWorld],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => persistentFrame([snapshot(1), snapshot(3)]),
      [firstLease],
    );
    const first = persistent.compositionGpuDrivenState();
    expect(first).toBeDefined();
    if (first === undefined) return;
    for (const slot of first.slots) {
      expect(first.slotForEntity?.(slot.snapshot.worldId, slot.snapshot.entityKey)).toBe(slot);
    }

    persistent.detach(firstWorld);
    firstLease.dispose();
    const secondWorld = new World();
    const secondLease = createRenderReadLease(secondWorld);
    persistent.extractComposition(
      [secondWorld],
      { cameraOwner: 0, resourceOwner: 0 },
      1,
      () => persistentFrame([snapshot(2)]),
      [secondLease],
    );
    const second = persistent.compositionGpuDrivenState();
    expect(second).toBeDefined();
    expect(second?.scene).toBe(first.scene);
    for (const slot of second?.slots ?? []) {
      expect(second?.slotForEntity?.(slot.snapshot.worldId, slot.snapshot.entityKey)).toBe(slot);
    }
    expect(second?.scene.materialIndexForSlot(1, 0)).toBeUndefined();

    secondLease.dispose();
    persistent.dispose();
  });

  it('uses the admitted program layout for fresh transported material values', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const schema = [{ name: 'roughness', type: 'f32' as const }];
    registry.installMaterialArtifact('game::row', { source: '', paramSchema: schema });
    const replacementSchema = [{ name: 'padding', type: 'vec4' as const }, ...schema];
    registry.installMaterialArtifact('game::replacement-row', {
      source: '',
      paramSchema: replacementSchema,
    });
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 8, registry).unwrap();
    if (created.status !== 'available') throw new Error('Expected GPU Scene');
    const scene = created.scene;
    const projection = new RenderScene();
    const events: string[] = [];
    const observer = {
      enabled: true,
      observe: (event: { kind: string }) => events.push(event.kind),
    };
    const derive = vi
      .spyOn(materialTypes, 'derive')
      .mockImplementation((schema) =>
        materialTypes.deriveObserved(schema, observer, 'gpu-scene-test'),
      );
    try {
      for (const [shaderId, parameters, roughness, offset] of [
        ['game::row', schema, 0.25, 0],
        ['game::row', schema, 0.75, 0],
        ['game::replacement-row', replacementSchema, 0.5, 16],
      ] as const) {
        const transported = structuredClone({
          ...material,
          materialShaderId: shaderId,
          materialParamSchema: parameters,
          paramSnapshot: { roughness },
        });
        const source = { ...snapshot(1), material: transported, materials: [transported] };
        queue.writes.length = 0;
        scene.sync(projection.apply([updateSnapshot(source)])).unwrap();
        const upload = queue.writes.find((write) => write.buffer === scene.materialBuffer);
        if (upload === undefined) throw new Error('Expected changed material upload');
        const address = scene.materialIndexForSlot(
          projection.slotsSnapshot()[0]?.slot ??
            (() => {
              throw new Error('expected retained slot');
            })(),
          0,
        );
        const resident = queue.resident.get(scene.materialBuffer);
        if (address === undefined || resident === undefined)
          throw new Error('Expected resident material');
        expect(new DataView(resident.buffer).getFloat32(address * 16 + offset, true)).toBe(
          roughness,
        );
      }
      expect(events).toContain('admitted-identity-hit');
      expect(events).not.toContain('fallback-layout-sha');
    } finally {
      derive.mockRestore();
      scene.dispose();
    }
  });

  it('preserves transported Sprite rows when the registry has no parameter layout', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    registry.installMaterialArtifact('forgeax::sprite', { source: '', paramSchema: [] });
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 8, registry).unwrap();
    if (created.status !== 'available') throw new Error('Expected GPU Scene');
    const scene = created.scene;
    const projection = new RenderScene();
    try {
      for (const red of [1, 0.5]) {
        const transported = structuredClone({
          ...material,
          materialShaderId: 'forgeax::sprite',
          materialParamSchema: DEFAULT_SPRITE_PARAM_SCHEMA,
          paramSnapshot: {
            colorTint: [red, 1, 1, 1],
            region: [0, 0, 1, 1],
            pivotAndSize: [0.5, 0.5, 1, 1],
            slicesAndMode: [0, 0, 0, 0],
          },
        });
        const source = { ...snapshot(1), material: transported, materials: [transported] };
        queue.writes.length = 0;
        scene.sync(projection.apply([updateSnapshot(source)])).unwrap();
        const upload = queue.writes.find((write) => write.buffer === scene.materialBuffer);
        if (upload === undefined) throw new Error('Expected Sprite material upload');
        const address = scene.materialIndexForSlot(
          projection.slotsSnapshot()[0]?.slot ??
            (() => {
              throw new Error('expected retained slot');
            })(),
          0,
        );
        const resident = queue.resident.get(scene.materialBuffer);
        if (address === undefined || resident === undefined)
          throw new Error('Expected resident Sprite');
        expect(Array.from(new Float32Array(resident.buffer, address * 16, 16))).toEqual([
          red,
          1,
          1,
          1,
          0,
          0,
          1,
          1,
          0.5,
          0.5,
          1,
          1,
          0,
          0,
          0,
          0,
        ]);
      }
    } finally {
      scene.dispose();
    }
  });

  it('uploads only changed material bytes for shared value updates and retries failed writes', () => {
    const queue = new FailingQueue();
    const created = GpuScene.create(createDevice(queue), 8).unwrap();
    expect(created.status).toBe('available');
    if (created.status !== 'available') return;
    const scene = created.scene;
    const projection = new RenderScene();
    const sources = Array.from({ length: 4 }, (_, index) => ({
      ...snapshot(index),
      gpuDrivenDraws: [
        {
          kind: 'indexed' as const,
          first: 0,
          count: 36,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list' as const,
          pipelineClass: 'pbr',
          materialResourceClass: '{}',
        },
      ],
    }));
    scene.sync(projection.apply(sources.map(updateSnapshot))).unwrap();
    const changed = { ...material, roughness: 0.3 };
    const updated = sources.map((source) => ({
      ...source,
      material: changed,
      materials: [changed],
    }));
    const delta = projection.apply(updated.map(updateSnapshot));
    queue.failWrites = true;
    expect(scene.sync(delta).ok).toBe(false);
    queue.failWrites = false;
    queue.writes.length = 0;
    const retried = scene.sync(projection.apply([])).unwrap();
    expect(retried.bytes).toBe(4 * 16);
    expect(queue.writes).toHaveLength(4);
    const roughness = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'roughness');
    for (let index = 0; index < 4; index++) {
      const upload = queue.writes[index];
      if (upload === undefined) throw new Error('expected changed material unit');
      const address = scene.materialIndexForSlot(index, 0);
      if (address === undefined) throw new Error('expected material address');
      expect(upload.offset).toBe(address * 16 + Math.floor(roughness / 16) * 16);
      expect(new DataView(upload.bytes.buffer).getFloat32(roughness % 16, true)).toBeCloseTo(0.3);
    }
    // Fresh snapshots with identical bytes must not upload. Later in-place
    // caller edits remain visible: packed rows are shared only within sync.
    expect(scene.sync(projection.apply(updated.map(updateSnapshot))).unwrap().bytes).toBe(0);
    changed.roughness = 0.6;
    expect(scene.sync(projection.apply(updated.map(updateSnapshot))).unwrap().bytes).toBe(4 * 16);
    const first = updated[0];
    const draw = first?.gpuDrivenDraws[0];
    if (first === undefined || draw === undefined) throw new Error('expected draw fixture');
    queue.writes.length = 0;
    const geometryChanged = {
      ...first,
      localAabb: new Float32Array([-2, -1, -1, 2, 1, 1]),
      gpuDrivenDraws: [{ ...draw, first: 6, count: 12, baseVertex: -3 }],
    };
    expect(scene.sync(projection.apply([updateSnapshot(geometryChanged)])).unwrap().bytes).toBe(
      GPU_SCENE_LAYOUTS.primitive.stride + GPU_SCENE_LAYOUTS.drawTemplate.stride,
    );
    const drawUpload = queue.writes.find(
      ({ bytes }) => bytes.length === GPU_SCENE_LAYOUTS.drawTemplate.stride,
    );
    if (drawUpload === undefined) throw new Error('expected changed draw upload');
    expect(
      new DataView(drawUpload.bytes.buffer).getInt32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.drawTemplate, 'baseVertex'),
        true,
      ),
    ).toBe(-3);
    scene.dispose();
  });

  it('preserves authored base-color alpha in the scene material row', () => {
    const row = packStandardPbrMaterialRow(createStandardPbrArtifactReceipt(), {
      ...material,
      paramSnapshot: { baseColor: [0.25, 0.5, 0.75, 0.4] },
    });
    expect(
      new DataView(row.buffer).getFloat32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'baseColor') + 3 * 4,
        true,
      ),
    ).toBeCloseTo(0.4);
  });

  it('prefers extracted Standard PBR values over schema defaults', () => {
    const row = packStandardPbrMaterialRow(createStandardPbrArtifactReceipt(), material);
    const view = new DataView(row.buffer);
    expect(
      view.getFloat32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'baseColor'), true),
    ).toBeCloseTo(0.25);
    expect(
      view.getFloat32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'metallic'), true),
    ).toBeCloseTo(0.2);
    expect(
      view.getFloat32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'roughness'), true),
    ).toBeCloseTo(0.8);
  });

  it('allocates compact mixed material ABIs and preserves addresses across unrelated updates', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') throw new Error('expected GPU scene');
    const projection = new RenderScene();
    const smallSchema = [{ name: 'tint', type: 'color' as const }];
    const largeSchema = [...smallSchema, { name: 'roughness', type: 'f32' as const }];
    const small = {
      ...material,
      materialShaderId: 'game::small',
      materialParamSchema: smallSchema,
      paramSnapshot: { tint: [1, 0, 0, 1] },
    };
    const large = {
      ...material,
      materialShaderId: 'game::large',
      materialParamSchema: largeSchema,
      paramSnapshot: { tint: [0, 1, 0, 1], roughness: 0.7 },
    };
    const source = {
      ...snapshot(0),
      material: small,
      materials: [small, large],
    } as RenderableSnapshot;
    created.scene.sync(projection.apply([updateSnapshot(source)])).unwrap();
    const first = created.scene.materialIndexForSlot(0, 0);
    const second = created.scene.materialIndexForSlot(0, 1);
    expect(first).toBe(0);
    expect(second).toBe(2);
    expect(created.scene.inspect().tables.material.bytes).toBe(64);
    const materialWrites = queue.writes.filter(
      (write) => write.buffer === created.scene.materialBuffer,
    );
    expect(materialWrites.at(-1)?.offset).toBe(32);
    expect(materialWrites.at(-1)?.bytes).toEqual(packMaterialProgramRow(largeSchema, large, 32));
    const changed = { ...large, paramSnapshot: { tint: [0, 1, 0, 1], roughness: 0.3 } };
    queue.writes.length = 0;
    created.scene
      .sync(projection.apply([updateSnapshot({ ...source, materials: [small, changed] })]))
      .unwrap();
    expect(created.scene.materialIndexForSlot(0, 0)).toBe(first);
    expect(created.scene.materialIndexForSlot(0, 1)).toBe(second);
    const changes = queue.writes.filter((write) => write.buffer === created.scene.materialBuffer);
    expect(changes.map((write) => [write.offset, write.bytes.byteLength])).toEqual([[48, 16]]);
    const change = changes[0];
    if (change === undefined) throw new Error('expected partial update');
    expect(new DataView(change.bytes.buffer).getFloat32(0, true)).toBeCloseTo(0.3);
    created.scene.dispose();
  });

  it('packs a custom schema into the same scene row page', () => {
    const row = packMaterialProgramRow(
      [
        { name: 'tint', type: 'color' },
        { name: 'roughness', type: 'f32' },
      ],
      {
        ...material,
        materialShaderId: 'game::custom-surface',
        materialParamSchema: [
          { name: 'tint', type: 'color' },
          { name: 'roughness', type: 'f32' },
        ],
        paramSnapshot: { tint: [0.1, 0.2, 0.3, 1], roughness: 0.7 },
      },
    );
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.byteLength).toBe(GPU_SCENE_LAYOUTS.material.stride);
    expect(new DataView(row.buffer).getFloat32(0, true)).toBeCloseTo(0.1);
    expect(new DataView(row.buffer).getFloat32(16, true)).toBeCloseTo(0.7);
  });

  it('writes the last vector in the canonical page and rejects overflow', () => {
    const size = GPU_SCENE_LAYOUTS.material.stride;
    const schema = Array.from({ length: size / 16 }, (_, index) => ({
      name: `value${index}`,
      type: 'vec4' as const,
    }));
    const row = packMaterialProgramRow(schema, {
      ...material,
      paramSnapshot: { [`value${size / 16 - 1}`]: [7, 8, 9, 10] },
    });
    if (row === undefined) throw new Error('canonical row missing');
    expect(row.byteLength).toBe(size);
    expect(Array.from(new Float32Array(row.buffer, size - 16, 4))).toEqual([7, 8, 9, 10]);
    expect(
      packMaterialProgramRow([...schema, { name: 'overflow', type: 'f32' }], material),
    ).toBeUndefined();
  });

  it('exposes GPU scene facts as exact temporal coverage', () => {
    const coverage = classifySceneDataCoverage({
      contributors: [{ id: 'gpu-scene', kind: 'exact' }],
      requiredContributorIds: ['gpu-scene'],
    });
    expect(coverage.complete).toBe(true);
    expect(coverage.exactContributorIds).toEqual(['gpu-scene']);
  });

  it('uploads only coalesced dirty ranges and performs no upload on no-change', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    expect(created.status).toBe('available');
    if (created.status !== 'available') return;
    const projection = new RenderScene();

    const initial = projection.apply([
      updateSnapshot(snapshot(0)),
      updateSnapshot(snapshot(1)),
      updateSnapshot(snapshot(2)),
    ]);
    const expectedInitialBytes =
      3 * GPU_SCENE_LAYOUTS.primitive.stride +
      3 * GPU_SCENE_LAYOUTS.instance.stride +
      4 * GPU_SCENE_LAYOUTS.transform.stride +
      3 * GPU_SCENE_LAYOUTS.drawTemplate.stride +
      3 * GPU_SCENE_LAYOUTS.material.stride;
    expect(created.scene.sync(initial).unwrap()).toMatchObject({
      ranges: 5,
      bytes: expectedInitialBytes,
    });
    const writesAfterInitial = queue.writes.length;

    created.scene.sync(projection.apply([])).unwrap();
    expect(queue.writes).toHaveLength(writesAfterInitial);

    const dirty = projection.apply([
      { kind: 'update', worldId: 0, entityKey: 0, world: snapshot(0, 4).transform.world },
      { kind: 'update', worldId: 0, entityKey: 2, world: snapshot(2, 8).transform.world },
    ]);
    expect(created.scene.sync(dirty).unwrap()).toMatchObject({
      ranges: 2,
      bytes: 2 * GPU_SCENE_LAYOUTS.transform.stride,
    });
    expect(queue.writes.length).toBeGreaterThan(writesAfterInitial);
    expect(created.scene.inspect()).toMatchObject({ noChangeFrames: 1 });
  });

  it('pulses temporal primitive flags until the next committed temporal frame', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const scene = created.scene;
    const projection = new RenderScene();
    projection.setTemporalTracking(true);
    const resolve = (current: RenderSceneSlot) => projection.temporalSnapshotBySlot(current.slot);
    const temporalFlags = GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID;
    const flagsOffset = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'flags');
    const primitiveWrites = () =>
      queue.writes.filter(({ buffer }) => buffer === scene.primitiveBuffer);
    const lastFlags = () => {
      const write = primitiveWrites().at(-1);
      if (write === undefined) throw new Error('expected a primitive upload');
      return new DataView(write.bytes.buffer).getUint32(flagsOffset, true);
    };

    scene.sync(projection.apply([updateSnapshot(snapshot(0, 2))]), resolve).unwrap();
    expect(lastFlags() & temporalFlags).toBe(temporalFlags);

    scene.commitTemporalFrame().unwrap();
    projection.commitSubmission(projection.captureSubmission([{ worldId: 0, entityKey: 0 }]));
    const beforeClear = primitiveWrites().length;
    scene.sync(projection.apply([]), resolve).unwrap();
    expect(primitiveWrites()).toHaveLength(beforeClear + 1);
    expect(lastFlags() & temporalFlags).toBe(0);

    // An ordinary motion step keeps valid, non-reactive history: no row upload.
    const moved = projection.apply([
      { kind: 'update', worldId: 0, entityKey: 0, world: snapshot(0, 3).transform.world },
    ]);
    const beforeMove = primitiveWrites().length;
    scene.sync(moved, resolve).unwrap();
    expect(primitiveWrites()).toHaveLength(beforeMove);
    scene.sync(projection.apply([]), resolve).unwrap();
    expect(primitiveWrites()).toHaveLength(beforeMove);

    // A material revision cuts color history and motion for one frame.
    const revised = { ...snapshot(0, 3), materials: [{ ...material }] };
    scene.sync(projection.apply([updateSnapshot(revised)]), resolve).unwrap();
    expect(lastFlags() & temporalFlags).toBe(temporalFlags);
  });

  it('keeps the shadow-receive opt-out across temporal pulse clears', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const scene = created.scene;
    const projection = new RenderScene();
    projection.setTemporalTracking(true);
    const resolve = (current: RenderSceneSlot) => projection.temporalSnapshotBySlot(current.slot);
    const flagsOffset = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'flags');
    const lastFlags = () => {
      const write = queue.writes.filter(({ buffer }) => buffer === scene.primitiveBuffer).at(-1);
      if (write === undefined) throw new Error('expected a primitive upload');
      return new DataView(write.bytes.buffer).getUint32(flagsOffset, true);
    };
    const noReceive = { ...snapshot(0, 2), shadowReceiver: false as const };

    scene.sync(projection.apply([updateSnapshot(noReceive)]), resolve).unwrap();
    expect(lastFlags() & GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE).not.toBe(0);

    scene.commitTemporalFrame().unwrap();
    projection.commitSubmission(projection.captureSubmission([{ worldId: 0, entityKey: 0 }]));
    scene.sync(projection.apply([]), resolve).unwrap();
    expect(lastFlags() & (GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID)).toBe(
      0,
    );
    expect(lastFlags() & GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE).not.toBe(0);

    scene.sync(projection.apply([updateSnapshot(snapshot(0, 2))]), resolve).unwrap();
    expect(lastFlags() & GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE).toBe(0);
  });

  it('does not publish GPU previous transforms for an ordinary moving frame', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 1).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(snapshot(0, 2))])).unwrap();

    const writesBefore = queue.writes.length;
    const bytesBefore = created.scene.inspect().uploadBytes;
    created.scene.commitTemporalFrame(false).unwrap();
    expect(queue.writes).toHaveLength(writesBefore);
    expect(created.scene.inspect().uploadBytes).toBe(bytesBefore);

    created.scene.commitTemporalFrame(true).unwrap();
    expect(queue.writes).toHaveLength(writesBefore);
    expect(created.scene.inspect().uploadBytes).toBe(bytesBefore);

    const dirty = projection.apply([
      { kind: 'update', worldId: 0, entityKey: 0, world: snapshot(0, 3).transform.world },
    ]);
    created.scene.sync(dirty).unwrap();
    created.scene.commitTemporalFrame(true).unwrap();
    expect(queue.writes).toHaveLength(writesBefore + 2);
    expect(created.scene.inspect().uploadBytes).toBe(
      bytesBefore + 2 * GPU_SCENE_LAYOUTS.transform.stride,
    );
  });

  it('keeps static shadow changes empty while flushing committed temporal flags', () => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const world = new World();
    registerPropagateTransforms(world);
    const spawn = (x: number) =>
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: {} },
          { component: Mobility, data: { kind: MobilityKindValue.static } },
        )
        .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: {} },
        { component: MotionBlur, data: { shutterAngle: 180 } },
      )
      .unwrap();
    const moved = spawn(0);
    spawn(4);
    world.update(0).unwrap();
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene({ getDevice: () => device });
    const draw = () =>
      persistent.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        (request) =>
          extractFrames([world], 0, undefined, undefined, persistent.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          }),
        [lease],
      );
    try {
      draw();
      persistent.prepareTemporalFrame(
        persistent.compositionSlots().map(({ snapshot }) => snapshot),
      );
      expect(persistent.commitTemporalFrame().ok).toBe(true);
      draw();
      queue.writes.length = 0;
      // A real geometry update cuts temporal history on the retained owner.
      world.set(moved, MeshFilter, { assetHandle: HANDLE_SPHERE }).unwrap();
      world.update(0).unwrap();
      draw();
      const state = persistent.compositionGpuDrivenState();
      if (state === undefined) throw new Error('expected persistent GPU scene');
      const classifier = new ShadowCasterClassifier();
      const initial = classifier.update(persistent.compositionSlots(), state.scene);
      expect(initial.staticSlots).toHaveLength(2);
      const flagsOffset = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'flags');
      const temporalFlags = GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID;
      const primitiveWrites = () =>
        queue.writes.filter(({ buffer }) => buffer === state.scene.primitiveBuffer);
      expect(
        primitiveWrites().some(
          ({ bytes }) =>
            (new DataView(bytes.buffer).getUint32(flagsOffset, true) & temporalFlags) !== 0,
        ),
      ).toBe(true);

      // A rejected submission must not clear its transient metadata.
      persistent.prepareTemporalFrame(
        persistent.compositionSlots().map(({ snapshot }) => snapshot),
      );
      persistent.discardTemporalFrame();
      queue.writes.length = 0;
      draw();
      expect(queue.writes).toHaveLength(0);
      expect(classifier.update(persistent.compositionSlots(), state.scene)).toBe(initial);

      persistent.prepareTemporalFrame(
        persistent.compositionSlots().map(({ snapshot }) => snapshot),
      );
      expect(persistent.commitTemporalFrame().ok).toBe(true);
      const revision = state.scene.contentRevision;
      queue.writes.length = 0;
      draw();
      expect(primitiveWrites()).toHaveLength(1);
      expect(queue.writes).toHaveLength(1);
      const cleared = primitiveWrites()[0];
      if (cleared === undefined) throw new Error('expected temporal primitive upload');
      expect(new DataView(cleared.bytes.buffer).getUint32(flagsOffset, true) & temporalFlags).toBe(
        0,
      );
      expect(state.scene.contentRevision).toBeGreaterThan(revision);
      expect(state.scene.changedSlotsSince(revision)).toEqual([]);
      expect(state.scene.changedBoundsSince(revision)).toEqual(new Float32Array());
      expect(classifier.update(persistent.compositionSlots(), state.scene)).toBe(initial);

      // The same owner must still demote an actually moved declared-static caster.
      const movedSlot = persistent.compositionSlots().find(({ entityKey }) => entityKey === moved);
      if (movedSlot === undefined) throw new Error('expected moved caster slot');
      const beforeMove = state.scene.contentRevision;
      world.set(moved, Transform, { pos: [2, 0, 0] }).unwrap();
      world.update(0).unwrap();
      draw();
      expect(state.scene.changedSlotsSince(beforeMove)).toEqual([movedSlot.slot]);
      const changed = classifier.update(persistent.compositionSlots(), state.scene);
      expect(changed.dynamicSlots).toEqual([movedSlot.slot]);
      expect(changed.staticSlots).toHaveLength(1);
      const beforeResync = state.scene.contentRevision;
      persistent.invalidate();
      draw();
      expect(state.scene.changedSlotsSince(beforeResync)).toBeUndefined();
      expect(classifier.update(persistent.compositionSlots(), state.scene).staticSlots).toEqual([]);
    } finally {
      lease.dispose();
      persistent.dispose();
    }
  });

  it('keeps persistent GPU previous transforms unchanged until temporal commit', () => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const world = new World();
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene({ getDevice: () => device });
    const source = snapshot(1, 3);

    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => persistentFrame([source]),
      [lease],
    );
    const state = persistent.compositionGpuDrivenState();
    expect(state).toBeDefined();
    if (state === undefined) return;
    const slot = persistent.compositionSlots()[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;

    const movedWorld = new Float32Array(slot.snapshot.transform.world);
    movedWorld[12] = 9;
    state.scene
      .sync({
        created: 0,
        updated: 1,
        removed: 0,
        recreated: 0,
        ignoredLateUpdates: 0,
        createdSlots: [],
        updatedSlots: [
          { ...slot, snapshot: { ...slot.snapshot, transform: { world: movedWorld } } },
        ],
        contentUpdatedSlots: [],
        instanceUpdatedSlots: [],
        removedSlots: [],
        recreatedSlots: [],
        resynced: 0,
      })
      .unwrap();
    const beforeCommit = state.scene.inspect();

    expect(persistent.commitTemporalFrame().ok).toBe(true);
    expect(state.scene.inspect()).toMatchObject({
      uploadRanges: beforeCommit.uploadRanges,
      uploadBytes: beforeCommit.uploadBytes,
    });
    lease.dispose();
    persistent.dispose();
  });

  it('preserves the prior root transform on transform-only updates', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 1).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(snapshot(0, 2))])).unwrap();

    const dirty = projection.apply([
      { kind: 'update', worldId: 0, entityKey: 0, world: snapshot(0, 9).transform.world },
    ]);
    created.scene.sync(dirty).unwrap();

    const transformWrite = queue.writes.at(-1);
    expect(transformWrite).toBeDefined();
    if (transformWrite === undefined) return;
    const transform = GPU_SCENE_LAYOUTS.transform;
    const currentTranslation = gpuSceneFieldOffset(transform, 'currentWorld') + 12 * 4;
    const previousTranslation = gpuSceneFieldOffset(transform, 'previousWorld') + 12 * 4;
    const bytes = transformWrite.bytes;
    expect(new DataView(bytes.buffer).getFloat32(currentTranslation, true)).toBe(9);
    expect(new DataView(bytes.buffer).getFloat32(previousTranslation, true)).toBe(2);
  });

  it('uploads only the instance transform span for an Instances-only update', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 1).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(instanceSnapshot(0, 2))])).unwrap();

    const update = projection.apply([updateInstances(instanceSnapshot(0, 9))]);
    expect(update.instanceUpdatedSlots).toHaveLength(1);
    expect(update.contentUpdatedSlots).toHaveLength(0);
    const synced = created.scene.sync(update).unwrap();
    expect(synced).toMatchObject({
      ranges: 1,
      bytes: GPU_SCENE_LAYOUTS.transform.stride,
    });
  });

  it('maps GPU previous instance transforms by stable generation after reorder', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    projection.setTemporalTracking(true);
    const initial = multiInstanceSnapshot(0, [2, 8], [101, 202]);
    created.scene.sync(projection.apply([updateSnapshot(initial)])).unwrap();
    projection.commitSubmission(projection.captureSubmission([{ worldId: 0, entityKey: 0 }]));

    const reordered = multiInstanceSnapshot(0, [9, 3], [202, 101]);
    const delta = projection.apply([updateInstances(reordered)]);
    const slot = projection.slotsSnapshot()[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(projection.temporalSnapshotBySlot(slot.slot)?.motionValid).toBe(true);

    queue.writes.length = 0;
    created.scene
      .sync(delta, (current) => projection.temporalSnapshotBySlot(current.slot))
      .unwrap();
    const transformWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === 2 * GPU_SCENE_LAYOUTS.transform.stride,
    );
    expect(transformWrite).toBeDefined();
    if (transformWrite === undefined) return;
    const previousTranslation =
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld') + 12 * 4;
    const transforms = new DataView(transformWrite.bytes.buffer);
    expect(transforms.getFloat32(previousTranslation, true)).toBe(8);
    expect(
      transforms.getFloat32(GPU_SCENE_LAYOUTS.transform.stride + previousTranslation, true),
    ).toBe(2);

    created.scene.commitTemporalFrame().unwrap();
    projection.commitSubmission(projection.captureSubmission([{ worldId: 0, entityKey: 0 }]));
    const retired = multiInstanceSnapshot(0, [11], [202]);
    const retiredDelta = projection.apply([updateInstances(retired)]);
    expect(projection.temporalSnapshotBySlot(slot.slot)?.motionValid).toBe(true);
    queue.writes.length = 0;
    created.scene
      .sync(retiredDelta, (current) => projection.temporalSnapshotBySlot(current.slot))
      .unwrap();
    const compactedRows = queue.writes
      .filter(({ bytes }) => bytes.byteLength % GPU_SCENE_LAYOUTS.transform.stride === 0)
      .flatMap(({ bytes }) =>
        Array.from({ length: bytes.byteLength / GPU_SCENE_LAYOUTS.transform.stride }, (_, row) => {
          const view = new DataView(bytes.buffer);
          return {
            current: view.getFloat32(
              row * GPU_SCENE_LAYOUTS.transform.stride + currentWorldOffset() + 12 * 4,
              true,
            ),
            previous: view.getFloat32(
              row * GPU_SCENE_LAYOUTS.transform.stride + previousTranslation,
              true,
            ),
          };
        }),
      );
    expect(compactedRows).toContainEqual({ current: 11, previous: 9 });
  });

  it('advances GPU previous transforms after a successful temporal commit', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(snapshot(0, 2))])).unwrap();
    created.scene
      .sync(
        projection.apply([
          {
            kind: 'update',
            worldId: 0,
            entityKey: 0,
            world: snapshot(0, 9).transform.world,
          },
        ]),
      )
      .unwrap();
    queue.writes.length = 0;

    expect(created.scene.commitTemporalFrame().ok).toBe(true);
    expect(queue.writes).toHaveLength(1);
    const temporalWrite = queue.writes[0];
    expect(temporalWrite).toBeDefined();
    if (temporalWrite === undefined) return;
    const previousTranslation =
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld') + 12 * 4;
    expect(new DataView(temporalWrite.bytes.buffer).getFloat32(previousTranslation, true)).toBe(9);
  });

  it.each([
    'taa',
    'motion-blur',
  ] as const)('publishes GPU previous transforms for a prepared %s capture', (mode) => {
    const queue = new RecordingQueue();
    const device = createDevice(queue);
    const world = new World();
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene({ getDevice: () => device });
    const source = snapshot(1, 3);
    const camera =
      mode === 'taa'
        ? { ...makeZeroCameraFallbackSnapshot(), antialias: 'taa' as const }
        : {
            ...makeZeroCameraFallbackSnapshot(),
            motionBlur: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
          };

    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => persistentFrame([source], [camera]),
      [lease],
    );
    const state = persistent.compositionGpuDrivenState();
    expect(state).toBeDefined();
    if (state === undefined) return;
    queue.writes.length = 0;
    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      1,
      () => persistentFrame([snapshot(1, 6)], [camera]),
      [lease],
    );
    queue.writes.length = 0;
    const beforeCommit = state.scene.inspect();

    persistent.prepareTemporalFrame([{ worldId: 0, entityKey: 1 }]);
    expect(persistent.commitTemporalFrame().ok).toBe(true);
    expect(queue.writes).toHaveLength(1);
    expect(state.scene.inspect().uploadRanges).toBe(beforeCommit.uploadRanges + 1);
    lease.dispose();
    persistent.dispose();
  });

  it('keeps GPU temporal history unchanged when the temporal upload fails', () => {
    const queue = new FailingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(snapshot(0, 2))])).unwrap();
    created.scene
      .sync(
        projection.apply([
          {
            kind: 'update',
            worldId: 0,
            entityKey: 0,
            world: snapshot(0, 9).transform.world,
          },
        ]),
      )
      .unwrap();
    queue.writes.length = 0;
    queue.failWrites = true;
    expect(created.scene.commitTemporalFrame().ok).toBe(false);
    expect(queue.writes).toHaveLength(0);

    queue.failWrites = false;
    expect(created.scene.commitTemporalFrame().ok).toBe(true);
    expect(queue.writes).toHaveLength(1);
    const temporalWrite = queue.writes[0];
    expect(temporalWrite).toBeDefined();
    if (temporalWrite === undefined) return;
    const previousTranslation =
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld') + 12 * 4;
    expect(new DataView(temporalWrite.bytes.buffer).getFloat32(previousTranslation, true)).toBe(9);
  });

  it('publishes CPU previous transforms only after a successful submission', () => {
    const projection = new RenderScene();
    projection.setTemporalTracking(true);
    projection.apply([updateSnapshot(snapshot(0, 2))]);
    projection.commitSubmission(projection.captureSubmission([{ worldId: 0, entityKey: 0 }]));
    const slot = projection.slotsSnapshot()[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(projection.temporalSnapshotBySlot(slot.slot)?.previousTransform.world[12]).toBe(2);

    projection.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 0,
        world: snapshot(0, 9).transform.world,
      },
    ]);
    const pending = projection.captureSubmission([{ worldId: 0, entityKey: 0 }]);
    // A failed execute/finish/submit does not call commitSubmission. The
    // previous frame therefore remains the last successfully submitted pose.
    expect(projection.temporalSnapshotBySlot(slot.slot)?.previousTransform.world[12]).toBe(2);
    projection.commitSubmission(pending);
    expect(projection.temporalSnapshotBySlot(slot.slot)?.previousTransform.world[12]).toBe(9);
  });

  it('clears removed slots, grows without losing the CPU mirror, and syncs a fresh table', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 1).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene
      .sync(
        projection.apply([
          updateSnapshot(snapshot(0)),
          updateSnapshot(snapshot(1)),
          updateSnapshot(snapshot(2)),
        ]),
      )
      .unwrap();
    expect(created.scene.inspect()).toMatchObject({ capacity: 4, capacityGrows: 1 });

    const beforeRemove = queue.writes.length;
    created.scene.sync(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }])).unwrap();
    expect(queue.writes.slice(beforeRemove)).toHaveLength(5);
    expect(queue.writes.at(-1)?.bytes.every((value) => value === 0)).toBe(true);
    expect(created.scene.inspect().clearedSlots).toBe(1);

    const rebuilt = GpuScene.create(createDevice(new RecordingQueue()), 1).unwrap();
    if (rebuilt.status !== 'available') return;
    const slots = projection.slotsSnapshot();
    const bootstrapped = rebuilt.scene
      .sync({
        created: slots.length,
        updated: 0,
        removed: 0,
        recreated: 0,
        ignoredLateUpdates: 0,
        createdSlots: slots,
        updatedSlots: [],
        contentUpdatedSlots: [],
        instanceUpdatedSlots: [],
        removedSlots: [],
        recreatedSlots: [],
        resynced: 1,
      })
      .unwrap();
    expect(bootstrapped.ranges).toBeGreaterThan(0);
    expect(rebuilt.scene.inspect()).toMatchObject({ capacity: 4, fullRebuilds: 1 });
  });

  it('resets previous transform when a slot generation is recreated', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 1).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(snapshot(1, 2))])).unwrap();

    created.scene
      .sync(
        projection.apply([
          { kind: 'remove', worldId: 0, entityKey: 1 },
          updateSnapshot(snapshot(1, 9)),
        ]),
      )
      .unwrap();

    const transformWrite = queue.writes.at(-3);
    expect(transformWrite).toBeDefined();
    if (transformWrite === undefined) return;
    const previousTranslation =
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld') + 12 * 4;
    expect(new DataView(transformWrite.bytes.buffer).getFloat32(previousTranslation, true)).toBe(9);
  });

  it('reserves transform row zero for identity and does not synthesize instance transforms', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([updateSnapshot(snapshot(1, 2))])).unwrap();

    const transformWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === 2 * GPU_SCENE_LAYOUTS.transform.stride,
    );
    expect(transformWrite).toBeDefined();
    if (transformWrite === undefined) return;
    const transforms = new DataView(transformWrite.bytes.buffer);
    const currentWorld = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'currentWorld');
    const previousWorld = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld');
    expect(transforms.getFloat32(currentWorld, true)).toBe(1);
    expect(transforms.getFloat32(previousWorld, true)).toBe(1);

    const recycled = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 1 },
      updateSnapshot(snapshot(2, 7)),
    ]);
    expect(recycled.removedSlots[0]?.slot).toBe(recycled.createdSlots[0]?.slot);
    created.scene.sync(recycled).unwrap();

    const primitiveWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === GPU_SCENE_LAYOUTS.primitive.stride,
    );
    expect(primitiveWrite).toBeDefined();
    if (primitiveWrite === undefined) return;
    const primitive = new DataView(primitiveWrite.bytes.buffer);
    expect(
      primitive.getUint32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex'), true),
    ).toBe(1);
    const instanceWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === GPU_SCENE_LAYOUTS.instance.stride,
    );
    expect(instanceWrite).toBeDefined();
    if (instanceWrite === undefined) return;
    expect(
      new DataView(instanceWrite.bytes.buffer).getUint32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'transformIndex'),
        true,
      ),
    ).toBe(0);
  });

  it('allocates root and local transform segments only for explicit Instances rows', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    const localA = new Float32Array(16);
    localA[0] = 1;
    localA[5] = 1;
    localA[10] = 1;
    localA[15] = 1;
    localA[12] = 4;
    const localB = new Float32Array(localA);
    localB[12] = 8;
    created.scene
      .sync(
        projection.apply([
          updateSnapshot({
            ...snapshot(0, 3),
            instances: {
              transforms: new Float32Array([...localA, ...localB]),
              instanceCount: 2,
              cacheKey: 1,
              archVersion: 1,
              revision: 1,
            },
          }),
        ]),
      )
      .unwrap();

    const primitiveWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === GPU_SCENE_LAYOUTS.primitive.stride,
    );
    const instanceWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === 2 * GPU_SCENE_LAYOUTS.instance.stride,
    );
    const transformWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === 4 * GPU_SCENE_LAYOUTS.transform.stride,
    );
    expect(primitiveWrite).toBeDefined();
    expect(instanceWrite).toBeDefined();
    expect(transformWrite).toBeDefined();
    if (primitiveWrite === undefined || instanceWrite === undefined || transformWrite === undefined)
      return;

    const primitive = new DataView(primitiveWrite.bytes.buffer);
    expect(
      primitive.getUint32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex'), true),
    ).toBe(1);
    expect(
      primitive.getUint32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'instanceCount'), true),
    ).toBe(2);
    const instances = new DataView(instanceWrite.bytes.buffer);
    expect(
      instances.getUint32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'transformIndex'), true),
    ).toBe(2);
    expect(
      instances.getUint32(
        GPU_SCENE_LAYOUTS.instance.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'transformIndex'),
        true,
      ),
    ).toBe(3);
    const transforms = new DataView(transformWrite.bytes.buffer);
    expect(transforms.getFloat32(0, true)).toBe(1);
    expect(
      transforms.getFloat32(
        GPU_SCENE_LAYOUTS.transform.stride + currentWorldOffset() + 12 * 4,
        true,
      ),
    ).toBe(3);
    expect(
      transforms.getFloat32(
        2 * GPU_SCENE_LAYOUTS.transform.stride + currentWorldOffset() + 12 * 4,
        true,
      ),
    ).toBe(4);
    expect(
      transforms.getFloat32(
        3 * GPU_SCENE_LAYOUTS.transform.stride + currentWorldOffset() + 12 * 4,
        true,
      ),
    ).toBe(8);
  });

  it('keeps empty Instances at zero rows and never reuses identity row on recreation', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    const empty = {
      ...snapshot(0, 3),
      instances: {
        transforms: new Float32Array(),
        instanceCount: 0,
        cacheKey: 1,
        archVersion: 1,
      },
    };
    created.scene.sync(projection.apply([updateSnapshot(empty)])).unwrap();

    const primitiveWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === GPU_SCENE_LAYOUTS.primitive.stride,
    );
    const transformWrite = queue.writes.find(
      ({ bytes }) => bytes.byteLength === 2 * GPU_SCENE_LAYOUTS.transform.stride,
    );
    expect(primitiveWrite).toBeDefined();
    expect(transformWrite).toBeDefined();
    if (primitiveWrite === undefined || transformWrite === undefined) return;
    const primitive = new DataView(primitiveWrite.bytes.buffer);
    expect(
      primitive.getUint32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'instanceCount'), true),
    ).toBe(0);
    expect(
      primitive.getUint32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex'), true),
    ).toBe(1);

    const writesBeforeRecreate = queue.writes.length;
    const replacement = { ...empty, assetHandle: 10 };
    const recreated = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 0 },
      updateSnapshot(replacement),
    ]);
    created.scene.sync(recreated).unwrap();
    const replacementPrimitive = queue.writes
      .slice(writesBeforeRecreate)
      .find(({ bytes }) => bytes.byteLength === GPU_SCENE_LAYOUTS.primitive.stride);
    expect(replacementPrimitive).toBeDefined();
    if (replacementPrimitive === undefined) return;
    expect(
      new DataView(replacementPrimitive.bytes.buffer).getUint32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex'),
        true,
      ),
    ).toBe(1);
  });
  it('visits only dirty rows when the resident revision precedes the update', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 128).unwrap();
    if (created.status !== 'available') throw new Error('RHI null must expose storage tables');
    const projection = new RenderScene();
    const base = multiInstanceSnapshot(
      8,
      Array.from({ length: 64 }, (_, index) => index),
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
    const instances = base.instances;
    if (instances === undefined) throw new Error('expected instance fixture');
    const collection = { ...instances, collectionId: 1 as never };
    created.scene.sync(projection.apply([updateSnapshot({ ...base, instances: collection })]));
    const rowsVisited = () => created.scene.inspect().instanceRowsVisited;
    const move = (revision: number, row: number, x: number, dirty: boolean) => {
      const transforms = new Float32Array(collection.transforms);
      transforms[row * 16 + 12] = x;
      collection.transforms = transforms;
      const next = {
        ...collection,
        revision,
        ...(dirty ? { dirtyRanges: [{ start: row, end: row + 1 }] } : {}),
      };
      Object.assign(collection, { revision });
      const before = rowsVisited();
      const result = created.scene
        .sync(projection.apply([updateInstances({ ...base, instances: next })]))
        .unwrap();
      return { rows: rowsVisited() - before, bytes: result.bytes };
    };
    const stride = GPU_SCENE_LAYOUTS.transform.stride;
    expect(move(2, 17, 100, true)).toEqual({ rows: 1, bytes: stride });
    expect(move(3, 40, 200, true)).toEqual({ rows: 1, bytes: stride });
    // A revision gap or missing row evidence visits the whole collection but
    // still uploads only the changed row.
    expect(move(5, 41, 300, true)).toEqual({ rows: 64, bytes: stride });
    expect(move(6, 42, 400, false)).toEqual({ rows: 64, bytes: stride });
  });

  it('uploads changed rows when material, root and sparse instance edits share one update', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 128).unwrap();
    if (created.status !== 'available') throw new Error('RHI null must expose storage tables');
    const projection = new RenderScene();
    const base = instanceSnapshot(8, 0);
    if (base.instances === undefined) throw new Error('expected instance fixture');
    const transforms = new Float32Array(64 * 16);
    for (let index = 0; index < 64; index += 1) transforms.set(base.transform.world, index * 16);
    const initial = { ...base, instances: { ...base.instances, instanceCount: 64, transforms } };
    created.scene.sync(projection.apply([updateSnapshot(initial)])).unwrap();
    const nextTransforms = new Float32Array(transforms);
    nextTransforms[17 * 16 + 12] = 4;
    const nextMaterial = { ...material, roughness: 0.3 };
    const mixed = {
      ...initial,
      transform: snapshot(8, 3).transform,
      material: nextMaterial,
      materials: [nextMaterial],
      instances: { ...initial.instances, transforms: nextTransforms, revision: 2 },
    };
    const delta = projection.apply([updateSnapshot(mixed)]);
    expect(delta.updated).toBe(1);
    const result = created.scene.sync(delta).unwrap();
    expect(result.bytes).toBe(16 + 2 * GPU_SCENE_LAYOUTS.transform.stride);
    expect(result.grew).toBe(false);
    const next = { ...mixed, material: { ...nextMaterial, roughness: 0.7 } };
    next.materials = [next.material];
    const materialOnly = created.scene.sync(projection.apply([updateSnapshot(next)])).unwrap();
    expect(materialOnly.bytes).toBe(16);
  });
});

function currentWorldOffset(): number {
  return gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'currentWorld');
}
