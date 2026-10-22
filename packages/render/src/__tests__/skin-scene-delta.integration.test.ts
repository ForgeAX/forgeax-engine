import { mat4 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import type { RenderSceneOperation } from '../scene/render-scene-types';
import { SkinInputs } from '../scene/skin-inputs';
import { type SkinBindingInput, SkinSceneInputs } from '../scene/skin-scene-inputs';

function matrix(x = 0) {
  const value = mat4.identity(mat4.create());
  value[12] = x;
  return value;
}
const material = MaterialResource.from(defaultMaterialSnapshot());
function snapshot(
  entityKey: number,
  skinBinding?: SkinBindingInput,
  worldId = 0,
): RenderableSnapshot {
  return {
    worldId,
    entityKey,
    transform: { world: matrix(99) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    ...(skinBinding === undefined ? {} : { skinBinding }),
  };
}
function fixture() {
  const arena = new GpuInputArena(),
    scene = new RenderScene();
  const resolve = vi.fn(() => ({
    kind: 'skeleton' as const,
    jointCount: 1,
    inverseBindMatrices: matrix(1),
  }));
  const skin = new SkinSceneInputs(arena, resolve);
  const apply = (operations: readonly RenderSceneOperation[]) => {
    const before = scene.slotsSnapshot();
    const delta = scene.apply(operations);
    skin.apply(before, delta);
    return delta;
  };
  const update = (row: RenderableSnapshot): RenderSceneOperation => ({
    kind: 'update',
    worldId: row.worldId,
    entityKey: row.entityKey,
    snapshot: row,
  });
  return { arena, scene, skin, resolve, apply, update };
}
const binding: SkinBindingInput = { skeleton: 7, joints: [19] };

it('adopts only known static Scene edits and leaves transform-only work outside Skin membership', () => {
  const { arena, scene, skin, resolve, apply, update } = fixture();
  const joints = [19];
  try {
    apply([update(snapshot(1, { skeleton: 7, joints })), update(snapshot(2, binding))]);
    joints[0] = 900; // Scene owns the admitted static array.
    expect(scene.slotsSnapshot().lookup(0, 1)?.snapshot.skinBinding?.joints).toEqual([19]);
    expect(Object.isFrozen(scene.slotsSnapshot().lookup(0, 1)?.snapshot.skinBinding?.joints)).toBe(
      true,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    skin.joint(0, 19, matrix(3));
    const before = skin.capture(),
      bind = vi.spyOn(SkinInputs.prototype, 'bind');
    try {
      apply([{ kind: 'update', worldId: 0, entityKey: 1, world: matrix(101) }]);
      expect(bind).not.toHaveBeenCalled();
      skin.joint(0, 19, matrix(8));
      expect(bind).not.toHaveBeenCalled();
      const current = skin.capture(),
        out = mat4.create(),
        inverse = mat4.create();
      try {
        const slot = scene.slotsSnapshot().lookup(0, 1)?.slot;
        if (slot === undefined) throw new Error('Missing actual slot');
        expect(before.matrix(slot, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(4);
        expect(current.matrix(slot, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(9);
        expect(current.historyCompatible(before, slot)).toBe(true);
      } finally {
        current.release();
      }
    } finally {
      bind.mockRestore();
      before.release();
    }
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('invalidates a recreated Binding even for identical bytes and preserves held old roots', () => {
  const { arena, scene, skin, apply, update } = fixture();
  try {
    apply([update(snapshot(1, binding)), update(snapshot(2, binding))]);
    skin.joint(0, 19, matrix(3));
    const oldSlots = scene.slotsSnapshot(),
      old = skin.capture();
    try {
      const delta = apply([
        { kind: 'remove', worldId: 0, entityKey: 1 },
        update(snapshot(1, binding)),
      ]);
      expect(delta.recreated).toBe(1);
      const current = skin.capture(),
        out = mat4.create(),
        inverse = mat4.create();
      try {
        const slot = scene.slotsSnapshot().lookup(0, 1)?.slot;
        if (slot === undefined) throw new Error('Missing slot');
        expect(current.available(slot)).toBe(true); // other Binding retained the source joint
        expect(current.historyCompatible(old, slot)).toBe(false);
        const oldSlot = oldSlots.lookup(0, 1)?.slot;
        if (oldSlot === undefined) throw new Error('Missing old slot');
        expect(old.matrix(oldSlot, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(4);
      } finally {
        current.release();
      }
    } finally {
      old.release();
    }
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('adopts simultaneous removal, recreation and slot reuse before new Skin membership', () => {
  const { arena, scene, skin, apply, update } = fixture();
  try {
    apply([
      update(snapshot(1, binding)),
      update(snapshot(2, binding)),
      update(snapshot(3, binding)),
    ]);
    skin.joint(0, 19, matrix(3));
    apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]); // older free slot
    const held = skin.capture(),
      priorSlots = scene.slotsSnapshot();
    try {
      const delta = apply([
        { kind: 'remove', worldId: 0, entityKey: 3 },
        update(snapshot(3, binding)),
        update(snapshot(4, binding)),
      ]);
      expect(delta.recreated).toBe(1);
      expect(delta.created).toBe(1);
      const actual = scene.slotsSnapshot();
      expect(actual.lookup(0, 3)?.slot).toBe(priorSlots.lookup(0, 3)?.slot);
      expect(actual.lookup(0, 4)?.slot).toBe(0); // previously removed entity's address
      const current = skin.capture(),
        out = mat4.create(),
        inverse = mat4.create();
      try {
        for (const entity of [2, 3, 4]) {
          const slot = actual.lookup(0, entity)?.slot;
          if (slot === undefined) throw new Error('Missing accepted slot');
          expect(current.matrix(slot, 0, out, inverse)).toBe(true);
          expect(out[12]).toBe(4);
        }
        expect(held.matrix(priorSlots.lookup(0, 3)?.slot ?? 999, 0, out, inverse)).toBe(true);
      } finally {
        current.release();
      }
    } finally {
      held.release();
    }
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('keeps source namespaces independent and retires exact removed membership', () => {
  const { arena, scene, skin, apply, update } = fixture();
  try {
    apply([update(snapshot(1, binding, 0)), update(snapshot(1, binding, 1))]);
    skin.joint(0, 19, matrix(3));
    skin.joint(1, 19, matrix(9));
    apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
    expect(skin.hasJoint(0, 19)).toBe(false);
    expect(skin.hasJoint(1, 19)).toBe(true);
    const frame = skin.capture(),
      out = mat4.create(),
      inverse = mat4.create();
    try {
      expect(frame.matrix(scene.slotsSnapshot().lookup(1, 1)?.slot ?? 999, 0, out, inverse)).toBe(
        true,
      );
      expect(out[12]).toBe(10);
    } finally {
      frame.release();
    }
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('poisons the Scene Skin owner on a stale before root without invalidating held input', () => {
  const { arena, scene, skin, apply, update } = fixture();
  const empty = scene.slotsSnapshot();
  try {
    apply([update(snapshot(1, binding))]);
    skin.joint(0, 19, matrix(3));
    const held = skin.capture();
    try {
      const delta = scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
      expect(() => skin.apply(empty, delta)).toThrow();
      expect(() => skin.capture()).toThrow();
      expect(held.matrix(delta.removedSlots[0]?.slot ?? 999, 0, mat4.create(), mat4.create())).toBe(
        true,
      );
    } finally {
      held.release();
    }
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('captures one Skin Binding object and known fields without mixing getter results', () => {
  const { arena, scene, skin, apply, update } = fixture();
  let reads = 0,
    skeletonReads = 0,
    jointReads = 0,
    boundsReads = 0;
  const a = {
    get skeleton() {
      skeletonReads++;
      return 7;
    },
    get joints() {
      jointReads++;
      return [19];
    },
    get conservativeBounds() {
      boundsReads++;
      return true;
    },
  };
  const b = { skeleton: 99, joints: [900] };
  const row = snapshot(1);
  Object.defineProperty(row, 'skinBinding', {
    enumerable: true,
    get() {
      return reads++ % 2 === 0 ? a : b;
    },
  });
  try {
    apply([update(row)]);
    // Node 22 object-rest destructuring re-reads an excluded accessor and
    // discards it; the first read's fields alone reach the Scene.
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(skeletonReads).toBe(1);
    expect(jointReads).toBe(1);
    expect(boundsReads).toBe(0);
    expect(scene.slotsSnapshot().lookup(0, 1)?.snapshot.skinBinding).toEqual({
      skeleton: 7,
      joints: [19],
    });
    skin.joint(0, 19, matrix(3));
    const frame = skin.capture();
    try {
      expect(frame.available(scene.slotsSnapshot().lookup(0, 1)?.slot ?? 999)).toBe(true);
    } finally {
      frame.release();
    }
  } finally {
    skin.dispose();
    arena.dispose();
  }
});
