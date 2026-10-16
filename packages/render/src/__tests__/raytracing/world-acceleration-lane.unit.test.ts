import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder, RhiDevice, RhiRayQueryCaps } from '@forgeax/engine-rhi';
import { RhiNullAdapter, type RhiNullDevice } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { addWorldAccelerationPass } from '../../raytracing/irradiance-field-graph';
import { kernelGraphAccess } from '../../raytracing/kernel-graph-access';
import {
  prepareWorldAcceleration,
  selectWorldTraversal,
  WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME,
  worldAccelerationGeometries,
} from '../../raytracing/renderer-world-acceleration';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import type { WorldAccelerationGeometry } from '../../raytracing/world-acceleration';
import { WORLD_TRAVERSAL_ROSTER } from '../../raytracing/world-traversal';

const LIMITS = {
  maxBlasGeometryCount: 4,
  maxBlasPrimitiveCount: 8,
  maxTlasInstanceCount: 16,
  maxAccelerationStructuresPerShaderStage: 1,
};
const SUPPORTED: RhiRayQueryCaps = { supported: true, ...LIMITS };

async function device(rayQuery: boolean): Promise<RhiDevice> {
  const adapter = new RhiNullAdapter(rayQuery ? { rayQuery: LIMITS } : {});
  return (await adapter.requestDevice()).unwrap();
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const triangle = (geometryId: number): WorldAccelerationGeometry => ({
  geometryId,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
});
const instance = (instanceId: number, geometryId: number): SdfMeshInstance => ({
  instanceId,
  geometryId,
  mask: 255,
  transform: IDENTITY,
  field: { missing: true, bounds: { min: [0, 0, 0], max: [1, 1, 0] } } as SdfMeshInstance['field'],
});

describe('world traversal lane selection', () => {
  it('selects ray-query only when supported and the scene fits caps.rayQuery', () => {
    const geometries = [triangle(0)];
    expect(selectWorldTraversal(SUPPORTED, 3, geometries)).toEqual({ traversal: 'ray-query' });
    expect(
      selectWorldTraversal({ supported: false, reason: 'backend-has-no-ray-query' }, 3, geometries),
    ).toEqual({ traversal: 'global-sdf', fallback: 'backend-has-no-ray-query' });
    expect(selectWorldTraversal(SUPPORTED, LIMITS.maxTlasInstanceCount + 1, geometries)).toEqual({
      traversal: 'global-sdf',
      fallback: 'scene-exceeds-ray-query-limits',
    });
    const dense = {
      geometryId: 1,
      positions: new Float32Array(9 * (LIMITS.maxBlasPrimitiveCount + 1)),
    };
    expect(selectWorldTraversal(SUPPORTED, 1, [dense])).toEqual({
      traversal: 'global-sdf',
      fallback: 'scene-exceeds-ray-query-limits',
    });
  });

  it('derives one geometry per projected geometryId', () => {
    const mesh = { attributes: { position: triangle(0).positions } };
    const geometries = worldAccelerationGeometries({
      instances: [instance(0, 0), instance(1, 0), instance(2, 1)],
      sources: [
        { mesh, firstInstance: 0 },
        { mesh, firstInstance: 1 },
        { mesh, firstInstance: 2 },
      ] as never,
    });
    expect(geometries.map((geometry) => geometry.geometryId)).toEqual([0, 1]);
  });
});

describe('prepared world acceleration', () => {
  const scene = (geometryCount: number) => {
    const geometries = Array.from({ length: geometryCount }, (_, i) => triangle(i));
    return {
      geometries,
      region: { instances: geometries.map((g, i) => instance(i, g.geometryId)) },
    };
  };

  it('budgets from the projected scene and settles only after submitted BLAS builds', async () => {
    const rhi = await device(true);
    const count = WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME + 2;
    const { geometries, region } = scene(count);
    const prepared = prepareWorldAcceleration(rhi, region, geometries).unwrap();
    expect([prepared.maxInstances, prepared.maxTriangles]).toEqual([count, count]);
    const frame = () => rhi.createCommandEncoder({}).unwrap();
    prepared.record(frame()).unwrap();
    prepared.commit();
    expect(prepared.inspect()).toEqual({
      instances: count,
      geometries: count,
      pending: count - WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME,
      settled: false,
      blasBuilt: WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME,
      tlasBuilt: 1,
      // One triangle BLAS = 36 B positions + 12 B indices; one TLAS instance = 64 B.
      bytesBuilt: WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME * (48 + 64),
    });
    prepared.record(frame()).unwrap();
    expect(prepared.settled()).toBe(false);
    prepared.commit();
    expect(prepared.inspect()).toMatchObject({ pending: 0, settled: true });
    prepared.dispose();
    expect((rhi as RhiNullDevice).bookkeeper.isDestroyed(prepared.current().tlas)).toBe(true);
  });

  it('recreates after a failed submit and retires the old TLAS after in-flight work', async () => {
    const rhi = await device(true);
    const { geometries, region } = scene(1);
    const prepared = prepareWorldAcceleration(rhi, region, geometries).unwrap();
    const first = prepared.current().tlas;
    let complete: () => void = () => undefined;
    prepared.record(rhi.createCommandEncoder({}).unwrap()).unwrap();
    prepared.track(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    // No commit: the encoded update never reached the queue.
    prepared.record(rhi.createCommandEncoder({}).unwrap()).unwrap();
    const second = prepared.current().tlas;
    expect(second).not.toBe(first);
    expect((rhi as RhiNullDevice).bookkeeper.isDestroyed(first)).toBe(false);
    complete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((rhi as RhiNullDevice).bookkeeper.isDestroyed(first)).toBe(true);
    prepared.commit();
    expect(prepared.inspect()).toMatchObject({ pending: 0, settled: true });
    prepared.dispose();
  });
});

describe('in-place world acceleration edits', () => {
  const settle = (rhi: RhiDevice, prepared: ReturnType<typeof prepareWorldAcceleration>) => {
    const lane = prepared.unwrap();
    lane.record(rhi.createCommandEncoder({}).unwrap()).unwrap();
    lane.commit();
    return lane.inspect();
  };
  const moved = (index: number, x: number) => ({
    index,
    to: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]),
  });

  it('rebuilds only the TLAS on moves and removals and builds a BLAS per new mesh only', async () => {
    const rhi = await device(true);
    const geometries = [triangle(0)];
    const region = { instances: [instance(0, 0), instance(1, 0)] };
    const made = prepareWorldAcceleration(rhi, region, geometries, {
      instances: 4,
      triangles: 2,
    });
    const lane = made.unwrap();
    expect([lane.maxInstances, lane.maxTriangles]).toEqual([4, 3]);
    expect(settle(rhi, made)).toMatchObject({ blasBuilt: 1, tlasBuilt: 1, settled: true });

    lane.edit({ moved: [moved(1, 2)], removed: [], added: [] }).unwrap();
    expect(lane.settled()).toBe(false);
    expect(settle(rhi, made)).toMatchObject({
      instances: 2,
      blasBuilt: 1,
      tlasBuilt: 2,
      bytesBuilt: 48 + 128 + 128,
      settled: true,
    });

    // A second instance of a resident mesh reuses its BLAS; a new mesh builds one.
    const add = (row: number, geometry: WorldAccelerationGeometry) => ({
      instance: {
        instanceId: row,
        geometryId: geometry.geometryId,
        mask: 255,
        transform: IDENTITY,
      },
      geometry,
    });
    lane
      .edit({ moved: [], removed: [], added: [add(2, triangle(0)), add(3, triangle(1))] })
      .unwrap();
    expect(settle(rhi, made)).toMatchObject({
      instances: 4,
      geometries: 2,
      blasBuilt: 2,
      tlasBuilt: 3,
      settled: true,
    });

    lane.edit({ moved: [], removed: [{ index: 0 }], added: [] }).unwrap();
    expect(settle(rhi, made)).toMatchObject({ instances: 3, blasBuilt: 2, tlasBuilt: 4 });
    lane.dispose();
  });

  it('rejects deltas past the headroom without touching the roster', async () => {
    const rhi = await device(true);
    const made = prepareWorldAcceleration(rhi, { instances: [instance(0, 0)] }, [triangle(0)], {
      instances: 2,
      triangles: 1,
    });
    const lane = made.unwrap();
    settle(rhi, made);
    const add = (row: number, geometryId: number) => ({
      instance: { instanceId: row, geometryId, mask: 255, transform: IDENTITY },
      geometry: triangle(geometryId),
    });
    const crowded = lane.edit({ moved: [], removed: [], added: [add(1, 0), add(2, 0)] });
    expect(crowded.ok ? undefined : crowded.error.code).toBe('ray-reference-limit');
    const dense = lane.edit({ moved: [], removed: [], added: [add(1, 1), add(2, 2)] });
    expect(dense.ok ? undefined : dense.error.code).toBe('ray-reference-limit');
    expect(lane.inspect()).toMatchObject({ instances: 1, geometries: 1, settled: true });
    lane.dispose();
  });

  it('keeps the build pass open when an edit lands after the frame encoded its update', async () => {
    const rhi = await device(true);
    const made = prepareWorldAcceleration(rhi, { instances: [instance(0, 0)] }, [triangle(0)]);
    const lane = made.unwrap();
    lane.record(rhi.createCommandEncoder({}).unwrap()).unwrap();
    lane.edit({ moved: [moved(0, 1)], removed: [], added: [] }).unwrap();
    lane.commit();
    expect(lane.settled()).toBe(false);
    expect(settle(rhi, made)).toMatchObject({ tlasBuilt: 2, settled: true });
    lane.dispose();
  });
});

