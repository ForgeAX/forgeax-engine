import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import { RecordingScenePose } from '../../scene/captured-transform';
import { SceneDrawSlot, slotDrawSnapshot } from '../../scene/mesh-draw';
import { MeshFrame } from '../../scene/mesh-frame';
import { SceneSlots } from '../../scene/scene-slots';
import { flushMeshDrawUploads, MeshDrawUploads, uploadMeshSsboBatch } from '../mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../render-context';

it('retries an unchanged mesh after its preceding upload was rejected', () => {
  const row = { ...receiptRow(), meshSlot: 0 };
  const buffer = {} as Buffer;
  const failure = new Error('queue rejected the write');
  const writeBuffer = vi.fn().mockReturnValueOnce(err(failure)).mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  expect(() => uploadMeshSsboBatch(queue, { buffer }, [row], null)).toThrow(failure);
  expect(uploadMeshSsboBatch(queue, { buffer }, [row], null)).toBe(1);
  expect(writeBuffer).toHaveBeenCalledTimes(2);
  expect(uploadMeshSsboBatch(queue, { buffer }, [row], null)).toBe(0);
});

it.each([
  false,
  true,
])('stages an isolated high mesh slot within its upload page (uniform pages=%s)', (paged) => {
  const slot = 65536;
  const row = { ...receiptRow(), meshSlot: slot };
  const buffer = {} as Buffer;
  const pages = {
    byteStride: 16384,
    byteSize: 16384,
    buffers: Array.from({ length: slot / 64 + 1 }, () => ({}) as Buffer),
  };
  const storage = paged ? { buffer: null, pages } : { buffer };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  expect(uploadMeshSsboBatch(queue, storage, [row], null)).toBe(1);
  const [target, offset, data, dataOffset, byteLength] = writeBuffer.mock.calls[0] ?? [];
  expect(target).toBe(paged ? pages.buffers[slot / 64] : buffer);
  expect(offset).toBe(paged ? 0 : slot * 256);
  expect(byteLength).toBe(256);
  expect(data.byteLength).toBe(256);
  expect(dataOffset).toBe(0);
});

it('retries disjoint pages and preserves staged transforms across backward page growth', () => {
  const storage = { buffer: {} as Buffer };
  const offsets = [8199, 8194, 5];
  const rows = offsets.map((meshSlot) => {
    const entry = receiptRow();
    const world = new Float32Array(entry.source.transform.world);
    world[12] = meshSlot;
    return { ...entry, meshSlot, source: { ...entry.source, transform: { world } } };
  });
  const failure = new Error('second write rejected');
  const accepted = new Map<number, number>();
  let writes = 0;
  const writeBuffer = vi.fn(
    (_buffer: Buffer, offset: number, data: Uint8Array, start: number, size: number) => {
      if (++writes === 2) return err(failure);
      const floats = new Float32Array(data.buffer, data.byteOffset + start, size / 4);
      for (let i = 0; i < size; i += 256)
        accepted.set((offset + i) / 256, floats[i / 4 + 12] as number);
      return ok(undefined);
    },
  );
  const queue = { writeBuffer } as unknown as RhiQueue;
  expect(() => uploadMeshSsboBatch(queue, storage, rows, null)).toThrow(failure);
  expect(flushMeshDrawUploads(queue, storage)).toBe(1);
  expect(writeBuffer).toHaveBeenCalledTimes(3);
  for (const slot of offsets) expect(accepted.get(slot)).toBe(slot);
  expect(uploadMeshSsboBatch(queue, storage, rows, null)).toBe(0);
});

it('retries all overlapping physical pages after a partial write failed', () => {
  const row = { ...receiptRow(), meshSlot: 1 };
  const pages = { byteStride: 256, byteSize: 512, buffers: [{} as Buffer, {} as Buffer] };
  const storage = { buffer: null, pages };
  const failure = new Error('second page rejected');
  const writeBuffer = vi
    .fn()
    .mockReturnValueOnce(ok(undefined))
    .mockReturnValueOnce(err(failure))
    .mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  expect(() => uploadMeshSsboBatch(queue, storage, [row], null)).toThrow(failure);
  expect(uploadMeshSsboBatch(queue, storage, [row], null)).toBe(1);
  expect(writeBuffer.mock.calls.map((call) => call[0])).toEqual([
    pages.buffers[0],
    pages.buffers[1],
    pages.buffers[0],
    pages.buffers[1],
  ]);
});

