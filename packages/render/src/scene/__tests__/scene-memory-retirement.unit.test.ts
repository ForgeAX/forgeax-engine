import { assert, expect, it, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { CONTENT_BOX, RowChangeLog } from '../row-change-log';
import { RowContents } from '../row-contents';
import { SceneRows } from '../scene-rows';

/** Count actual private backing edges, without depending on GC scheduling. */
function numericBytes(owner: object): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const value of Object.values(owner))
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

function cullingBoundsBytes(rows: SceneRows): number {
  const pages = Reflect.get(rows, 'bounds') as Map<number, object>;
  let bytes = 0;
  for (const page of pages.values()) bytes += numericBytes(page);
  expect(rows.cullingBoundsBackingBytes).toBe(bytes);
  return bytes;
}

it('resets grown row and box journals to cold capacity without reusing cursor positions', () => {
  const log = new RowChangeLog();
  const cold = numericBytes(log);
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let slot = 0; slot < 4096; slot++) {
      log.append(slot, 'enter', cycle, 8192);
      log.appendContent(slot, CONTENT_BOX, [slot, 2, 3, 4, 5, 6]);
    }
    expect(numericBytes(log)).toBeGreaterThan(cold);
    const previous = log.position;
    let held: Float32Array | undefined;
    let heldOffset = 0;
    expect(
      log.visitContent(previous - 1, previous, (_slot, _flags, boxes, offset) => {
        held = boxes;
        heldOffset = offset;
        return true;
      }),
    ).toBe('done');
    assert(held);
    log.reset();
    expect(numericBytes(log)).toBe(cold);
    expect(log.position).toBeGreaterThan(previous);
    expect(log.visit(previous - 1, previous, () => {})).toBe(false);
    expect(log.visitContent(previous - 1, previous, () => true)).toBe('lapsed');
    expect(held[heldOffset]).toBe(4095);
    const start = log.position;
    log.append(7, 'enter', cycle + 1, 8);
    const rows: number[] = [];
    expect(log.visit(start, log.position, (slot) => rows.push(slot))).toBe(true);
    expect(rows).toEqual([7]);
    log.appendContent(7, CONTENT_BOX, [11, 12, 13, 14, 15, 16]);
    const boxes: number[][] = [];
    expect(
      log.visitContent(start, log.position, (_slot, _flags, values, offset) => {
        boxes.push([...values.subarray(offset, offset + 6)]);
        return true;
      }),
    ).toBe('done');
    expect(boxes).toEqual([[11, 12, 13, 14, 15, 16]]);
  }
});

it('contracts retained mixed history across repeated large scenes and box sequence wrap', () => {
  const log = new RowChangeLog();
  const beforeWrap = 2 ** 32 - 256;
  Reflect.set(log, 'boxHead', beforeWrap);
  Reflect.set(log, 'boxTail', beforeWrap);
  const box = Float32Array.of(0, 2, 3, 4, 5, 6);
  for (let cycle = 0; cycle < 6; cycle++) {
    const start = log.position;
    for (let slot = 0; slot < 4096; slot++) {
      log.append(slot, 'update', cycle, 16384);
      box[0] = slot + cycle * 4096;
      log.appendContent(slot, CONTENT_BOX, box);
    }
    const end = log.position;
    const peak = numericBytes(log);
    let previous: Float32Array | undefined;
    let previousOffset = 0;
    log.visitContent(end - 1, end, (_slot, _flags, values, offset) => {
      previous = values;
      previousOffset = offset;
      return true;
    });
    log.trim(16);
    expect(log.position).toBe(end);
    expect(log.backingBytes).toBe(numericBytes(log));
    expect(log.backingBytes).toBe(21504);
    expect(log.backingBytes).toBeLessThan(peak / 4);
    expect(log.visit(start, end, () => assert.fail('lapsed row should never be read'))).toBe(false);
    expect(
      log.visitContent(start, end, () => assert.fail('lapsed content should never be read')),
    ).toBe('lapsed');
    const rows: unknown[] = [];
    expect(
      log.visit(end - 4, end, (slot, kind, generation) => rows.push([slot, kind, generation])),
    ).toBe(true);
    expect(rows).toEqual([
      [4094, 'update', cycle],
      [4095, 'update', cycle],
    ]);
    const recent: unknown[] = [];
    expect(
      log.visitContent(end - 1024, end, (slot, flags, values, offset) => {
        recent.push([slot, flags, values[offset], values[offset + 5]]);
        return true;
      }),
    ).toBe('done');
    expect(recent).toHaveLength(512);
    expect(recent[0]).toEqual([3584, CONTENT_BOX, 3584 + cycle * 4096, 6]);
    expect(recent[511]).toEqual([4095, CONTENT_BOX, box[0], 6]);
    expect(previous?.[previousOffset]).toBe(box[0]);
  }
});

