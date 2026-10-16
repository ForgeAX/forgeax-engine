// feat-20260709 M2 / w5a: AC-04 negative type witnesses at real spawn call-sites.
//
// After the vec-collapse, the per-axis scalar keys (directionX/Y/Z, colorR/G/B)
// no longer exist on any light schema. A residual per-axis key in spawn `data`
// is an excess-unknown-key -- a compile error. This is the compile-time half of
// the migration-completeness guarantee (research-decisions D-R1: the "omit
// direction" case is a runtime validate rejection, but a residual scalar KEY is
// still typecheck-red). Each `@ts-expect-error` below is applied at a genuine
// `world.spawn({ component, data })` call-site (AC-04: standalone *.test-d.ts
// type assertions do NOT count), so the vitest typecheck project enforces it.

import { World } from '@forgeax/engine-ecs';
import { DirectionalLight, PointLight, Skylight, SpotLight } from '@forgeax/engine-render';
import { describe, it } from 'vitest';

describe('w5a -- residual per-axis light keys are compile errors (AC-04)', () => {
  it('DirectionalLight rejects residual directionX/colorR at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: DirectionalLight,
      // @ts-expect-error directionX/colorR were collapsed into direction/color arrays.
      data: { direction: [0, -1, 0], directionX: 0, colorR: 1 },
    });
  });

  it('SpotLight rejects residual directionZ/colorG at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: SpotLight,
      // @ts-expect-error directionZ/colorG were collapsed into direction/color arrays.
      data: { direction: [0, -1, 0], directionZ: 0, colorG: 1 },
    });
  });

  it('PointLight rejects residual colorB at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: PointLight,
      // @ts-expect-error colorB was collapsed into the color array.
      data: { color: [1, 1, 1], colorB: 1 },
    });
  });

  it('Skylight rejects residual colorR at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: Skylight,
      // @ts-expect-error colorR was collapsed into the color array.
      data: { color: [1, 1, 1], colorR: 1 },
    });
  });
});
