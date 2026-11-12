import { assert, expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { CONTENT_BOX, RowChangeLog } from '../row-change-log';
import { SceneRows } from '../scene-rows';

/** Count actual private backing edges, without depending on GC scheduling. */
function numericBytes(owner: object): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const value of Object.values(owner))
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
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
  const coldBounds = numericBytes(Reflect.get(rows, 'bounds'));
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const transforms = new Float32Array(1024 * 16);
  for (let instance = 0; instance < 1024; instance++) {
    transforms.set(pose, instance * 16);
    transforms[instance * 16 + 12] = instance;
  }
  const snapshots = Array.from(
    { length: 1024 },
    (_, entityKey): RenderableSnapshot => ({
      worldId: 0,
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
    worldId: snapshot.worldId,
    entityKey: snapshot.entityKey,
    snapshot,
  }));
  for (let cycle = 0; cycle < 20; cycle++) {
    rows.apply(operations, [], true);
    const frame = rows.capture();
    const last = frame.slotAt(1023);
    assert(last);
    expect(rows.cullingWorldBoundsAt(last)).toEqual({ min: [-1, -1, -1], max: [1024, 1, 1] });
    expect(numericBytes(Reflect.get(rows, 'bounds'))).toBeGreaterThan(coldBounds);
    const cache = Reflect.get(Reflect.get(rows, 'instanceBoundsCache'), 'entries') as Map<
      string,
      unknown
    >;
    expect(cache.size).toBe(1);
    // Hydrate the live-slot staging ledger before disposal too.
    rows.apply([{ kind: 'update', worldId: 0, entityKey: 1023, world: pose }], [], true);
    rows.dispose();
    expect(numericBytes(Reflect.get(rows, 'bounds'))).toBe(coldBounds);
    expect(cache.size).toBe(0);
    expect(Reflect.get(rows, 'pendingBySlot')).toHaveLength(0);
    expect(rows.capture().length).toBe(0);
    // Disposal clears lazy wrapper caches; held root values remain independent.
    expect(frame.slotAt(1023)).toEqual(last);
    expect(last.snapshot.transform.world).toEqual(pose);
    expect(last.snapshot.instances?.transforms[1023 * 16 + 12]).toBe(1023);
  }
});
