import * as scene from '@forgeax/engine-scene';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { renderPublicationTransfers } from '../publication/record';
import { SkinJointReferences } from '../publication/skin-joints';
import { fixture } from './skin-publication-fixture';

it('publishes one joint delta and no consumer template after an actual presentation write', () => {
  const f = fixture();
  try {
    expect(f.publish().upserts.length).toBe(4);
    for (const position of [1, 2, 3]) {
      f.world.set(f.firstJoint, Transform, { pos: [position, 0, 0] }).unwrap();
      const packet = f.publish();
      expect([...packet.upserts]).toEqual([]);
      expect(packet.templates).toHaveLength(0);
      expect([...packet.transformEntities]).toEqual([Number(f.firstJoint)]);
      expect(packet.transforms[12]).toBe(position);
      expect([...packet.retiredJoints]).toEqual([]);
      expect([...f.publish().transformEntities]).toEqual([]);
    }
  } finally {
    f.publisher.dispose();
  }
});
it('retries a drained actual joint change after discard using the latest presentation value', () => {
  const f = fixture();
  try {
    f.publish();
    f.world.set(f.firstJoint, Transform, { pos: [9, 0, 0] }).unwrap();
    const discarded = f.prepare();
    expect([...discarded.packet.transformEntities]).toEqual([Number(f.firstJoint)]);
    discarded.discard();
    f.world.set(f.firstJoint, Transform, { pos: [12, 0, 0] }).unwrap();
    const packet = f.publish();
    expect([...packet.upserts]).toEqual([]);
    expect([...packet.transformEntities]).toEqual([Number(f.firstJoint)]);
    expect(packet.transforms[12]).toBe(12);
  } finally {
    f.publisher.dispose();
  }
});
it('separates renderable removal from referenced joint retirement on the actual source', () => {
  const f = fixture();
  try {
    f.world
      .addComponent(f.firstJoint, { component: MeshFilter, data: { assetHandle: f.cube } })
      .unwrap();
    f.world
      .addComponent(f.firstJoint, { component: MeshRenderer, data: { materials: [f.material] } })
      .unwrap();
    f.publish();
    f.world.removeComponent(f.firstJoint, MeshRenderer).unwrap();
    const removed = f.publish();
    expect([...removed.removed]).toEqual([Number(f.firstJoint)]);
    expect([...removed.retiredJoints]).toEqual([]);
    f.world.set(f.firstJoint, Transform, { pos: [5, 0, 0] }).unwrap();
    const next = f.publish();
    expect([...next.upserts]).toEqual([]);
    expect([...next.transformEntities]).toEqual([Number(f.firstJoint)]);
    expect(next.transforms[12]).toBe(5);
  } finally {
    f.publisher.dispose();
  }
});
it('emits last-reference retirement once and first-reference restoration once', () => {
  const f = fixture();
  try {
    f.publish();
    f.world.removeComponent(f.first, Skin).unwrap();
    f.world.removeComponent(f.second, Skin).unwrap();
    const retired = f.publish();
    expect([...retired.retiredJoints]).toEqual([Number(f.firstJoint)]);
    f.world.set(f.firstJoint, Transform, { pos: [8, 0, 0] }).unwrap();
    expect([...f.publish().transformEntities]).toEqual([]);
    f.world
      .addComponent(f.first, {
        component: Skin,
        data: { skeleton: f.skeleton, joints: [f.firstJoint] },
      })
      .unwrap();
    const restored = f.publish();
    expect([...restored.retiredJoints]).toEqual([]);
    const index = [...restored.transformEntities].indexOf(Number(f.firstJoint));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(restored.transforms[index * 16 + 12]).toBe(8);
  } finally {
    f.publisher.dispose();
  }
});
it.each([
  64, 1024,
])('does not re-extract consumers when one joint shared by %i source Bindings changes', (count) => {
  const f = fixture();
  try {
    for (let index = 2; index < count; index++) f.spawn();
    expect(f.publish().upserts.length).toBe(count * 2);
    f.world.set(f.firstJoint, Transform, { pos: [13, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const read = vi.spyOn(scene, 'readPresentationWorldMatrix');
    let candidate: ReturnType<typeof f.prepare>;
    try {
      candidate = f.publisher.prepare(0).unwrap();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
    const packet = candidate.packet;
    expect(packet.upserts.length).toBe(0);
    expect(packet.templates.length).toBe(0);
    expect([...packet.transformEntities]).toEqual([Number(f.firstJoint)]);
    expect(packet.transforms.byteLength).toBe(64);
    expect(packet.transforms[12]).toBe(13);
    candidate.discard();
  } finally {
    f.publisher.dispose();
  }
});
it('closes the whole publisher after a reference commit failure instead of exposing a retryable partial session', () => {
  const f = fixture();
  try {
    f.publish();
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    const actual = SkinJointReferences.prototype.prepare;
    const hook = vi
      .spyOn(SkinJointReferences.prototype, 'prepare')
      .mockImplementationOnce(function (this: SkinJointReferences, edits) {
        const candidate = actual.call(this, edits);
        return {
          ...candidate,
          commit() {
            candidate.commit();
            throw new Error('injected source commit failure');
          },
        };
      });
    const candidate = f.prepare();
    try {
      expect(() => candidate.accept()).toThrow('start a new source epoch');
    } finally {
      hook.mockRestore();
    }
    expect(f.publisher.inspect().failed).toBe(true);
    expect(f.publisher.prepare(0).ok).toBe(false);
    expect(() => candidate.accept()).toThrow();
    candidate.discard();
  } finally {
    f.publisher.dispose();
  }
});
it('transfers and recycles the one protocol record through the real source candidate lifetime', () => {
  const f = fixture();
  try {
    const candidate = f.prepare(),
      transfers = renderPublicationTransfers(candidate.message);
    expect(transfers).toEqual([candidate.message.record]);
    // Every change column is a view of the same record.
    for (const column of [
      candidate.packet.upserts,
      candidate.packet.removed,
      candidate.packet.transformEntities,
      candidate.packet.retiredJoints,
      candidate.packet.transforms,
    ])
      expect(column.buffer).toBe(candidate.message.record);
    const message = structuredClone(candidate.message, { transfer: transfers });
    candidate.accept();
    for (const storage of transfers) expect(storage.byteLength).toBe(0);
    const returned = renderPublicationTransfers(message);
    expect(f.publisher.recycle(message.revision, []).ok).toBe(false);
    expect(f.publisher.recycle(message.revision, [...returned, new ArrayBuffer(8)]).ok).toBe(false);
    expect(f.publisher.recycle(message.revision, returned).ok).toBe(true);
    f.world.set(f.firstJoint, Transform, { pos: [17, 0, 0] }).unwrap();
    const next = f.publish();
    expect(next.transforms[12]).toBe(17);
  } finally {
    f.publisher.dispose();
  }
});
it('recycles the record slot without repeated allocation after baseline', () => {
  const f = fixture();
  try {
    f.publish();
    const allocations = f.publisher.inspect().allocations;
    const sizes: number[] = [];
    for (let position = 1; position <= 8; position++) {
      f.world.set(f.firstJoint, Transform, { pos: [position, 0, 0] }).unwrap();
      const packet = f.publish();
      expect(packet.transforms[12]).toBe(position);
      expect(f.publisher.inspect().allocations).toBe(allocations);
      sizes.push(required(packet.transforms.buffer.byteLength));
    }
    for (const size of sizes) expect(size).toBe(sizes[0]);
  } finally {
    f.publisher.dispose();
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing admitted fixture fact');
  return value;
}
