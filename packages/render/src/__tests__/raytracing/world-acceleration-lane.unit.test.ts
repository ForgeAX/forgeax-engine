import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  RhiCommandEncoder,
  RhiDevice,
  RhiRayQueryCaps,
  TlasInstance,
} from '@forgeax/engine-rhi';
import { RhiNullAdapter, type RhiNullDevice } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { addWorldAccelerationPass } from '../../raytracing/irradiance-field-graph';
import { kernelGraphAccess } from '../../raytracing/kernel-graph-access';
import {
  type PreparedWorldAcceleration,
  prepareWorldAcceleration,
  selectWorldTraversal,
  WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME,
  type WorldAccelerationEdit,
  WorldAccelerationGeometryIds,
  worldAccelerationRoster,
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

  it('keys one geometry per mesh payload version across its instances', () => {
    const mesh = { attributes: { position: triangle(0).positions } };
    const other = { attributes: { position: triangle(0).positions } };
    const ids = new WorldAccelerationGeometryIds();
    const source = (m: object, assetRevision: number, firstInstance: number, count = 1) =>
      ({
        mesh: m,
        assetRevision,
        firstInstance,
        instances: count === 1 ? undefined : { instanceCount: count },
      }) as never;
    const roster = worldAccelerationRoster(
      {
        instances: [instance(0, 0), instance(1, 0), instance(2, 1), instance(3, 1)],
        sources: [source(mesh, 1, 0, 2), source(other, 1, 2), source(mesh, 2, 3)],
      },
      ids,
    );
    expect(roster.instances.map((i) => i.geometryId)).toEqual([0, 0, 1, 2]);
    expect(roster.geometries.map((geometry) => geometry.geometryId)).toEqual([0, 1, 2]);
    // The same payload version keeps its id in a later roster; a new revision does not.
    expect(ids.id(mesh, 1)).toBe(0);
    expect(ids.id(mesh, 3)).toBe(3);
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
    const built = WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME;
    expect(prepared.inspect()).toEqual({
      instances: count,
      geometries: count,
      pending: count - built,
      settled: false,
      blasBuilt: built,
      tlasBuilt: 1,
      // One triangle BLAS = 36 B positions + 12 B indices; one TLAS instance = 64 B.
      bytesBuilt: built * (48 + 64),
      // Row 0 (pending count) plus one 16 B row per traced instance.
      rowsWritten: built + 1,
      // BLAS inputs and one 16 B face normal per built mesh, plus the written rows.
      bytesUploaded: built * (48 + 16) + (built + 1) * 16,
      recordsPatched: built,
      blasReleased: 0,
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

  it('keeps a BLAS when its only instance is removed and re-added in one edit', async () => {
    const rhi = await device(true);
    const made = prepareWorldAcceleration(rhi, { instances: [instance(0, 0)] }, [triangle(0)], {
      instances: 4,
      triangles: 2,
    });
    const lane = made.unwrap();
    expect(settle(rhi, made)).toMatchObject({ geometries: 1, blasBuilt: 1, settled: true });
    const geometry = triangle(0);
    lane
      .edit({
        moved: [],
        removed: [{ index: 0 }],
        added: [
          {
            instance: {
              instanceId: 5,
              geometryId: geometry.geometryId,
              mask: 255,
              transform: IDENTITY,
            },
            geometry,
          },
        ],
      })
      .unwrap();
    expect(settle(rhi, made)).toMatchObject({
      instances: 1,
      geometries: 1,
      blasBuilt: 1,
      blasReleased: 0,
      settled: true,
    });
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

describe('incremental world acceleration', () => {
  const WIDE = {
    maxBlasGeometryCount: 4,
    maxBlasPrimitiveCount: 64,
    maxTlasInstanceCount: 1 << 16,
    maxAccelerationStructuresPerShaderStage: 1,
  };
  const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const GEOMETRIES = 24;

  /** A Ray Query null device whose TLAS records, table rows and BLAS identities are observable. */
  async function observed() {
    const rhi = (await new RhiNullAdapter({ rayQuery: WIDE }).requestDevice()).unwrap();
    const tables = new Map<unknown, Uint32Array>();
    const records = new Map<unknown, readonly TlasInstance[]>();
    const labels = new Map<unknown, string>();
    const createBlas = rhi.createBlas.bind(rhi);
    rhi.createBlas = (desc) => {
      const made = createBlas(desc);
      if (made.ok) labels.set(made.value, desc.label ?? '');
      return made;
    };
    const queue = rhi.queue;
    const write = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (buffer, offset, data, ...rest) => {
      const view = data as ArrayBufferView;
      if (view.byteLength % 4 === 0 && offset % 4 === 0) {
        let image = tables.get(buffer);
        const end = offset / 4 + view.byteLength / 4;
        if (image === undefined || image.length < end) {
          const grown = new Uint32Array(Math.max(end, (image?.length ?? 0) * 2));
          if (image !== undefined) grown.set(image);
          image = grown;
          tables.set(buffer, image);
        }
        image.set(new Uint32Array(view.buffer, view.byteOffset, view.byteLength / 4), offset / 4);
      }
      return write(buffer, offset, data, ...rest);
    };
    const frame = () => {
      const encoder = rhi.createCommandEncoder({}).unwrap();
      const build = encoder.buildAccelerationStructures.bind(encoder);
      encoder.buildAccelerationStructures = (blas, tlas) => {
        for (const entry of tlas) records.set(entry.tlas, entry.instances.slice());
        return build(blas, tlas);
      };
      return encoder;
    };
    /** instanceId -> geometry, mask and transform the GPU would trace; plus row 0. */
    const traced = (lane: PreparedWorldAcceleration) => {
      const world = lane.current();
      const table = tables.get(world.traversalInstances) ?? new Uint32Array(4);
      const out = new Map<number, string>();
      for (const record of records.get(world.tlas) ?? []) {
        const id = table[record.customIndex * 4] ?? -1;
        out.set(
          id,
          JSON.stringify([labels.get(record.blas), record.mask, Array.from(record.transform)]),
        );
      }
      return { pending: table[0], instances: out };
    };
    const settle = (lane: PreparedWorldAcceleration) => {
      for (let frames = 0; !lane.settled(); frames++) {
        if (frames > 64) throw new Error('world acceleration never settled');
        lane.record(frame()).unwrap();
        lane.track(Promise.resolve());
        lane.commit();
      }
      return lane.inspect();
    };
    return { rhi, frame, traced, settle };
  }

  const triangleOf = (geometryId: number): WorldAccelerationGeometry => ({
    geometryId,
    positions: new Float32Array([0, 0, 0, 1 + geometryId, 0, 0, 0, 1, 0]),
  });
  const roster = (count: number) => {
    const instances = Array.from({ length: count }, (_, id) => ({
      instanceId: id,
      geometryId: id % GEOMETRIES,
      mask: 255,
      transform: at(id),
    }));
    return {
      instances,
      geometries: Array.from({ length: GEOMETRIES }, (_, id) => triangleOf(id)),
    };
  };

  /** CPU-side work and uploads of one edit, independent of N. */
  async function editWork(count: number) {
    const o = await observed();
    const { instances, geometries } = roster(count);
    const lane = prepareWorldAcceleration(o.rhi, { instances }, geometries, {
      instances: count + 64,
      triangles: 64,
    }).unwrap();
    let before = o.settle(lane);
    const delta = (edit: WorldAccelerationEdit): Record<string, number> => {
      lane.edit(edit).unwrap();
      const after = o.settle(lane);
      const work = Object.fromEntries(
        (
          [
            'blasBuilt',
            'tlasBuilt',
            'rowsWritten',
            'bytesUploaded',
            'recordsPatched',
            'blasReleased',
          ] as const
        ).map((key) => [key, after[key] - before[key]]),
      );
      before = after;
      return work;
    };
    const D = 8;
    const ids = Array.from({ length: D }, (_, k) => Math.floor(((k + 0.5) * count) / D));
    const moved = delta({
      moved: ids.map((index) => ({ index, to: at(-index) })),
      removed: [],
      added: [],
    });
    const removed = delta({ moved: [], removed: ids.map((index) => ({ index })), added: [] });
    const added = delta({
      moved: [],
      removed: [],
      added: ids.map((id) => ({
        instance: { instanceId: count + id, geometryId: 900, mask: 255, transform: at(id) },
        geometry: triangleOf(900),
      })),
    });
    // Every instance of one mesh leaves: its BLAS is released, nothing is rebuilt.
    const last = instances.filter(
      (i) => i.geometryId === GEOMETRIES - 1 && !ids.includes(i.instanceId),
    );
    const released = delta({
      moved: [],
      removed: last.map((i) => ({ index: i.instanceId })),
      added: [],
    });
    lane.dispose();
    return { moved, removed, added, released, removedInstances: last.length };
  }

  it('patches only the D changed records and rows, independently of N', async () => {
    const small = await editWork(1024);
    const large = await editWork(8192);
    expect(small.moved).toEqual({
      blasBuilt: 0,
      tlasBuilt: 1,
      rowsWritten: 8,
      bytesUploaded: 8 * 16,
      recordsPatched: 8,
      blasReleased: 0,
    });
    // Removals swap at most one trailing record into each vacated row.
    expect(small.removed.recordsPatched).toBeLessThanOrEqual(8);
    expect(small.removed.rowsWritten).toBeLessThanOrEqual(8);
    // Adds of one new mesh build exactly one BLAS: 36 + 12 B inputs + 16 B normal.
    expect(small.added).toMatchObject({ blasBuilt: 1, recordsPatched: 8, rowsWritten: 8 });
    expect(small.added.bytesUploaded).toBe(36 + 12 + 16 + 8 * 16);
    expect(small.released).toMatchObject({ blasBuilt: 0, blasReleased: 1 });
    expect(large.moved).toEqual(small.moved);
    expect(large.removed).toEqual(small.removed);
    expect(large.added).toEqual(small.added);
    // The released mesh's instance count grows with N; its own removals are its D.
    expect(large.released.recordsPatched).toBeLessThanOrEqual(large.removedInstances);
    expect(large.released.blasReleased).toBe(1);
  });

  it('recovers to exactly the incrementally edited state through the cold path', async () => {
    const o = await observed();
    const count = 512;
    const { instances, geometries } = roster(count);
    const lane = prepareWorldAcceleration(o.rhi, { instances }, geometries, {
      instances: count + 64,
      triangles: 64,
    }).unwrap();
    o.settle(lane);
    const removed = new Set([3, 77, 200, 511]);
    lane
      .edit({
        moved: [5, 77, 300].map((index) => ({ index, to: at(1000 + index) })),
        removed: [...removed].map((index) => ({ index })),
        added: [600, 601].map((instanceId) => ({
          instance: { instanceId, geometryId: 900, mask: 7, transform: at(instanceId) },
          geometry: triangleOf(900),
        })),
      })
      .unwrap();
    o.settle(lane);
    const incremental = o.traced(lane);
    expect(incremental.pending).toBe(0);
    expect(incremental.instances.size).toBe(count - removed.size + 2);

    // A failed submit: the encoded update never commits, so the next frame recovers.
    lane.record(o.frame()).unwrap();
    const abandoned = lane.current().tlas;
    lane.beginFrame().unwrap();
    expect(lane.current().tlas).not.toBe(abandoned);
    const recovered = o.settle(lane);
    expect(o.traced(lane)).toEqual(incremental);
    expect(recovered).toMatchObject({ instances: incremental.instances.size, pending: 0 });

    // A fresh lane over the final roster traces the identical instances.
    const final = [
      ...instances
        .filter((i) => !removed.has(i.instanceId))
        .map((i) =>
          [5, 300].includes(i.instanceId) ? { ...i, transform: at(1000 + i.instanceId) } : i,
        ),
      ...[600, 601].map((instanceId) => ({
        instanceId,
        geometryId: 900,
        mask: 7,
        transform: at(instanceId),
      })),
    ];
    const fresh = prepareWorldAcceleration(o.rhi, { instances: final }, [
      ...geometries,
      triangleOf(900),
    ]).unwrap();
    o.settle(fresh);
    expect(o.traced(fresh)).toEqual(incremental);
    lane.dispose();
    fresh.dispose();
  });
});
