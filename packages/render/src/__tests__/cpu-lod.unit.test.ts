import { createBoxGeometry, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { beforeAll, describe, expect, it } from 'vitest';
import { GpuResidencyCache, type MeshGpuHandles } from '../device/gpu-residency';
import { ShadowMeshReads } from '../device/mesh-changes';
import { projectedHeightForSnapshot } from '../gpu-driven/batch-topology';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_INDEX, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import {
  cpuInstanceLodDraws,
  cpuInstanceLodRuns,
  cpuLodLevel,
  lodLevelHistogram,
  selectCpuLodRows,
} from '../record/cpu-lod';
import { makeZeroCameraFallbackSnapshot, type ValidatedRenderable } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { CapturedSceneTransform } from '../scene/captured-transform';

const LOD_MESH_GUID = '00000000-0000-7000-8000-000000000001' as never;

function source(overrides: Partial<RenderableSnapshot> = {}): RenderableSnapshot {
  const material = new MaterialResource({
    passes: [],
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  });
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle: 3,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    entityKey: 1,
    lods: [{ mesh: LOD_MESH_GUID, screenCoverage: 0.5 }],
    lodHysteresis: 0,
    ...overrides,
  };
}

let device: RhiNullDevice;

beforeAll(async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
});

function mesh(lowerResident = true): MeshGpuHandles {
  const vertex = device.createBuffer({ size: 144, usage: GPU_BUFFER_USAGE_VERTEX }).unwrap();
  const index = device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_INDEX }).unwrap();
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: new GpuBuffer(device, index),
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: 16,
    indexCount: 6,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list',
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' },
    ],
    lodRanges: [
      [{ first: 0, count: 6, baseVertex: 0 }],
      lowerResident ? [{ first: 6, count: 3, baseVertex: 0 }] : [],
    ],
  };
}

function cameraAt(z: number) {
  return { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, z) };
}

function row(snapshot: RenderableSnapshot, handles: MeshGpuHandles): ValidatedRenderable {
  return {
    source: snapshot,
    mesh: handles,
    renderableIndex: 0,
    meshSlot: 0,
    renderState: undefined,
    stencilReference: undefined,
  };
}