it('records the fixed material version after the shared resource advances', () => {
  const row = { ...receiptRow(), meshSlot: 0 };
  const resource = row.source.material;
  resource.adopt({ ...resource.snapshot, transparent: true });
  const current = vi.spyOn(resource, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('record read a live material');
  });
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  try {
    uploadMeshSsboBatch(queue, { buffer: {} as Buffer }, [row], null);
    const call = writeBuffer.mock.calls[0];
    const bytes = call?.[2] as Uint8Array;
    expect(new Float32Array(bytes.buffer, bytes.byteOffset)[32]).toBe(0);
  } finally {
    current.mockRestore();
  }
});

it('reads the pass ABI once and stages a repeated address into its replacement buffer', () => {
  const row = { ...receiptRow(), meshSlot: 0 };
  const first = {} as Buffer;
  const replacement = {} as Buffer;
  const storage = { buffer: first };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  const readCaps = vi.fn(() => ({ storageBuffer: true }));
  const c = {
    runtime: {
      device: {
        get caps() {
          return readCaps();
        },
      },
    },
    pipelineState: { meshStorageBuffer: storage },
  } as _InternalRenderPipelineContext;

  const uploads = MeshDrawUploads.forPass(c);
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, storage)).toBe(1);
  for (let index = 0; index < 128; index++) uploads.stage(row);
  expect(flushMeshDrawUploads(queue, storage)).toBe(0);

  storage.buffer = replacement;
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, storage)).toBe(1);
  expect(writeBuffer.mock.calls.map(([buffer]) => buffer)).toEqual([first, replacement]);
  storage.buffer = first;
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, storage)).toBe(0);
  expect(readCaps).toHaveBeenCalledTimes(1);
});

it('does no Mesh packing or upload for a shared material edit across 10000 actual draws', () => {
  const source = receiptRow().source;
  const matrix = source.transform.world;
  const readMatrix = vi.fn(() => matrix);
  const transform = {
    get world() {
      return readMatrix();
    },
  };
  const spriteRegion = [0.125, 0.25, 0.5, 0.75] as const;
  const rows = Array.from({ length: 10000 }, (_, meshSlot) => ({
    meshSlot,
    source: { ...source, transform, spriteRegion, entityKey: meshSlot },
  }));
  const buffer = {} as Buffer;
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  const c = {
    runtime: { device: { queue, caps: { storageBuffer: true } } },
    pipelineState: { meshStorageBuffer: { buffer } },
  } as _InternalRenderPipelineContext;
  const uploads = MeshDrawUploads.forPass(c);
  for (const row of rows) uploads.stage(row);
  expect(flushMeshDrawUploads(queue, { buffer })).toBe(1);
  expect(readMatrix).toHaveBeenCalledTimes(10000);
  const resource = source.material;
  resource.adopt({
    ...resource.snapshot,
    transparent: true,
    paramSnapshot: { flipX: 1, flipY: 1 },
  });
  const live = vi.spyOn(resource, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('draw reopened material root');
  });
  readMatrix.mockClear();
  writeBuffer.mockClear();
  try {
    for (const row of rows) uploads.stage(row);
    expect(flushMeshDrawUploads(queue, { buffer })).toBe(0);
    expect(readMatrix).not.toHaveBeenCalled();
    expect(writeBuffer).not.toHaveBeenCalled();
    // Actual source replacement is the falsifier: its changed transform still uploads.
    const changed = new Float32Array(matrix);
    changed[12] = 3;
    uploads.stage({
      meshSlot: 0,
      source: { ...source, transform: { world: changed }, spriteRegion },
    });
    expect(flushMeshDrawUploads(queue, { buffer })).toBe(1);
    const bytes = writeBuffer.mock.calls[0]?.[2] as Uint8Array;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
    expect(floats[12]).toBe(3);
    expect(Array.from(floats.subarray(40, 44))).toEqual(spriteRegion);
  } finally {
    live.mockRestore();
  }
});

it.each([
  true,
  false,
])('keeps Sprite overrides in their actual Mesh ABI (storage=%s)', (storageBuffer) => {
  const source = receiptRow().source;
  const spriteRegion = [0.125, 0.25, 0.5, 0.75] as const;
  const row = { meshSlot: 0, source: { ...source, spriteRegion } };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  uploadMeshSsboBatch(queue, { buffer: {} as Buffer }, [row], null, [], undefined, storageBuffer);
  const bytes = writeBuffer.mock.calls[0]?.[2] as Uint8Array;
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
  const bits = new Uint32Array(bytes.buffer, bytes.byteOffset);
  const surface = storageBuffer ? 36 : 16;
  expect(Array.from(bits.subarray(surface, surface + 4))).toEqual([0, 0, 0xffffffff, 1]);
  expect(Array.from(floats.subarray(surface + 4, surface + 8))).toEqual(spriteRegion);
});

