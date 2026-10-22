import { mat4 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it, vi } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { RenderPublicationReceiver } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';
import { SkinInputFrame, SkinInputs } from '../scene/skin-inputs';
import { SkinSceneInputs } from '../scene/skin-scene-inputs';
import { fixture } from './skin-publication-fixture';

it('carries sparse Worker joint columns through Persistent admission and cold recovery without losing unchanged pose', () => {
  const f = fixture(),
    receiver = new RenderPublicationReceiver({ source: 'skin-owner', epoch: 1 });
  const scene = new PersistentRenderScene({ assets: f.assets });
  const read = (entity: number) => {
    const frame = scene.skinRecordingFrame();
    if (!frame) throw new Error('Missing accepted Skin frame');
    const slot = frame.slots.lookup(0, entity);
    if (!slot) throw new Error('Missing accepted Scene slot');
    const out = mat4.create();
    expect(frame.current.matrix(slot.slot, 0, out, mat4.create())).toBe(true);
    return out[12];
  };
  try {
    f.world.set(f.second, Skin, { joints: [f.secondJoint] }).unwrap();
    scene.consumePublication(receiver.accept(f.publish()).unwrap());
    expect(read(Number(f.first))).toBe(0);
    expect(read(Number(f.second))).toBe(2);
    f.world.set(f.firstJoint, Transform, { pos: [9, 0, 0] }).unwrap();
    const delta = receiver.accept(f.publish()).unwrap();
    expect(delta.operations).toHaveLength(0);
    expect(delta.skinJoints?.rows).toHaveLength(1);
    scene.consumePublication(delta);
    expect(read(Number(f.first))).toBe(9);
    expect(read(Number(f.second))).toBe(2);
    scene.invalidate();
    expect(scene.publicationBaselineRequired(delta.resources)).toBe(true);
    expect(() => scene.consumePublication(delta)).toThrow('baseline');
    scene.consumePublication(receiver.snapshot(delta));
    expect(read(Number(f.first))).toBe(9);
    expect(read(Number(f.second))).toBe(2);
  } finally {
    scene.dispose();
    receiver.dispose();
    f.publisher.dispose();
  }
});
// This qualification uses actual RenderScene slots and the production numeric
// adoption owner. The five-column transport is still the private cut candidate.
function endpoint(missing = false) {
  const f = fixture(missing),
    receiver = new RenderPublicationReceiver({ source: 'skin-owner', epoch: 1 });
  const arena = new GpuInputArena(),
    scene = new RenderScene();
  let resources: RenderResourceScope | undefined;
  const skin = new SkinSceneInputs(arena, (_world, handle) => {
    const value = resources?.resolveAsset(handle);
    return value?.ok && value.value.kind === 'skeleton' ? value.value : undefined;
  });
  const scratch = mat4.create();
  function adopt() {
    const packet = f.publish(),
      prepared = receiver.accept(packet).unwrap();
    resources = prepared.resources;
    scene.setSources([resources]);
    const before = scene.slotsSnapshot(),
      delta = scene.apply(prepared.operations);
    skin.apply(before, delta);
    for (const change of prepared.assetChanges) {
      const value = resources.resolveAsset(change.handle);
      // Removal of a referenced Skeleton is meaningful too; this owner does not
      // enumerate Bindings to decide whether the resource has consumers.
      skin.skeletonChanged(
        0,
        change.handle,
        value.ok && value.value.kind === 'skeleton' ? value.value : undefined,
      );
    }
    for (const entity of prepared.skinJoints?.retired ?? []) skin.joint(0, entity, undefined);
    for (const row of prepared.skinJoints?.rows ?? []) {
      for (let lane = 0; lane < 16; lane++)
        scratch[lane] = required(packet.transforms[row * 16 + lane]);
      skin.joint(0, required(packet.transformEntities[row]), scratch);
    }
    return { packet, prepared, delta };
  }
  const slot = (entity: number) => {
    const value = scene.slotsSnapshot().lookup(0, entity);
    if (!value) throw new Error('Missing actual Scene slot');
    return value.slot;
  };
  return {
    ...f,
    receiver,
    arena,
    scene,
    skin,
    adopt,
    slot,
    dispose() {
      receiver.dispose();
      f.publisher.dispose();
      skin.dispose();
      arena.dispose();
    },
  };
}
it.each([
  2, 64, 1024,
])('moves one source joint through receiver and true Scene slots without expanding %i Bindings', (count) => {
  const f = endpoint();
  for (let i = 2; i < count; i++) f.spawn();
  try {
    const baseline = f.adopt();
    expect(baseline.delta.created).toBe(count);
    const first = f.slot(Number(f.first)),
      second = f.slot(Number(f.second));
    expect(first).not.toBe(Number(f.first)); // entity identity is not a Binding address
    const before = f.skin.capture(),
      staticBinding = vi.spyOn(SkinInputs.prototype, 'bind'),
      available = vi.spyOn(SkinInputFrame.prototype, 'available');
    try {
      f.world.set(f.firstJoint, Transform, { pos: [7, 0, 0] }).unwrap();
      const update = f.adopt();
      expect(update.packet.upserts).toHaveLength(0);
      expect(update.prepared.operations).toHaveLength(0);
      expect(update.prepared.skinJoints?.rows).toHaveLength(1);
      expect(staticBinding).not.toHaveBeenCalled();
      expect(available).not.toHaveBeenCalled();
      available.mockRestore();
      const current = f.skin.capture(),
        a = mat4.create(),
        b = mat4.create();
      try {
        expect(before.matrix(first, 0, a, b)).toBe(true);
        expect(a[12]).toBe(0);
        expect(current.matrix(first, 0, a, b)).toBe(true);
        expect(a[12]).toBe(7);
        expect(current.matrix(second, 0, a, b)).toBe(true);
        expect(a[12]).toBe(7);
        expect(current.historyCompatible(before, first)).toBe(true);
      } finally {
        current.release();
      }
    } finally {
      staticBinding.mockRestore();
      available.mockRestore();
      before.release();
    }
  } finally {
    f.dispose();
  }
});
it('restores a missing pose with no static upsert and resets history after a shared definition update', () => {
  const f = endpoint(true);
  try {
    f.adopt();
    const first = f.slot(Number(f.first)),
      before = f.skin.capture();
    try {
      expect(before.available(first)).toBe(false);
      f.world
        .addComponent(f.firstJoint, { component: Transform, data: { pos: [4, 0, 0] } })
        .unwrap();
      expect(f.adopt().prepared.operations).toHaveLength(0);
      const complete = f.skin.capture();
      try {
        expect(complete.available(first)).toBe(true);
        const inverse = mat4.identity(mat4.create());
        inverse[12] = 2;
        f.assets
          .replace(f.skeleton, { kind: 'skeleton', jointCount: 1, inverseBindMatrices: inverse })
          .unwrap();
        const asset = f.adopt();
        expect(asset.prepared.operations).toHaveLength(0);
        expect(asset.packet.upserts).toHaveLength(0);
        const changed = f.skin.capture(),
          a = mat4.create(),
          b = mat4.create();
        try {
          expect(changed.matrix(first, 0, a, b)).toBe(true);
          expect(a[12]).toBe(6);
          expect(changed.historyCompatible(complete, first)).toBe(false);
          expect(complete.matrix(first, 0, a, b)).toBe(true);
          expect(a[12]).toBe(4);
        } finally {
          changed.release();
        }
      } finally {
        complete.release();
      }
    } finally {
      before.release();
    }
  } finally {
    f.dispose();
  }
});
it('retires the final source reference then samples it once when a new Skin reuses the Scene slot', () => {
  const f = endpoint();
  try {
    f.adopt();
    const oldSlot = f.slot(Number(f.first)),
      old = f.skin.capture();
    try {
      f.world.removeComponent(f.first, Skin).unwrap();
      f.world.removeComponent(f.second, Skin).unwrap();
      const retired = f.adopt();
      expect([...retired.packet.retiredJoints]).toEqual([Number(f.firstJoint)]);
      expect(f.skin.hasJoint(0, Number(f.firstJoint))).toBe(false);
      f.world.set(f.firstJoint, Transform, { pos: [11, 0, 0] }).unwrap();
      expect(f.adopt().packet.transformEntities).toHaveLength(0);
      f.world
        .addComponent(f.first, {
          component: Skin,
          data: { skeleton: f.skeleton, joints: [f.firstJoint] },
        })
        .unwrap();
      const restored = f.adopt();
      expect(restored.prepared.skinJoints?.rows).toHaveLength(1);
      const current = f.skin.capture(),
        a = mat4.create(),
        b = mat4.create();
      try {
        expect(current.matrix(f.slot(Number(f.first)), 0, a, b)).toBe(true);
        expect(a[12]).toBe(11);
        expect(old.matrix(oldSlot, 0, a, b)).toBe(true);
        expect(a[12]).toBe(0);
        expect(current.historyCompatible(old, oldSlot)).toBe(false);
      } finally {
        current.release();
      }
    } finally {
      old.release();
    }
  } finally {
    f.dispose();
  }
});
it('keeps the unchanged joint when the same packet hands all old Skin references to a new entity', () => {
  const f = endpoint();
  try {
    f.adopt();
    const oldSlot = f.slot(Number(f.first)),
      old = f.skin.capture();
    try {
      f.world.despawn(f.first).unwrap();
      f.world.despawn(f.second).unwrap();
      const next = f.spawn(),
        handoff = f.adopt();
      expect(handoff.prepared.skinJoints?.rows ?? []).toHaveLength(0);
      expect([...handoff.packet.transformEntities]).not.toContain(Number(f.firstJoint));
      const current = f.skin.capture(),
        a = mat4.create(),
        b = mat4.create();
      try {
        expect(current.matrix(f.slot(Number(next)), 0, a, b)).toBe(true);
        expect(a[12]).toBe(0);
        expect(old.matrix(oldSlot, 0, a, b)).toBe(true);
        expect(a[12]).toBe(0);
      } finally {
        current.release();
      }
    } finally {
      old.release();
    }
  } finally {
    f.dispose();
  }
});
it('keeps both unchanged joint facts across a same-packet exchange of existing Bindings', () => {
  const f = endpoint();
  try {
    f.world.set(f.second, Skin, { joints: [f.secondJoint] }).unwrap();
    f.adopt();
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    f.world.set(f.second, Skin, { joints: [f.firstJoint] }).unwrap();
    const swap = f.adopt();
    expect(swap.prepared.skinJoints?.rows ?? []).toHaveLength(0);
    const current = f.skin.capture(),
      a = mat4.create(),
      b = mat4.create();
    try {
      expect(current.matrix(f.slot(Number(f.first)), 0, a, b)).toBe(true);
      expect(a[12]).toBe(2);
      expect(current.matrix(f.slot(Number(f.second)), 0, a, b)).toBe(true);
      expect(a[12]).toBe(0);
    } finally {
      current.release();
    }
  } finally {
    f.dispose();
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing admitted fixture fact');
  return value;
}
