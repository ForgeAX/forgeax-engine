import { mat4 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { GpuInputArena } from '../gpu-input-arena';
import { RenderPublicationReceiver } from '../publication/receiver';
import { SkinJointReferences } from '../publication/skin-joints';
import { type SkinInputSlot, SkinInputs } from '../scene/skin-inputs';
import { fixture } from './skin-publication-fixture';

// Qualification adapter only: production PersistentRenderScene slot and source
// lifetime adoption still has to replace this explicit fixture authority.
function endpoint(missing = false) {
  const f = fixture(missing),
    receiver = new RenderPublicationReceiver({ source: 'skin-owner', epoch: 1 });
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena),
    source = skin.source();
  const skeletons = new Map<number, SkinInputSlot>(),
    scratch = mat4.create();
  function adopt(packet = f.publish()) {
    const prepared = receiver.accept(packet).unwrap();
    for (const change of prepared.assetChanges) {
      const value = prepared.resources.resolveAsset(change.handle);
      if (value.ok && value.value.kind === 'skeleton') {
        const asset = value.value,
          previous = skeletons.get(change.handle);
        if (previous)
          skin.updateSkeleton(
            previous,
            asset.jointCount,
            asset.inverseBindMatrices,
            asset.shadowCapsules,
          );
        else
          skeletons.set(
            change.handle,
            skin.skeleton(asset.jointCount, asset.inverseBindMatrices, asset.shadowCapsules),
          );
      }
    }
    for (const operation of prepared.operations) {
      if (operation.kind === 'remove') skin.unbind(operation.entityKey);
      else if (operation.snapshot) {
        const binding = operation.snapshot.skinBinding;
        if (binding) {
          const skeleton = skeletons.get(binding.skeleton);
          if (!skeleton) throw new Error('Missing admitted fixture Skeleton');
          skin.bind(operation.entityKey, source, skeleton, Uint32Array.from(binding.joints));
        } else skin.unbind(operation.entityKey);
      }
    }
    for (const joint of prepared.skinJoints?.retired ?? []) skin.removeJoint(source, joint);
    for (const index of prepared.skinJoints?.rows ?? []) {
      for (let lane = 0; lane < 16; lane++)
        scratch[lane] = required(packet.transforms[index * 16 + lane]);
      skin.setJoint(source, required(packet.transformEntities[index]), scratch);
    }
    return { prepared, packet };
  }
  return {
    ...f,
    receiver,
    skin,
    arena,
    source,
    adopt,
    dispose() {
      receiver.dispose();
      f.publisher.dispose();
      skin.dispose();
      arena.dispose();
    },
  };
}
it('adopts one independent shared-joint row, no consumer operation or per-joint ArrayBuffer, while a previous root is held', () => {
  const f = endpoint();
  try {
    const baseline = f.adopt();
    expect(baseline.packet.assets.some((row) => row.handle === Number(f.skeleton))).toBe(true);
    const old = f.skin.capture();
    try {
      f.world.set(f.firstJoint, Transform, { pos: [9, 0, 0] }).unwrap();
      const packet = f.publish(),
        slice = vi.spyOn(Float32Array.prototype, 'slice');
      let prepared: import('../publication/receiver').PreparedRenderPublication;
      try {
        prepared = f.receiver.accept(packet).unwrap();
        expect(slice).not.toHaveBeenCalled();
      } finally {
        slice.mockRestore();
      }
      expect(prepared.operations).toEqual([]);
      expect(prepared.frame.renderables).toEqual([]);
      expect(prepared.skinJoints?.rows).toHaveLength(1);
      const m = mat4.create();
      for (const row of prepared.skinJoints?.rows ?? []) {
        for (let lane = 0; lane < 16; lane++)
          m[lane] = required(packet.transforms[row * 16 + lane]);
        f.skin.setJoint(f.source, required(packet.transformEntities[row]), m);
      }
      const next = f.skin.capture();
      try {
        const inverse = mat4.create();
        expect(old.matrix(Number(f.first), 0, m, inverse)).toBe(true);
        expect(m[12]).toBe(0);
        expect(next.matrix(Number(f.first), 0, m, inverse)).toBe(true);
        expect(m[12]).toBe(9);
        expect(next.matrix(Number(f.second), 0, m, inverse)).toBe(true);
        expect(m[12]).toBe(9);
      } finally {
        next.release();
      }
    } finally {
      old.release();
    }
  } finally {
    f.dispose();
  }
});
it('retains static Bindings for initially missing joints and restores both from a joint-only presentation edit', () => {
  const f = endpoint(true);
  try {
    const first = f.adopt();
    expect(first.packet.upserts.length).toBe(4);
    expect(first.packet.templates.every((row) => row.snapshot.skinBinding !== undefined)).toBe(
      true,
    );
    expect([...first.packet.retiredJoints]).toEqual([Number(f.firstJoint)]);
    const missing = f.skin.capture();
    try {
      expect(missing.available(Number(f.first))).toBe(false);
      f.world
        .addComponent(f.firstJoint, { component: Transform, data: { pos: [7, 0, 0] } })
        .unwrap();
      const restored = f.adopt();
      expect(restored.packet.upserts.length).toBe(0);
      expect(restored.prepared.operations).toEqual([]);
      const next = f.skin.capture();
      try {
        expect(next.available(Number(f.first))).toBe(true);
        expect(next.available(Number(f.second))).toBe(true);
      } finally {
        next.release();
      }
    } finally {
      missing.release();
    }
  } finally {
    f.dispose();
  }
});
it('rejects an unknown joint row and retries the same accepted revision without changing reference ownership', () => {
  const f = endpoint();
  try {
    f.adopt();
    f.world.set(f.firstJoint, Transform, { pos: [3, 0, 0] }).unwrap();
    const packet = f.publish(),
      identities = new Uint32Array(packet.transformEntities);
    identities[0] = 0xffffffff;
    expect(f.receiver.accept({ ...packet, transformEntities: identities }).ok).toBe(false);
    const prepared = f.receiver.accept(packet).unwrap();
    expect(prepared.skinJoints?.rows).toHaveLength(1);
    expect(prepared.operations).toEqual([]);
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    const rebound = f.adopt();
    expect(rebound.packet.upserts.length).toBe(2);
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    expect(f.adopt().packet.upserts.length).toBe(0);
  } finally {
    f.dispose();
  }
});
it('keeps a joint live when its separate renderable role is removed in the same publication', () => {
  const f = endpoint();
  try {
    f.world
      .addComponent(f.firstJoint, { component: MeshFilter, data: { assetHandle: f.cube } })
      .unwrap();
    f.world
      .addComponent(f.firstJoint, { component: MeshRenderer, data: { materials: [f.material] } })
      .unwrap();
    f.adopt();
    f.world.removeComponent(f.firstJoint, MeshRenderer).unwrap();
    f.world.set(f.firstJoint, Transform, { pos: [5, 0, 0] }).unwrap();
    const next = f.adopt();
    expect([...next.packet.removed]).toEqual([Number(f.firstJoint)]);
    expect(next.prepared.skinJoints?.rows).toHaveLength(1);
    expect([...(next.prepared.skinJoints?.retired ?? [])]).toEqual([]);
    const frame = f.skin.capture(),
      out = mat4.create();
    try {
      expect(frame.matrix(Number(f.first), 0, out, mat4.create())).toBe(true);
      expect(out[12]).toBe(5);
    } finally {
      frame.release();
    }
  } finally {
    f.dispose();
  }
});
it('owns one immutable static Binding at admission without retaining packet aliases', () => {
  const f = endpoint();
  try {
    const packet = f.publish(),
      prepared = f.receiver.accept(packet).unwrap();
    const binding = packet.templates.find((row) => row.snapshot.skinBinding)?.snapshot.skinBinding;
    if (!binding) throw new Error('Missing fixture packet Binding');
    const accepted = prepared.frame.renderables.find(
      (row) => row.entityKey === Number(f.first),
    )?.skinBinding;
    expect(accepted).toBeDefined();
    expect(accepted).not.toBe(binding);
    expect(required(accepted).joints).not.toBe(binding.joints);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(required(accepted).joints)).toBe(true);
    const mutable = binding as {
      joints: number[];
      skeleton: number;
    };
    mutable.joints[0] = Number(f.secondJoint);
    mutable.skeleton = 0;
    expect(required(accepted).joints).toEqual([Number(f.firstJoint)]);
    f.world.removeComponent(f.first, Skin).unwrap();
    expect(f.receiver.accept(f.publish()).ok).toBe(true);
    f.world.removeComponent(f.second, Skin).unwrap();
    const retired = f.receiver.accept(f.publish()).unwrap();
    expect([...(retired.skinJoints?.retired ?? [])]).toEqual([Number(f.firstJoint)]);
  } finally {
    f.dispose();
  }
});
it('survives an unrelated entity edit during a temporary Skeleton count mismatch and restores from only the asset', () => {
  const f = endpoint();
  try {
    f.adopt();
    const doubled = new Float32Array(32);
    doubled.set(mat4.identity(mat4.create()));
    doubled.set(mat4.identity(mat4.create()), 16);
    f.assets
      .replace(f.skeleton, { kind: 'skeleton', jointCount: 2, inverseBindMatrices: doubled })
      .unwrap();
    expect(f.adopt().packet.upserts.length).toBe(0);
    f.world.set(f.first, MeshRenderer, { materials: [] }).unwrap();
    const edit = f.adopt();
    expect([...edit.packet.removed]).toEqual([]);
    expect(edit.packet.templates.some((row) => row.snapshot.skinBinding !== undefined)).toBe(true);
    const mismatched = f.skin.capture();
    try {
      expect(mismatched.available(Number(f.first))).toBe(false);
    } finally {
      mismatched.release();
    }
    f.assets
      .replace(f.skeleton, {
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices: mat4.identity(mat4.create()),
      })
      .unwrap();
    const resource = f.adopt();
    expect(resource.packet.upserts.length).toBe(0);
    const restored = f.skin.capture();
    try {
      expect(restored.available(Number(f.first))).toBe(true);
      expect(restored.available(Number(f.second))).toBe(true);
    } finally {
      restored.release();
    }
  } finally {
    f.dispose();
  }
});
it('invalidates the entire receiver and held prepared revision after a reference commit failure', () => {
  const f = endpoint();
  try {
    const before = f.adopt().prepared;
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    const packet = f.publish(),
      actual = SkinJointReferences.prototype.prepare;
    const hook = vi
      .spyOn(SkinJointReferences.prototype, 'prepare')
      .mockImplementationOnce(function (this: SkinJointReferences, edits) {
        const candidate = actual.call(this, edits);
        return {
          ...candidate,
          commit() {
            candidate.commit();
            throw new Error('injected commit failure');
          },
        };
      });
    try {
      expect(() => f.receiver.accept(packet)).toThrow('start a new source epoch');
    } finally {
      hook.mockRestore();
    }
    expect(before.resources.revision).toBe(-1);
    expect(f.receiver.acceptedRevision).toBe(-1);
    expect(f.receiver.accept(packet).ok).toBe(false);
    expect(() => f.receiver.snapshot(before)).toThrow();
  } finally {
    f.dispose();
  }
});
it('keeps the rest of a source scene usable when one Skin Binding is empty and restores on a Skin edit', () => {
  const f = endpoint();
  try {
    f.adopt();
    f.world.set(f.first, Skin, { joints: [] }).unwrap();
    const invalid = f.adopt();
    expect([...invalid.packet.removed]).toEqual([Number(f.first)]);
    expect(
      invalid.packet.templates.every((row) => row.snapshot.skinBinding?.joints.length !== 0),
    ).toBe(true);
    const live = f.skin.capture();
    try {
      expect(live.available(Number(f.second))).toBe(true);
      expect(live.available(Number(f.first))).toBe(false);
    } finally {
      live.release();
    }
    f.world.set(f.first, Skin, { joints: [f.firstJoint] }).unwrap();
    const restored = f.adopt();
    expect(restored.packet.upserts.length).toBe(2);
    const frame = f.skin.capture();
    try {
      expect(frame.available(Number(f.first))).toBe(true);
      expect(frame.available(Number(f.second))).toBe(true);
    } finally {
      frame.release();
    }
  } finally {
    f.dispose();
  }
});
it('cold snapshots retain unchanged unique joints after a sparse delta and own their numeric columns', () => {
  const f = endpoint();
  try {
    f.world.set(f.second, Skin, { joints: [f.secondJoint] }).unwrap();
    const first = f.adopt().prepared,
      snapshotA = f.receiver.snapshot(first);
    const poses = (value: typeof first) =>
      new Map(
        (value.skinJoints?.rows ?? []).map((row) => [
          required(value.packet.transformEntities[row]),
          required(value.packet.transforms[row * 16 + 12]),
        ]),
      );
    expect(poses(snapshotA)).toEqual(
      new Map([
        [Number(f.firstJoint), 0],
        [Number(f.secondJoint), 2],
      ]),
    );
    f.world.set(f.firstJoint, Transform, { pos: [9, 0, 0] }).unwrap();
    const next = f.adopt().prepared;
    expect(next.skinJoints?.rows).toHaveLength(1);
    expect(next.operations).toEqual([]);
    const snapshotB = f.receiver.snapshot(next);
    expect(poses(snapshotB)).toEqual(
      new Map([
        [Number(f.firstJoint), 9],
        [Number(f.secondJoint), 2],
      ]),
    );
    expect(poses(snapshotA)).toEqual(
      new Map([
        [Number(f.firstJoint), 0],
        [Number(f.secondJoint), 2],
      ]),
    );
    snapshotB.packet.transforms.fill(77);
    expect(poses(f.receiver.snapshot(next))).toEqual(
      new Map([
        [Number(f.firstJoint), 9],
        [Number(f.secondJoint), 2],
      ]),
    );
  } finally {
    f.dispose();
  }
});
it('rejects stale, foreign-resource and in-flight cold snapshot inputs', () => {
  const f = endpoint(),
    other = endpoint();
  try {
    const first = f.adopt().prepared,
      foreign = other.adopt().prepared;
    expect(() => f.receiver.snapshot({ ...first, resources: foreign.resources })).toThrow();
    expect(() =>
      f.receiver.snapshot({ ...first, packet: { ...first.packet, source: 'other' } }),
    ).toThrow();
    expect(() =>
      f.receiver.snapshot({ ...first, packet: { ...first.packet, epoch: 2 } }),
    ).toThrow();
    f.world.set(f.firstJoint, Transform, { pos: [6, 0, 0] }).unwrap();
    const actual = SkinJointReferences.prototype.prepare;
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    const packet = f.publish();
    const hook = vi
      .spyOn(SkinJointReferences.prototype, 'prepare')
      .mockImplementationOnce(function (this: SkinJointReferences, edits) {
        expect(() => f.receiver.snapshot(first)).toThrow();
        return actual.call(this, edits);
      });
    try {
      f.receiver.accept(packet).unwrap();
    } finally {
      hook.mockRestore();
    }
    expect(() => f.receiver.snapshot(first)).toThrow();
  } finally {
    f.dispose();
    other.dispose();
  }
});
it('cold snapshots merge the renderable and joint roles and remove last-reference facts', () => {
  const f = endpoint();
  try {
    f.world
      .addComponent(f.firstJoint, { component: MeshFilter, data: { assetHandle: f.cube } })
      .unwrap();
    f.world
      .addComponent(f.firstJoint, { component: MeshRenderer, data: { materials: [f.material] } })
      .unwrap();
    const first = f.adopt().prepared,
      snapshot = f.receiver.snapshot(first);
    expect(
      [...snapshot.packet.transformEntities].filter((id) => id === Number(f.firstJoint)),
    ).toHaveLength(1);
    const jointRow = required(required(snapshot.skinJoints).rows[0]);
    expect(snapshot.packet.transformEntities[jointRow]).toBe(Number(f.firstJoint));
    f.world.removeComponent(f.first, Skin).unwrap();
    f.world.removeComponent(f.second, Skin).unwrap();
    const retired = f.receiver.snapshot(f.adopt().prepared);
    expect(retired.skinJoints?.rows ?? []).toHaveLength(0);
    expect([...(retired.skinJoints?.retired ?? [])]).toEqual([]);
  } finally {
    f.dispose();
  }
});
it('cold snapshots preserve missing pose without a zero matrix and restore from a joint-only row', () => {
  const f = endpoint(true);
  try {
    const missing = f.receiver.snapshot(f.adopt().prepared);
    expect(missing.skinJoints?.rows ?? []).toHaveLength(0);
    expect([...(missing.skinJoints?.retired ?? [])]).toEqual([]);
    expect([...missing.packet.transformEntities]).not.toContain(Number(f.firstJoint));
    f.world.addComponent(f.firstJoint, { component: Transform, data: { pos: [4, 0, 0] } }).unwrap();
    const restored = f.adopt().prepared;
    expect(restored.operations).toEqual([]);
    const cold = f.receiver.snapshot(restored),
      row = required(required(cold.skinJoints).rows[0]);
    expect(cold.packet.transformEntities[row]).toBe(Number(f.firstJoint));
    expect(cold.packet.transforms[row * 16 + 12]).toBe(4);
  } finally {
    f.dispose();
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing admitted fixture fact');
  return value;
}
