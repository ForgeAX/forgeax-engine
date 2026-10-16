// feat-20260517-spawn-default-fallback / M3 / t12.
//
// hello-window 4-field perspective spawn typecheck-style regression
// barrier (AC-02 + AC-08 + plan-strategy section 3.4 scenario S-A).
//
// The test is intentionally a leaf-level assertion that compiles +
// runs the SAME 4-field perspective spawn call hello-window:93 lands
// on after t13 collapses the call site from 9 fields to 4. AC-02
// "hello-window:93 missing fields no longer ts(2739)" surfaces here:
// before t13 wires `Camera.defaults` to the 5 ortho/projection
// fields, the mapped-tuple on `ComponentSpec<S>['data']` requires
// callers to pass all 9 fields and the test fails to typecheck.
// After t13, layer-2 token defaults fill `projection` + the four
// ortho columns and this file compiles + runs Green.
//
// AC-08 "hello-window example smoke all-Green" is the M4 smoke gate
// (t16 / t17); this fixture is the upstream regression barrier so
// M3 catches the typecheck regression locally before M4 spends real
// dawn-node minutes.
//
// Anchors: requirements section AC-02 + AC-08; plan-strategy
// section 3.3 + section 3.4 scenario S-A + section 8.1 (4-field
// perspective is the documented spawn shape); plan-tasks.json t12
// acceptanceCheck.

import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { Camera } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

// CAMERA_PROJECTION_PERSPECTIVE numeric encoding (0) is duplicated here
// rather than imported -- the runtime barrel export of the constant is
// out of scope for this loop; the literal 0 is the layer-2 token
// default Camera ships in M3 / t13.
const PROJECTION_PERSPECTIVE = 0;

describe('hello-window 4-field perspective spawn shape (AC-02 + AC-08)', () => {
  it('world.spawn({ component: Camera, data: { fov, aspect, near, far } }) typechecks + runs', () => {
    const world = new World();
    // The 4-field call site below is byte-equivalent to the form
    // hello-window/src/index.ts line 93 lands on after t13.
    const e = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
        },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 100,
          },
        },
      )
      .unwrap();
    const row = world.get(e, Camera).unwrap();

    // Token-defaults layer-2 fills projection + 4 ortho fields.
    expect(row.projection).toBe(PROJECTION_PERSPECTIVE);
    expect(row.left).toBe(-1);
    expect(row.right).toBe(1);
    expect(row.bottom).toBe(-1);
    expect(row.top).toBe(1);
    // Layer-1 explicit values pass through.
    expect(row.fov).toBeCloseTo(Math.PI / 4, 6);
    expect(row.aspect).toBe(1);
    expect(row.near).toBeCloseTo(0.1, 6);
    expect(row.far).toBe(100);
  });
});