describe('world acceleration graph pass', () => {
  interface Frame {
    readonly encoder: RhiCommandEncoder;
  }

  it('orders ray-query traces after the TLAS build and skips the build once settled', async () => {
    const rhi = await device(true);
    const geometries = [triangle(0)];
    const region = { instances: [instance(0, 0)] };
    const prepared = prepareWorldAcceleration(rhi, region, geometries).unwrap();
    const graph = new RenderGraphBuilder<Frame>();
    let records = 0;
    const counted = {
      ...prepared,
      record: (encoder: RhiCommandEncoder) => {
        records++;
        return prepared.record(encoder);
      },
    };
    const handles = addWorldAccelerationPass(graph, prepared, () => counted).unwrap();
    const output = graph.createBuffer('traced', { size: 16 }).unwrap();
    graph
      .addComputePass('trace', {
        accesses: [
          ...WORLD_TRAVERSAL_ROSTER['ray-query'].map(([, kind, name]) => {
            const handle = handles[name as keyof typeof handles];
            if (handle === undefined) throw new Error(`missing ${name}`);
            return kernelGraphAccess(kind, handle, 'storage-write');
          }),
          { resource: output, usage: 'storage-write' },
        ],
        encode: ({ resources }) => {
          if (handles.tlas === undefined) throw new Error('missing tlas');
          expect(resources.accelerationStructure(handles.tlas as never).unwrap()).toBe(
            prepared.current().tlas,
          );
        },
      })
      .unwrap();
    const compiled = graph.compile({ device: rhi, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const passes = compiled.inspect().passes;
    expect(passes.map((pass) => [pass.name, pass.dependencies])).toEqual([
      ['irradiance-field.world-acceleration', []],
      ['trace', ['irradiance-field.world-acceleration']],
    ]);
    expect(compiled.execute({ encoder: rhi.createCommandEncoder({}).unwrap() }).ok).toBe(true);
    const abandoned = prepared.current().tlas;
    // The next execution must freeze the recovered handles before its build,
    // coverage copy and trace. The trace above checks the actual Graph binding.
    expect(compiled.execute({ encoder: rhi.createCommandEncoder({}).unwrap() }).ok).toBe(true);
    expect(prepared.current().tlas).not.toBe(abandoned);
    prepared.commit();
    expect([records, prepared.settled()]).toEqual([2, true]);
    expect(compiled.execute({ encoder: rhi.createCommandEncoder({}).unwrap() }).ok).toBe(true);
    expect(records).toBe(2);
    expect((await compiled.retire()).ok).toBe(true);
    prepared.dispose();
  });

  it('declares nothing on the Global SDF lane', () => {
    const graph = new RenderGraphBuilder<Frame>();
    expect(
      addWorldAccelerationPass(graph, undefined, () => {
        throw new Error('unreachable');
      }).unwrap(),
    ).toEqual({});
  });
});
