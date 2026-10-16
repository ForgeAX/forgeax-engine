import { Update } from '@forgeax/engine-ecs';
// camera-input.dawn.test.ts -- vitest dawn project (AC-04 + AC-07 +
// plan-strategy section 7) reverse-case proof for the first-person
// camera InputSnapshot frame-start scan semantics under the dawn-node
// native binding (M11 milestone, T-M11-01 red phase -> T-M11-03 green).
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts`
// glob, see vitest.config.ts comment block). Environment: dawn-node
// native binding (vitest.setup-webgpu.ts injects globalThis.navigator
// .gpu before module evaluation).
//
// Scope (T-M11-01 acceptanceCheck):
//   (a) Frame-start scan: a synthetic InputBackend feeding the
//       InputFrameStartScan system token reads INPUT_BACKEND_KEY and writes
//       InputSnapshot under the well-known Resource key; the
//       snapshot is fresh every world.update(1 / 60).unwrap() (charter F2 minimal
//       surface + plan-strategy D-5 frame-start ordering).
//   (b) WASD consumption shape: keyboard.down('w') / down('s') /
//       down('a') / down('d') reads return true while the
//       backend reports the key as held; absent keys return false
//       (charter P3 explicit failure: empty signal IS the signal).
//   (c) Mouse movement delta: mouse.movementDelta is the per-frame
//       delta accumulator; consecutive sample() calls produce the
//       per-frame slice (LO 1.7 mouse_callback dispatches deltas, not
//       absolute positions; forgeax's snapshot mirrors that semantic).
//   (d) Up-edge collapse: a key released between two ticks shows up
//       in keyboard.up(...) for exactly one frame, then collapses
//       (frame-start-scan-system tests cover this in packages/engine-
//       input but the section 1.7 example ships its own gate to
//       prove the contract surfaces at the application layer).
//
// charter F3 + P5: this test runs in the orchestrator-driven dawn
// project (subagent does not interpret pixel output; the dawn
// binding is here purely to prove the cross-project surface aligns
// with the browser project on the same InputSnapshot 4-method API).
// The actual camera Transform integration with frame-start scan + GPU
// path lands in scripts/smoke-dawn.mjs (T-M11-02).

import {
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  type InputBackendSample,
  InputFrameStartScan,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

function fixtureBackend(): InputBackend & {
  setHeldKeys: (keys: ReadonlyArray<string>) => void;
  setUpKeys: (keys: ReadonlyArray<string>) => void;
  setMouseDelta: (dx: number, dy: number) => void;
} {
  let downKeys = new Set<string>();
  let upKeys = new Set<string>();
  let mvx = 0;
  let mvy = 0;
  const buttons: readonly [boolean, boolean, boolean] = [false, false, false];
  return {
    sample(): InputBackendSample {
      const out: InputBackendSample = {
        downKeys: new Set(downKeys),
        upKeys: new Set(upKeys),
        buttons,
        movementX: mvx,
        movementY: mvy,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      };
      // Per-frame accumulators reset (movement + up-edge); held set
      // survives across frames (LO 1.7 keyboard hold semantics).
      upKeys = new Set();
      mvx = 0;
      mvy = 0;
      return out;
    },
    detach() {},
    setHeldKeys(keys: ReadonlyArray<string>): void {
      downKeys = new Set(keys);
    },
    setUpKeys(keys: ReadonlyArray<string>): void {
      upKeys = new Set(keys);
    },
    setMouseDelta(dx: number, dy: number): void {
      mvx += dx;
      mvy += dy;
    },
  };
}

describe('learn-render section 1.7 camera InputSnapshot frame-start scan (AC-07 + plan-strategy D-5)', () => {
  it('AC-07 (a): InputFrameStartScan writes InputSnapshot Resource each world.update(1 / 60).unwrap()', () => {
    const backend = fixtureBackend();
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, backend);
    world.addSystem(Update, InputFrameStartScan);

    expect(world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)).toBe(false);
    world.update(1 / 60).unwrap();
    expect(world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)).toBe(true);
  });

  it('AC-07 (b): WASD held keys land in keyboard.down(...); absent keys return false', () => {
    const backend = fixtureBackend();
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, backend);
    world.addSystem(Update, InputFrameStartScan);

    backend.setHeldKeys(['w', 'a']);
    world.update(1 / 60).unwrap();
    let snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.keyboard.down('w')).toBe(true);
    expect(snap.keyboard.down('a')).toBe(true);
    expect(snap.keyboard.down('s')).toBe(false);
    expect(snap.keyboard.down('d')).toBe(false);

    backend.setHeldKeys(['s', 'd']);
    world.update(1 / 60).unwrap();
    snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.keyboard.down('w')).toBe(false);
    expect(snap.keyboard.down('s')).toBe(true);
    expect(snap.keyboard.down('d')).toBe(true);
  });

  it('AC-07 (c): mouse.movementDelta is per-frame; consecutive samples produce the slice each tick', () => {
    const backend = fixtureBackend();
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, backend);
    world.addSystem(Update, InputFrameStartScan);

    backend.setMouseDelta(7, -3);
    world.update(1 / 60).unwrap();
    let snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.mouse.movementDelta).toEqual({ x: 7, y: -3 });

    // Without any setMouseDelta call between updates, the next frame
    // delta is { 0, 0 } (the backend drained the accumulator).
    world.update(1 / 60).unwrap();
    snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.mouse.movementDelta).toEqual({ x: 0, y: 0 });

    // Two events in one frame accumulate into a single slice.
    backend.setMouseDelta(1, 1);
    backend.setMouseDelta(2, 4);
    world.update(1 / 60).unwrap();
    snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.mouse.movementDelta).toEqual({ x: 3, y: 5 });
  });

  it('AC-07 (d): up-edge appears in keyboard.up(...) for exactly one frame, then collapses', () => {
    const backend = fixtureBackend();
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, backend);
    world.addSystem(Update, InputFrameStartScan);

    backend.setUpKeys(['Escape']);
    world.update(1 / 60).unwrap();
    let snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.keyboard.up('Escape')).toBe(true);

    world.update(1 / 60).unwrap();
    snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(snap.keyboard.up('Escape')).toBe(false);
  });
});