describe('CPU-lane LOD selection', () => {
  it('reads packed root and instance poses at their own addresses on changing frames', () => {
    const handles = mesh();
    const original = source();
    const base = original.transform.world;
    const transforms = new Float32Array(3 * 16);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      transforms.set(base, ordinal * 16);
      transforms[ordinal * 16 + 14] = ordinal * 5;
    }
    const instances = { transforms, instanceCount: 3, cacheKey: 1, archVersion: 0 };
    const page = new Float32Array(7 * 16).fill(Number.NaN);
    const scratch = mat4.create();
    for (let frame = 0; frame < 60; frame++) {
      const camera = cameraAt(3 + (frame % 11));
      const offset = (1 + (frame % 6)) * 16;
      const owned = new Float32Array(base);
      owned[0] = frame % 2 === 0 ? -1.2 : 0.7;
      owned[4] = 0.05 * frame;
      owned[12] = frame % 8;
      owned[14] = -(frame % 13);
      page.set(owned, offset);
      const transform = new CapturedSceneTransform(page, offset);
      Object.defineProperty(transform, 'world', {
        get() {
          throw new Error('LOD opened a matrix window');
        },
      });
      const packed = { ...original, transform };
      const plain = { ...original, transform: { world: owned } };
      expect(projectedHeightForSnapshot(packed, camera)).toBe(
        projectedHeightForSnapshot(plain, camera),
      );
      expect(cpuLodLevel(packed, handles, camera)).toBe(cpuLodLevel(plain, handles, camera));
      expect(
        cpuInstanceLodRuns({ ...packed, instances }, handles, camera, undefined, scratch),
      ).toEqual(cpuInstanceLodRuns({ ...plain, instances }, handles, camera));
    }
  });

  it('groups alternating opaque LOD ordinals within each resident page', () => {
    const entry = {
      ...row(source(), mesh()),
      cpuInstanceLods: Array.from({ length: 260 }, (_, first) => ({
        first,
        count: 1,
        level: first % 2,
      })),
    };
    const pages = [
      { firstInstanceOrdinal: 0, instanceCount: 128 },
      { firstInstanceOrdinal: 128, instanceCount: 128 },
      { firstInstanceOrdinal: 256, instanceCount: 4 },
    ];
    const draws = cpuInstanceLodDraws(entry, 0, pages, true);
    expect(draws).toHaveLength(6);
    expect(draws.map((draw) => draw.instanceCount)).toEqual([64, 64, 64, 64, 2, 2]);
    expect(draws[0]?.instanceOrdinals).toEqual(Array.from({ length: 64 }, (_, i) => i * 2));
    expect(draws[1]?.instanceOrdinals).toEqual(Array.from({ length: 64 }, (_, i) => i * 2 + 1));
    expect(draws.flatMap((draw) => draw.instanceOrdinals ?? []).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 260 }, (_, i) => i),
    );
    expect(cpuInstanceLodDraws(entry, 0, pages)).toHaveLength(260);
  });
  it('runs on devices without compute/storage/indirect, such as WebGL2', () => {
    expect(selectGpuLodLane({ compute: false, storageBuffer: false, indirectDrawing: false })).toBe(
      'cpu',
    );
  });

  it('selects the lower level at a distance and LOD0 up close', () => {
    // Radius sqrt(3), fov pi/4: projected height = 8.36 / depth crosses 0.5 near 16.7.
    expect(cpuLodLevel(source(), mesh(), cameraAt(5))).toBe(0);
    expect(cpuLodLevel(source(), mesh(), cameraAt(40))).toBe(1);
  });

  it('keeps LOD0 for non-resident levels and unsupported shapes', () => {
    const far = cameraAt(40);
    expect(cpuLodLevel(source(), mesh(false), far)).toBe(0);
    expect(cpuLodLevel(source({ instances: {} as never }), mesh(), far)).toBe(0);
    expect(
      cpuLodLevel(source({ skinBinding: { skeleton: 1, joints: [2] } as never }), mesh(), far),
    ).toBe(0);
    expect(cpuLodLevel(source({ lods: [] }), mesh(), far)).toBe(0);
  });

  it('draws the selected level index range and keeps LOD0 rows by identity', () => {
    const handles = mesh();
    const rows = [row(source(), handles)];
    expect(selectCpuLodRows(rows, cameraAt(5))).toBe(rows);
    const far = selectCpuLodRows(rows, cameraAt(40));
    expect(far).not.toBe(rows);
    expect(far.at(0)?.mesh.submeshes).toBe(handles.submeshes);
    expect(far.at(0)?.mesh.lodRanges).toEqual([handles.lodRanges?.[1]]);
    expect(far.at(0)?.mesh.indexCount).toBe(3);
    expect(far.at(0)?.mesh.indexBuffer).toBe(handles.indexBuffer);
    expect(selectCpuLodRows(rows, cameraAt(40)).at(0)?.mesh).toBe(far.at(0)?.mesh);
    Object.assign(handles, { contentEpoch: handles.contentEpoch + 1 });
    const rewritten = selectCpuLodRows(rows, cameraAt(40));
    expect(rewritten.at(0)?.mesh.contentEpoch).toBe(handles.contentEpoch);
    expect(rewritten.at(0)?.mesh.indexBuffer).toBe(handles.indexBuffer);
    expect(rewritten.at(0)?.mesh).not.toBe(far.at(0)?.mesh);
    expect(selectCpuLodRows(rows, cameraAt(40)).at(0)?.mesh).toBe(rewritten.at(0)?.mesh);
  });

  it('selects each composed instance transform and preserves ordinal order', () => {
    const transforms = new Float32Array(4 * 16);
    for (let ordinal = 0; ordinal < 4; ordinal++) {
      const offset = ordinal * 16;
      transforms[offset] =
        transforms[offset + 5] =
        transforms[offset + 10] =
        transforms[offset + 15] =
          1;
      transforms[offset + 14] = [0, -35, -35, 0][ordinal] ?? 0;
    }
    const snapshot = source({
      instances: { transforms, instanceCount: 4, cacheKey: 1, archVersion: 0 },
    });
    const selected = selectCpuLodRows([row(snapshot, mesh())], cameraAt(5));
    expect(selected.at(0)?.cpuInstanceLods).toEqual([
      { first: 0, count: 1, level: 0 },
      { first: 1, count: 2, level: 1 },
      { first: 3, count: 1, level: 0 },
    ]);
    expect(selected.at(0)?.source).toBe(snapshot);
    const unavailable = selectCpuLodRows([row(snapshot, mesh(false))], cameraAt(5));
    expect(unavailable.at(0)?.cpuInstanceLods).toEqual([{ first: 0, count: 4, level: 0 }]);
    transforms[16] = transforms[21] = transforms[26] = 10;
    expect(selectCpuLodRows([row(snapshot, mesh())], cameraAt(5)).at(0)?.cpuInstanceLods).toEqual([
      { first: 0, count: 2, level: 0 },
      { first: 2, count: 1, level: 1 },
      { first: 3, count: 1, level: 0 },
    ]);
  });

  it('reads changing packed poses and records shadow LOD ranges without expanding each ordinal', () => {
    const count = 4096;
    const transforms = new Float32Array(count * 16);
    const unit = mat4.identity(mat4.create());
    for (let ordinal = 0; ordinal < count; ordinal++) transforms.set(unit, ordinal * 16);
    const entry = row(
      source({
        instances: { transforms, instanceCount: count, cacheKey: 1, archVersion: 0 },
      }),
      mesh(),
    );
    const camera = cameraAt(5);
    const selection = { values: [] as readonly number[], token: {} };
    const backing = transforms.buffer;
    let backingReads = 0;
    Object.defineProperty(transforms, 'buffer', {
      get() {
        backingReads++;
        return backing;
      },
    });
    const near = selectCpuLodRows([entry], camera, selection);
    expect(near.at(0)?.cpuInstanceLods).toEqual([{ first: 0, count, level: 0 }]);
    const held = selection.values;
    const token = selection.token;
    expect(held.length).toBeLessThanOrEqual(3);
    transforms[32 * 16 + 14] = -40;
    const moved = selectCpuLodRows([entry], camera, selection);
    expect(moved.at(0)?.cpuInstanceLods).toEqual([
      { first: 0, count: 32, level: 0 },
      { first: 32, count: 1, level: 1 },
      { first: 33, count: count - 33, level: 0 },
    ]);
    expect(selection.token).not.toBe(token);
    expect(selection.values.length).toBeLessThanOrEqual(9);
    const changedToken = selection.token;
    transforms[32 * 16 + 14] = -41;
    selectCpuLodRows([entry], camera, selection);
    expect(selection.token).toBe(changedToken);
    expect(near.at(0)?.cpuInstanceLods).toEqual([{ first: 0, count, level: 0 }]);
    expect(backingReads).toBe(0);
  });

  it('reports the selected levels as an ascending histogram', () => {
    expect(lodLevelHistogram([1, 0, 1])).toEqual([
      { level: 0, count: 1 },
      { level: 1, count: 2 },
    ]);
    expect(lodLevelHistogram([])).toEqual([{ level: 0, count: 0 }]);
  });
});

