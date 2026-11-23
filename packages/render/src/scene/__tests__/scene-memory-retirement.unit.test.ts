import { assert, expect, it } from 'vitest';
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
    const cache = Reflect.get(Reflect.get(rows, 'instanceBoundsCache'), 'entries') as Map<
      string,
      unknown
    >;
    expect(cache.size).toBe(1);
    // Hydrate the live-slot staging ledger before disposal too.
    rows.apply([{ kind: 'update', entityKey: 1023, world: pose }], [], true);
    rows.dispose();
    expect(cullingBoundsBytes(rows)).toBe(coldBounds);
    expect(cache.size).toBe(0);
    expect(Reflect.get(rows, 'pendingBySlot')).toHaveLength(0);
    expect(rows.capture().length).toBe(0);
    // Disposal clears lazy wrapper caches; held root values remain independent.
    expect(frame.slotAt(1023)).toEqual(last);
    expect(last.snapshot.transform.world).toEqual(pose);
    expect(last.snapshot.instances?.transforms[1023 * 16 + 12]).toBe(1023);
  }
});

it('releases unoccupied culling pages while another Level and old frames stay readable', () => {
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
    ...(entityKey === 1023
      ? { instances: { transforms: world, instanceCount: 1, cacheKey: entityKey, archVersion: 0 } }
      : {}),
  });
  const creates = Array.from({ length: 1024 }, (_, i) => ({
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
    const last = held.lookup(1023);
    assert(last);
    for (const slot of held) expect(rows.cullingWorldBoundsAt(slot)).toEqual(box);
    const full = cullingBoundsBytes(rows);
    rows.apply(removes, [], true);
    const small = rows.capture();
    expect(small.length).toBe(2);
    for (const slot of small) expect(rows.cullingWorldBoundsAt(slot)).toEqual(box);
    expect(cullingBoundsBytes(rows) * 16).toBe(full);
    const retained = cullingBoundsBytes(rows);
    const instances = Reflect.get(Reflect.get(rows, 'instanceBoundsCache'), 'entries') as Map<
      number,
      unknown
    >;
    expect(instances.size).toBe(0);
    expect(rows.cullingWorldBoundsAt(last)).toEqual(box);
    expect(instances.size).toBe(0);
    expect(cullingBoundsBytes(rows)).toBe(retained);
  }
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
  const two = rows.acquire({ renderLayers: 1, materialBindingSources, materials, material });
  expect(two).toBe(one);
  rows.release(one);
  rows.release(two);
  rows.release(different);
  expect(rows.size).toBe(0);
  expect(rows.acquire({ material, materials, materialBindingSources })).not.toBe(one);
});