it('drains Scene bounds, instance hierarchies and staging after repeated bulk disposal', () => {
  const rows = new SceneRows();
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const coldBounds = cullingBoundsBytes(rows);
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const transforms = new Float32Array(1024 * 16);
  for (let instance = 0; instance < 1024; instance++) {
    transforms.set(pose, instance * 16);
    transforms[instance * 16 + 12] = instance;
  }
  const snapshots = Array.from(
    { length: 1024 },
    (_, entityKey): RenderableSnapshot => ({
      entityKey,
      assetHandle: 1,
      transform: { world: pose },
      localAabb: Float32Array.of(-1, -1, -1, 1, 1, 1),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      ...(entityKey === 1023
        ? { instances: { transforms, instanceCount: 1024, cacheKey: entityKey, archVersion: 0 } }
        : {}),
    }),
  );
  const operations = snapshots.map((snapshot) => ({
    kind: 'update' as const,
    entityKey: snapshot.entityKey,
    snapshot,
  }));
  for (let cycle = 0; cycle < 20; cycle++) {
    rows.apply(operations, [], true);
    const frame = rows.capture();
    const last = frame.slotAt(1023);
    assert(last);
    expect(rows.cullingWorldBoundsAt(last)).toEqual({ min: [-1, -1, -1], max: [1024, 1, 1] });
    expect(cullingBoundsBytes(rows)).toBeGreaterThan(coldBounds);
    const beforeDispose = rows.instanceBoundsStatistics();
    // Hydrate the live-slot staging ledger before disposal too.
    rows.apply([{ kind: 'update', entityKey: 1023, world: pose }], [], true);
    rows.dispose();
    expect(cullingBoundsBytes(rows)).toBe(coldBounds);
    expect(rows.instanceBoundsStatistics().invalidations).toBe(beforeDispose.invalidations + 1);
    expect(Reflect.get(rows, 'pendingBySlot')).toHaveLength(0);
    expect(rows.capture().length).toBe(0);
    // Disposal clears lazy wrapper caches; held root values remain independent.
    expect(frame.slotAt(1023)).toEqual(last);
    expect(last.snapshot.transform.world).toEqual(pose);
    expect(last.snapshot.instances?.transforms[1023 * 16 + 12]).toBe(1023);
  }
});

it('releases culling pages and contracts the journal while surviving rows stay readable', () => {
  const rows = new SceneRows();
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const world = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const localAabb = Float32Array.of(-1, -1, -1, 1, 1, 1);
  const box = { min: [-1, -1, -1], max: [1, 1, 1] };
  const snapshot = (entityKey: number): RenderableSnapshot => ({
    entityKey,
    assetHandle: 1,
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    transform: { world },
    localAabb,
    ...(entityKey % 64 === 0 || entityKey === 8191
      ? { instances: { transforms: world, instanceCount: 1, cacheKey: entityKey, archVersion: 0 } }
      : {}),
  });
  const creates = Array.from({ length: 8192 }, (_, i) => ({
    kind: 'update' as const,
    entityKey: i,
    snapshot: snapshot(i),
  }));
  const removes = creates
    .slice(2)
    .map((row) => ({ kind: 'remove' as const, entityKey: row.entityKey }));
  rows.apply(creates.slice(0, 2), [], true);
  for (let cycle = 0; cycle < 6; cycle++) {
    rows.apply(creates.slice(2), [], true);
    const held = rows.capture();
    const last = held.lookup(8191);
    assert(last);
    for (const slot of held) expect(rows.cullingWorldBoundsAt(slot)).toEqual(box);
    const full = cullingBoundsBytes(rows);
    expect(rows.changeJournalBackingBytes).toBeGreaterThan(4096 * 9);
    rows.apply(removes, [], true);
    const small = rows.capture();
    expect(small.length).toBe(2);
    for (const slot of small) expect(rows.cullingWorldBoundsAt(slot)).toEqual(box);
    expect(cullingBoundsBytes(rows) * 128).toBe(full);
    expect(rows.changeJournalBackingBytes).toBe(1024 * 9);
    const retained = cullingBoundsBytes(rows);
    const derives = rows.instanceBoundsStatistics().derives;
    expect(rows.cullingWorldBoundsAt(last)).toEqual(box);
    const survivor = small.lookup(0);
    assert(survivor);
    expect(rows.cullingWorldBoundsAt(survivor)).toEqual(box);
    expect(rows.instanceBoundsStatistics().derives).toBe(derives + 1);
    expect(cullingBoundsBytes(rows)).toBe(retained);
  }
  const { instances: _instances, ...rigid } = snapshot(0);
  rows.apply([{ kind: 'update', entityKey: 0, snapshot: rigid }], [], true);
  expect(cullingBoundsBytes(rows)).toBe(0);
  rows.apply(
    [
      { kind: 'remove', entityKey: 0 },
      { kind: 'remove', entityKey: 1 },
    ],
    [],
    true,
  );
  expect(cullingBoundsBytes(rows)).toBe(0);
});

