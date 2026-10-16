// feat-20260617 M3 / w8: Camera.autoAspect bool-column storage.
//
// The `autoAspect` field is a `bool` column on the Camera schema. The bool
// column tier already exists (component.ts:53/736/763/868, used by
// AnimationPlayer.paused / AudioSource.playing); Camera reuses it (plan
// D-4: zero ECS infrastructure change).
//
// Read-path contract (research Finding 2 / D-5): the `world.get(e, Camera)`
// readRow path narrows a bool column to a JS boolean. The query-bundle path
// returns the raw 0/1 number instead -- the aspect-sync sidecar therefore
// reads autoAspect via world.get, never via the bundle (avoids the
// `bundle.autoAspect[i] !== 0` always-true trap; memory
// bool-field-compared-with-not-equal-zero-always-true). This file only
// exercises the world.get path.

import { World } from '@forgeax/engine-ecs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Camera, perspective } from '../../../../render/src/components/camera';

describe('camera.ts autoAspect bool column (w8)', () => {
  it('world.get(cam, Camera).autoAspect reads a JS boolean, not a number', () => {
    const world = new World();
    const cam = world
      .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) })
      .unwrap();

    const r = world.get(cam, Camera);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.value.autoAspect).toBe('boolean');
  });

  it('defaults to true when autoAspect is not supplied', () => {
    const world = new World();
    const cam = world
      .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) })
      .unwrap();

    const r = world.get(cam, Camera);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.autoAspect).toBe(true);
  });

  it('world.set(cam, Camera, { autoAspect: false }) takes effect and reads back false', () => {
    const world = new World();
    const cam = world
      .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) })
      .unwrap();

    world.set(cam, Camera, { autoAspect: false }).unwrap();

    const r = world.get(cam, Camera);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.autoAspect).toBe(false);
  });
});

// feat-20260617 M3 / w9: perspective({ autoAspect }) factory opt-out + the
// AC-09 type-inference surface (autoAspect resolves to `boolean` without an
// `as` cast; CameraPerspectiveOpts.autoAspect is `boolean | undefined`).
describe('camera.ts perspective autoAspect opt-out (w9)', () => {
  it('perspective() leaves autoAspect at the schema default (true)', () => {
    const world = new World();
    const cam = world
      .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) })
      .unwrap();

    const r = world.get(cam, Camera);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.autoAspect).toBe(true);
  });

  it('perspective({ autoAspect: false }) yields a CameraPod with autoAspect=false', () => {
    const pod = perspective({ fov: 1, aspect: 1, autoAspect: false });
    expect(pod.autoAspect).toBe(false);

    const world = new World();
    const cam = world.spawn({ component: Camera, data: pod }).unwrap();
    const r = world.get(cam, Camera);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.autoAspect).toBe(false);
  });

  it('AC-09: autoAspect inference is boolean on both the POD and the opts', () => {
    const pod = perspective({ fov: 1, aspect: 1 });
    expectTypeOf(pod.autoAspect).toEqualTypeOf<boolean>();
    expectTypeOf<Parameters<typeof perspective>[0]['autoAspect']>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});
