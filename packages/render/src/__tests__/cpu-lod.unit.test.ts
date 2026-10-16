import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_INDEX, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import {
  cpuLodLevel,
  lodLevelHistogram,
  projectValidatedRows,
  selectCpuLodRows,
} from '../record/cpu-lod';
import { makeZeroCameraFallbackSnapshot, type ValidatedRenderable } from '../record/frame-snapshot';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';

const LOD_MESH_GUID = '00000000-0000-7000-8000-000000000001' as never;

function source(overrides: Partial<RenderableSnapshot> = {}): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([1, 1, 1]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
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
    worldId: 0,
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
    renderState: undefined,
    stencilReference: undefined,
  };
}

describe('CPU-lane LOD selection', () => {
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
    expect(cpuLodLevel(source({ skin: {} as never }), mesh(), far)).toBe(0);
    expect(cpuLodLevel(source({ lods: [] }), mesh(), far)).toBe(0);
  });

  it('draws the selected level index range and keeps LOD0 rows by identity', () => {
    const handles = mesh();
    const rows = [row(source(), handles)];
    expect(selectCpuLodRows(rows, cameraAt(5))).toBe(rows);
    const far = selectCpuLodRows(rows, cameraAt(40));
    expect(far).not.toBe(rows);
    expect(far[0]?.mesh.submeshes).toBe(handles.submeshes);
    expect(far[0]?.mesh.lodRanges).toEqual([handles.lodRanges?.[1]]);
    expect(far[0]?.mesh.indexCount).toBe(3);
    expect(far[0]?.mesh.indexBuffer).toBe(handles.indexBuffer);
    expect(selectCpuLodRows(rows, cameraAt(40))[0]?.mesh).toBe(far[0]?.mesh);
    Object.assign(handles, { contentEpoch: handles.contentEpoch + 1 });
    const rewritten = selectCpuLodRows(rows, cameraAt(40));
    expect(rewritten[0]?.mesh.contentEpoch).toBe(handles.contentEpoch);
    expect(rewritten[0]?.mesh.indexBuffer).toBe(handles.indexBuffer);
    expect(rewritten[0]?.mesh).not.toBe(far[0]?.mesh);
    expect(selectCpuLodRows(rows, cameraAt(40))[0]?.mesh).toBe(rewritten[0]?.mesh);
  });

  it('reports the selected levels as an ascending histogram', () => {
    expect(lodLevelHistogram([1, 0, 1])).toEqual([
      { level: 0, count: 1 },
      { level: 1, count: 2 },
    ]);
    expect(lodLevelHistogram([])).toEqual([{ level: 0, count: 0 }]);
  });
});

describe('validated primary-view projection', () => {
  it('returns the retained rows when source identity, order and index already match', () => {
    const handles = mesh();
    const sources = Array.from({ length: 744 }, (_, entityKey) => source({ entityKey }));
    const rows = Object.freeze(
      sources.map((snapshot, index) =>
        Object.freeze({
          ...row(snapshot, handles),
          renderableIndex: index,
        }),
      ),
    );
    expect(projectValidatedRows(rows, sources)).toBe(rows);
    const moved = sources[371];
    if (moved === undefined) throw new Error('missing retained row');
    moved.transform.world[12] = 5;
    expect(projectValidatedRows(rows, sources)).toBe(rows);
    expect(rows[371]?.source.transform.world[12]).toBe(5);
    const empty = Object.freeze([]);
    expect(projectValidatedRows(empty, [])).toBe(empty);
  });

  it('remaps reordered equal entity IDs from distinct Worlds and preserves their resolved facts', () => {
    const left = source({ worldId: 0, entityKey: 7 });
    const right = source({ worldId: 1, entityKey: 7 });
    const rows = [
      { ...row(left, mesh()), stencilReference: 11 },
      { ...row(right, mesh()), renderableIndex: 1, stencilReference: 22 },
    ];
    const projected = projectValidatedRows(rows, [right, left]);
    expect(projected).not.toBe(rows);
    expect(projected).toEqual([
      { ...rows[1], source: right, renderableIndex: 0 },
      { ...rows[0], source: left, renderableIndex: 1 },
    ]);
    expect(projected[0]?.mesh).toBe(rows[1]?.mesh);
    expect(projected[1]?.mesh).toBe(rows[0]?.mesh);
    expect(rows.map((value) => value.renderableIndex)).toEqual([0, 1]);
  });

  it('keeps source replacement, subset gaps, missing records and index repair on the remap path', () => {
    const first = source({ entityKey: 1 });
    const second = source({ entityKey: 2 });
    const handles = mesh();
    const firstRow = row(first, handles);
    const rows = [firstRow, { ...row(second, handles), renderableIndex: 1 }];
    const replacement = { ...second, transform: { world: second.transform.world.slice() } };
    const replaced = projectValidatedRows(rows, [first, replacement]);
    expect(replaced).not.toBe(rows);
    expect(replaced[1]?.source).toBe(replacement);
    expect(replaced[1]?.mesh).toBe(handles);
    const subset = projectValidatedRows(rows, [source({ entityKey: 99 }), second]);
    expect(subset).toEqual([{ ...rows[1], renderableIndex: 1 }]);
    const wrongIndex = [{ ...firstRow, renderableIndex: 9 }];
    expect(projectValidatedRows(wrongIndex, [first])).toEqual([
      { ...firstRow, renderableIndex: 0 },
    ]);
    expect(wrongIndex[0]?.renderableIndex).toBe(9);
  });
});