it('owns admitted draw facts when one producer row and its material list change every frame', () => {
  const rows = new RowContents();
  const first = MaterialResource.from(defaultMaterialSnapshot());
  const second = MaterialResource.from(defaultMaterialSnapshot());
  const materials = [first];
  const source = {
    material: first,
    materials,
    materialBindingSources: ['engine-default' as const],
    renderLayers: 0,
    entityKey: 1,
    transform: { world: new Float32Array(16) },
  };
  const original = rows.acquire(source);
  for (let frame = 1; frame <= 60; frame++) {
    source.renderLayers = frame;
    source.material = frame % 2 === 1 ? second : first;
    materials[0] = source.material;
    const current = rows.acquire(source);
    expect(current.renderLayers).toBe(frame);
    expect(current.materials[0]).toBe(source.material);
    expect(original.materials[0]).toBe(first);
    expect(original.renderLayers).toBe(0);
    rows.release(current);
  }
  rows.release(original);
  expect(rows.size).toBe(0);
});

it('shares equivalent live facts independent of field order and never rereads a retired row', () => {
  const rows = new RowContents();
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const materials = Object.freeze([material]);
  const materialBindingSources = Object.freeze(['engine-default' as const]);
  let readable = true;
  const prior = {
    material,
    materials,
    materialBindingSources,
    get renderLayers() {
      if (!readable) throw new Error('Producer row outlived its admission');
      return 1;
    },
  };
  const one = rows.acquire(prior);
  readable = false;
  const different = rows.acquire({ material, materials, materialBindingSources, renderLayers: 2 });
  const keys = vi.spyOn(Object, 'keys');
  let keyEnumerations = 0;
  try {
    for (let frame = 0; frame < 60; frame++) {
      const renderLayers = (frame % 2) + 1;
      const before = keys.mock.calls.length;
      const current = rows.acquire({ renderLayers, materialBindingSources, materials, material });
      keyEnumerations += keys.mock.calls.length - before;
      expect(current).toBe(renderLayers === 1 ? one : different);
      rows.release(current);
    }
  } finally {
    keys.mockRestore();
  }
  expect(keyEnumerations).toBe(0);
  rows.release(one);
  rows.release(different);
  expect(rows.size).toBe(0);
  expect(rows.acquire({ material, materials, materialBindingSources })).not.toBe(one);
});

it('checks the complete live row facts even for two values in the same fingerprint bucket', () => {
  const rows = new RowContents();
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const source = {
    material,
    materials: [material],
    materialBindingSources: ['engine-default' as const],
  };
  // Different finite values with the same folded fingerprint as zero.
  const bits = new Int32Array(2);
  bits[1] = 0x3fc00000;
  bits[0] = Math.imul(bits[1], 31);
  const collision = new Float64Array(bits.buffer)[0] as number;
  expect(collision).not.toBe(0);
  const first = rows.acquire({ ...source, lodHysteresis: 0 });
  const second = rows.acquire({ ...source, lodHysteresis: collision });
  expect(second).not.toBe(first);
  expect(rows.size).toBe(2);

  const again = rows.acquire({ ...source, lodHysteresis: 0 });
  expect(again).toBe(first);
  rows.release(first);
  rows.release(again);
  expect(rows.size).toBe(1);
  expect(rows.acquire({ ...source, lodHysteresis: collision })).toBe(second);
  rows.release(second);
  rows.release(second);
  expect(rows.size).toBe(0);
});