describe('actual Direct-shadow LOD query output', () => {
  it('changes only the level witness while returning current transform rows', () => {
    const selection = { values: [] as readonly number[], token: {} };
    const handles = mesh();
    const rows = [row(source(), handles)];
    selectCpuLodRows(rows, cameraAt(40), selection);
    const a = selection.token,
      numbers = selection.values;
    const moved = source();
    moved.transform.world[12] = 1;
    const currentRows = [row(moved, handles)];
    const same = selectCpuLodRows(currentRows, cameraAt(40), selection);
    expect(selection.token).toBe(a);
    expect(selection.values).toBe(numbers);
    expect(same.at(0)?.source).toBe(moved);
    expect(same.at(0)?.source.transform.world[12]).toBe(1);
    selectCpuLodRows(currentRows, cameraAt(5), selection);
    expect(selection.token).not.toBe(a);
    expect(selection.values).toEqual([1, 0]);
    expect(numbers).toEqual([1, 1]);
  });

  it('keeps only authored LOD results and detects shorter matching prefixes', () => {
    const selection = { values: [] as readonly number[], token: {} };
    const handles = mesh();
    const a = row(source(), handles),
      b = row(source({ entityKey: 2 }), handles);
    const plain = row(source({ entityKey: 3, lods: [] }), handles);
    selectCpuLodRows([a, plain, b], cameraAt(40), selection);
    const numbers = selection.values,
      token = selection.token;
    expect(numbers).toEqual([1, 1, 2, 1]);
    selectCpuLodRows([a, b], cameraAt(40), selection);
    expect(selection.token).toBe(token); // non-LOD members have no numeric copies
    selectCpuLodRows([a], cameraAt(40), selection);
    expect(selection.token).not.toBe(token);
    expect(selection.values).toEqual([1, 1]);
    expect(numbers).toEqual([1, 1, 2, 1]);
    selectCpuLodRows([plain], cameraAt(40), selection);
    const empty = selection.token;
    expect(selection.values).toEqual([]);
    selectCpuLodRows([], cameraAt(40), selection);
    expect(selection.token).toBe(empty);
  });

  it('never publishes a partial numeric result after a query throws', () => {
    const selection = { values: [] as readonly number[], token: {} };
    const handles = mesh();
    const a = row(source(), handles),
      b = row(source({ entityKey: 2 }), handles);
    selectCpuLodRows([a, b], cameraAt(40), selection);
    const numbers = selection.values,
      token = selection.token;
    const failing = source({ entityKey: 4 });
    Object.defineProperty(failing, 'lodHysteresis', {
      get() {
        throw new Error('LOD query failed');
      },
    });
    expect(() =>
      selectCpuLodRows(
        [row(source({ entityKey: 3 }), handles), row(failing, handles)],
        cameraAt(5),
        selection,
      ),
    ).toThrow('LOD query failed');
    expect(selection.token).toBe(token);
    expect(selection.values).toBe(numbers);
    selectCpuLodRows([a, b], cameraAt(40), selection);
    expect(selection.token).toBe(token);
  });

  it('keeps same-level query output while actual lower-chain replacement retires its physical token', () => {
    const store = new GpuResidencyCache();
    store.configureGpuDevice(device, undefined, device.caps);
    const shape = createBoxGeometry(2, 2, 2).unwrap();
    const lowerA = createBoxGeometry(1, 1, 1).unwrap();
    const lowerB = createBoxGeometry(0.5, 0.5, 0.5).unwrap();
    const handle = 9 as import('@forgeax/engine-types').AssetHandle<'mesh'>;
    const a = store.ensureResident(handle, shape, undefined, [lowerA]).unwrap();
    const reads = new ShadowMeshReads(store.meshChanges);
    reads.add(a.changeToken);
    const upper = store.meshChanges.epoch;
    const selection = { values: [] as readonly number[], token: {} };
    selectCpuLodRows([row(source(), a)], cameraAt(40), selection);
    const token = selection.token;
    expect(selection.values).toEqual([1, 1]);
    try {
      const b = store.ensureResident(handle, shape, undefined, [lowerB]).unwrap();
      expect(b).not.toBe(a);
      selectCpuLodRows([row(source(), b)], cameraAt(40), selection);
      expect(selection.token).toBe(token);
      expect(a.changeToken?.retired).toBe(true);
      expect(store.meshChanges.query(upper, reads.generation, reads.tokens)).toBe('invalidated');
    } finally {
      reads.release();
      store.destroyAll();
    }
  });
});
