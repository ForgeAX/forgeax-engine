import { describe, expect, it } from 'vitest';
import {
  buildCapsuleShadowFrame,
  CAPSULE_TILE_COUNT_BITS,
  capsuleConeHalfAngle,
  capsuleReach,
  MAX_CAPSULES_PER_TILE,
  MAX_FRAME_CAPSULES,
} from '../capsule-shadow/frame';
import { inspectCapsuleShadow } from '../capsule-shadow/inspection';
import { poseShadowCapsules, WORLD_CAPSULE_STRIDE } from '../capsule-shadow/world-capsules';
import {
  restrictShadowCasterClasses,
  SHADOW_CASTER_PROMOTE_WINDOW,
  SHADOW_CASTER_SETTLE_FRAMES,
  ShadowCasterClassifier,
} from '../gpu-driven/shadow-caster-classes';
import { MaterialResource } from '../material-resource';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function translation(x: number, y: number, z: number, scale = 1): Float32Array {
  return new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
}

const material = new MaterialResource(defaultMaterialSnapshot(7));
const materials = new MaterialFrame(undefined).with(material);
const binding = {
  material,
  materials: [material],
  worldId: 0,
  entityKey: 1,
  transform: { world: IDENTITY },
  materialBindingSources: [],
};

describe('poseShadowCapsules', () => {
  it('places bind-space capsules with jointWorld x inverseBind and scales the radius', () => {
    const set = {
      joints: new Uint16Array([1]),
      shapes: new Float32Array([0, 1, 0, 0, 2, 0, 0.25]),
    };
    // Bind pose puts joint 1 at y = 1, so the inverse bind removes that offset.
    const ibms = [IDENTITY, translation(0, -1, 0)];
    const worlds = [IDENTITY, translation(3, 0, 0, 2)];
    const posed = poseShadowCapsules(set, ibms, worlds);
    expect(posed.length).toBe(WORLD_CAPSULE_STRIDE);
    expect(Array.from(posed)).toEqual([3, 0, 0, 0.5, 3, 2, 0, 0]);
  });
});

describe('ShadowCasterClassifier capsule exclusion', () => {
  const scene = { contentRevision: 0, changedSlotsSince: () => [] };
  const slots = [
    { slot: 0, snapshot: {} },
    { slot: 1, snapshot: { skin: {}, capsuleShadow: { status: 'ready' } } },
    { slot: 2, snapshot: { skin: {}, capsuleShadow: { status: 'no-shadow-capsules' } } },
    { slot: 3, snapshot: { skin: {} } },
  ];
  // Run past every promotion window so the classifier is quiescent.
  const settled = (): ShadowCasterClassifier => {
    const classifier = new ShadowCasterClassifier();
    for (
      let frame = 0;
      frame < SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW;
      frame++
    ) {
      classifier.update({ slots, slotAt: (slot) => slots[slot] }, scene);
    }
    return classifier;
  };

  it('drops only capsule-ready casters from the directional dynamic class', () => {
    const classifier = settled();
    const off = classifier.update({ slots, slotAt: (slot) => slots[slot] }, scene, false);
    expect(Array.from(off.dynamicSlots)).toEqual([1, 2, 3]);
    expect(off.directionalDynamicSlots).toBe(off.dynamicSlots);

    const on = classifier.update({ slots, slotAt: (slot) => slots[slot] }, scene, true);
    expect(Array.from(on.staticSlots)).toEqual([0]);
    expect(on.dynamicSlots).toBe(off.dynamicSlots);
    expect(Array.from(on.directionalDynamicSlots)).toEqual([2, 3]);
    expect(classifier.update({ slots, slotAt: (slot) => slots[slot] }, scene, true)).toBe(on);
  });

  it('restricts the directional class to the view candidates', () => {
    const classes = settled().update({ slots, slotAt: (slot) => slots[slot] }, scene, true);
    const restricted = restrictShadowCasterClasses(classes, [0, 1, 3]);
    expect([0, 1, 2, 3].filter((slot) => restricted.dynamicSlots.has(slot))).toEqual([1, 3]);
    expect([0, 1, 2, 3].filter((slot) => restricted.directionalDynamicSlots.has(slot))).toEqual([
      3,
    ]);
  });
});

describe('inspectCapsuleShadow', () => {
  const ready = {
    ...binding,
    capsuleShadow: { status: 'ready', capsules: new Float32Array(WORLD_CAPSULE_STRIDE * 3) },
  } as RenderableSnapshot;
  const rows = [
    ready,
    ready,
    { capsuleShadow: { status: 'not-skinned' } } as RenderableSnapshot,
    {} as RenderableSnapshot,
  ];

  it('is absent without a CapsuleShadow request', () => {
    expect(inspectCapsuleShadow([{} as RenderableSnapshot], materials, true, true)).toBe(undefined);
  });

  it('admits ready renderables and reports the submitted tile binning', () => {
    const submission = { capsuleCount: 6, droppedCapsules: 1, tileCount: 9, tileOverflow: 2 };
    expect(inspectCapsuleShadow(rows, materials, true, true, submission)).toEqual({
      requested: 3,
      admitted: 2,
      ...submission,
      fallbacks: { 'not-skinned': 1 },
    });
    expect(inspectCapsuleShadow(rows, materials, true, true)?.capsuleCount).toBe(0);
  });

  it('reports the lane and light fallbacks for ready renderables', () => {
    expect(inspectCapsuleShadow(rows, materials, false, true)?.fallbacks).toEqual({
      'forward-path': 2,
      'not-skinned': 1,
    });
    expect(inspectCapsuleShadow(rows, materials, true, false)?.fallbacks).toEqual({
      'no-directional-shadow': 2,
      'not-skinned': 1,
    });
  });
});