it.each([true, false])('uploads draw parameters by physical slot (storage=%s)', (storageBuffer) => {
  const source = receiptRow().source;
  const supplied = [1, 0.25, 0, 0.5, 7, 0.75, 0, 0];
  let values: readonly number[] | undefined = supplied;
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  const buffer = { buffer: {} as Buffer };
  const c = {
    runtime: { device: { queue, caps: { storageBuffer } } },
    pipelineState: { meshStorageBuffer: buffer },
    world: {
      drawParameters: (entity: number) => (entity === source.entityKey ? values : undefined),
    },
  } as _InternalRenderPipelineContext;
  const row = { meshSlot: 1, source };
  const uploads = MeshDrawUploads.forPass(c);
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, buffer)).toBe(1);
  const bytes = writeBuffer.mock.calls[0]?.[2] as Uint8Array;
  expect(writeBuffer.mock.lastCall?.[1]).toBe(256);
  const floats = new Float32Array(
    bytes.buffer,
    bytes.byteOffset + (writeBuffer.mock.lastCall?.[3] as number),
  );
  const offset = storageBuffer ? 44 : 24;
  expect(Array.from(floats.subarray(offset, offset + 8))).toEqual(values);
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, buffer)).toBe(0);
  supplied[0] = 2.5;
  supplied[7] = -0;
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, buffer)).toBe(1);
  expect(floats[offset]).toBe(2.5);
  expect(Object.is(floats[offset + 7], -0)).toBe(true);
  values = undefined;
  uploads.stage(row);
  expect(flushMeshDrawUploads(queue, buffer)).toBe(1);
  expect(Array.from(floats.subarray(offset, offset + 8))).toEqual(Array(8).fill(0));
});

it.each([
  false,
  true,
])('keeps uniform shadow flags independent of Sprite region presence (%s)', (hasRegion) => {
  const source = receiptRow().source;
  const region = [0.125, 0.25, 0.5, 0.75] as const;
  const buffer = {} as Buffer;
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  for (const receive of [false, true, false]) {
    const row = {
      meshSlot: 0,
      source: {
        ...source,
        ...(receive ? {} : { shadowReceiver: false as const }),
        ...(hasRegion ? { spriteRegion: region } : {}),
      },
    };
    uploadMeshSsboBatch(queue, { buffer }, [row], null, [], undefined, false);
    const bytes = writeBuffer.mock.lastCall?.[2] as Uint8Array;
    const bits = new Uint32Array(bytes.buffer, bytes.byteOffset);
    expect(bits[19]).toBe(Number(hasRegion) | (receive ? 0 : 2));
    expect((bits[19] ?? 0) & 1).toBe(Number(hasRegion));
  }
});

it('uploads changing captured poses straight from their columns and opens public matrix windows on demand', () => {
  const { source } = receiptRow();
  const slots = new SceneSlots();
  const meshes = new MeshFrame();
  const pose = new Float32Array(source.transform.world);
  const buffer = { buffer: {} as Buffer };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  setSceneRow(slots, 1, { snapshot: source, entityKey: 5, generation: 0 });
  let currentColumn: Float32Array | undefined;
  let windows = 0;
  const original = Float32Array.prototype.slice;
  const slice = vi.spyOn(Float32Array.prototype, 'slice').mockImplementation(function (
    this: Float32Array,
    start,
    end,
  ) {
    if (this === currentColumn) windows++;
    return original.call(this, start, end);
  });
  const transform = vi.spyOn(SceneDrawSlot.prototype, 'transform', 'get');
  try {
    let inspected: typeof source | undefined;
    let first: { meshSlot: number; sceneSlot: SceneDrawSlot; source: typeof source } | undefined;
    for (let frame = 1; frame <= 60; frame++) {
      pose[0] = frame % 2 ? -1 : 1;
      pose[12] = frame;
      const record = slots.writePose(1, pose);
      if (!(record instanceof SceneDrawSlot)) throw new Error('expected a captured numeric row');
      currentColumn = record.poseColumn;
      const draw = slotDrawSnapshot(record, meshes);
      const row = { meshSlot: 0, sceneSlot: record, source: draw };
      expect(uploadMeshSsboBatch(queue, buffer, [row], null)).toBe(1);
      const bytes = writeBuffer.mock.lastCall?.[2] as Uint8Array;
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
      expect([floats[0], floats[12], floats[16], floats[28]]).toEqual([
        pose[0],
        frame,
        pose[0],
        frame,
      ]);
      expect(uploadMeshSsboBatch(queue, buffer, [row], null)).toBe(0);
      first ??= row;
      if (frame === 60) inspected = draw;
      slots.capture();
    }
    expect(transform).not.toHaveBeenCalled();
    expect(windows).toBe(0);
    if (first === undefined) throw new Error('expected an issued draw');
    expect(uploadMeshSsboBatch(queue, buffer, [first], null)).toBe(1);
    const bytes = writeBuffer.mock.lastCall?.[2] as Uint8Array;
    expect(new Float32Array(bytes.buffer, bytes.byteOffset)[12]).toBe(1);
    expect(transform).not.toHaveBeenCalled();
    expect({ ...first.source }.transform.world[12]).toBe(1);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(Object.keys(inspected?.transform ?? {})).toEqual(['world']);
    const matrix = { ...inspected?.transform }.world;
    expect(matrix?.[12]).toBe(60);
    expect(inspected?.transform.world).toBe(matrix);
    expect(matrix?.buffer).not.toBe(currentColumn?.buffer);
    expect(windows).toBe(1);
  } finally {
    transform.mockRestore();
    slice.mockRestore();
  }
});

it('stages replacement scenes and view-owned surface overrides at a reused mesh address', () => {
  const { source } = receiptRow();
  const meshes = new MeshFrame();
  const storage = { buffer: {} as Buffer };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  const draw = (x: number) => {
    const world = new Float32Array(source.transform.world);
    world[12] = x;
    const slots = new SceneSlots();
    const record = setSceneRow(slots, 0, {
      generation: 0,
      entityKey: source.entityKey,
      snapshot: { ...source, transform: { world } },
    });
    if (record === undefined) throw new Error('missing captured source');
    return { meshSlot: 0, sceneSlot: record, source: slotDrawSnapshot(record, meshes) };
  };
  const first = draw(5);
  const second = draw(11);
  expect(first.sceneSlot.version).toBe(second.sceneSlot.version);
  for (const row of [
    first,
    second,
    { ...second, source: { ...second.source, lightingChannels: 8 } },
    second,
    first,
  ]) {
    expect(uploadMeshSsboBatch(queue, storage, [row], null)).toBe(1);
    const bytes = writeBuffer.mock.lastCall?.[2] as Uint8Array;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
    const bits = new Uint32Array(bytes.buffer, bytes.byteOffset);
    expect(floats[12]).toBe(row.source.transform.world[12]);
    expect(bits[38]).toBe(row.source.lightingChannels ?? 0xffffffff);
  }
});

it('shares the physical upload stamp between borrowed poses and retained Scene draws', () => {
  const { source } = receiptRow();
  const slots = new SceneSlots();
  const placed = setSceneRow(slots, 67, {
    snapshot: source,
    entityKey: source.entityKey,
    generation: 0,
  });
  if (!(placed instanceof SceneDrawSlot)) throw Error('Missing placed Scene row');
  slots.capture();
  const placedDraw = placed.authoredSnapshot();
  const borrowed = new RecordingScenePose();
  const matrix = source.transform.world.slice();
  const buffer = { buffer: {} as Buffer };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  for (let revision = 1; revision <= 48; revision++) {
    matrix[0] = revision % 2 === 0 ? 1 : -1;
    matrix[12] = revision;
    slots.writePreparedPose(67, matrix, 0, 1);
    const current = slots.capture();
    expect(current.borrowReplacementPose(placed, borrowed)).toBe(true);
    const row = { meshSlot: 0, sceneSlot: placed, source: placedDraw, recordingPose: borrowed };
    expect(uploadMeshSsboBatch(queue, buffer, [row], null)).toBe(1);
    const bytes = writeBuffer.mock.lastCall?.[2] as Uint8Array;
    const values = new Float32Array(bytes.buffer, bytes.byteOffset);
    expect([values[0], values[12], values[16], values[28]]).toEqual([
      matrix[0],
      revision,
      matrix[0],
      revision,
    ]);
    const record = current.slotAt(67);
    if (!(record instanceof SceneDrawSlot)) throw Error('Missing materialized Scene row');
    const retained = { meshSlot: 0, sceneSlot: record, source: record.authoredSnapshot() };
    expect(uploadMeshSsboBatch(queue, buffer, [retained], null)).toBe(0);
  }
  slots.remove(67);
  setSceneRow(slots, 67, { snapshot: source, entityKey: source.entityKey, generation: 1 });
  expect(slots.capture().borrowReplacementPose(placed, borrowed)).toBe(false);
});