describe('buildCapsuleShadowFrame', () => {
  // Camera at (0, 1, 6) looking down -Z onto a 160x160 target (10x10 tiles).
  const camera = {
    position: [0, 1, 6],
    world: translation(0, 1, 6),
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 100,
    projection: 'perspective',
  } as unknown as CameraSnapshot;
  const down = [0, -1, 0];
  const character = (x: number, z: number, count = 1) => {
    const capsules = new Float32Array(count * WORLD_CAPSULE_STRIDE);
    for (let index = 0; index < count; index++)
      capsules.set([x, 0.5, z, 0.2, x, 1.5, z, 0], index * WORLD_CAPSULE_STRIDE);
    return { ...binding, capsuleShadow: { status: 'ready', capsules } } as RenderableSnapshot;
  };
  const cone = capsuleConeHalfAngle(undefined);

  it('bins a visible capsule into a bounded tile rectangle with its reach', () => {
    const frame = buildCapsuleShadowFrame(
      [character(0, 0)],
      materials,
      camera,
      down,
      cone,
      160,
      160,
    );
    expect(frame.tilesX).toBe(10);
    expect(frame.capsules[7]).toBeCloseTo(capsuleReach(1, 0.2, 1));
    expect(frame.submission.capsuleCount).toBe(1);
    expect(frame.submission.tileCount).toBeGreaterThan(0);
    expect(frame.submission.tileCount).toBeLessThan(100);
    // The swept volume spans the capsule to the ground below it, so the
    // screen center is covered while the corners are not.
    expect((frame.tiles[5 * 10 + 5] as number) & ((1 << CAPSULE_TILE_COUNT_BITS) - 1)).toBe(1);
    expect(frame.tiles[0]).toBe(0);
    expect(frame.tiles[99]).toBe(0);
  });

  it('drops capsules behind the camera and ignores non-ready rows', () => {
    const frame = buildCapsuleShadowFrame(
      [character(0, 20), {} as RenderableSnapshot],
      materials,
      camera,
      down,
      cone,
      160,
      160,
    );
    expect(frame.submission).toEqual({
      capsuleCount: 1,
      droppedCapsules: 0,
      tileCount: 0,
      tileOverflow: 0,
    });
  });

  it('keeps the closest capsules within the frame and tile budgets', () => {
    const far = character(0, -40, MAX_FRAME_CAPSULES);
    const near = character(0, 0, MAX_CAPSULES_PER_TILE + 8);
    const frame = buildCapsuleShadowFrame([far, near], materials, camera, down, cone, 160, 160);
    expect(frame.submission.capsuleCount).toBe(MAX_FRAME_CAPSULES);
    expect(frame.submission.droppedCapsules).toBe(MAX_CAPSULES_PER_TILE + 8);
    expect(frame.submission.tileOverflow).toBeGreaterThan(0);
    const header = frame.tiles[5 * 10 + 5] as number;
    expect(header & ((1 << CAPSULE_TILE_COUNT_BITS) - 1)).toBe(MAX_CAPSULES_PER_TILE);
    const offset = header >>> CAPSULE_TILE_COUNT_BITS;
    const listed = Array.from(frame.tiles.subarray(offset, offset + MAX_CAPSULES_PER_TILE));
    // Sorted closest-first, so the full tile lists the near character's capsules.
    expect(listed).toEqual(listed.map((_, index) => index));
    expect(frame.capsules[2]).toBe(0);
  });
});

it('adopts capsule Pass changes from a fixed material frame without replacing the entity', () => {
  const resource = new MaterialResource(defaultMaterialSnapshot(9));
  const row = {
    ...binding,
    material: resource,
    materials: [resource],
    capsuleShadow: {
      status: 'ready',
      capsules: Float32Array.of(0, 0, 0, 0.2, 0, 1, 0, 0),
    },
  } as RenderableSnapshot;
  const previous = new MaterialFrame(undefined).with(resource);
  resource.adopt({ ...resource.snapshot, passes: [] });
  const next = new MaterialFrame(undefined).with(resource);
  expect(inspectCapsuleShadow([row], previous, true, true)?.admitted).toBe(1);
  expect(inspectCapsuleShadow([row], next, true, true)).toMatchObject({
    admitted: 0,
    fallbacks: { 'no-shadow-caster-pass': 1 },
  });
  expect(row.capsuleShadow?.status).toBe('ready');
});
