// feat-20260709 M3 / w12: AC-04 negative type witnesses at real spawn
// call-sites.
//
// After the vec-collapse, the per-axis scalar keys (Camera clearR/G/B/A,
// GlyphText colorR/G/B/A, Tilemap tileSizeX/Y) no longer exist on any schema.
// A residual per-axis key in spawn `data` must be a COMPILE error. Each
// `@ts-expect-error` below is applied at a genuine `world.spawn({ component,
// data })` call-site (AC-04: standalone *.test-d.ts does NOT count -- the
// witness must sit on a real spawn surface). If a collapse regressed and the
// key were still accepted, the `@ts-expect-error` would itself become an
// unused-directive error and turn this file red.

import { World } from '@forgeax/engine-ecs';
import { Camera } from '@forgeax/engine-render';
import { describe, it } from 'vitest';
import { GlyphText } from '../../../render/src/components/glyph-text';
import { Tilemap } from '../../../render/src/components/tilemap';

describe('w12 -- residual per-axis M3 keys are compile errors (AC-04)', () => {
  it('Camera rejects residual clearR at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: Camera,
      // @ts-expect-error clearR/G/B/A were collapsed into the clearColor array.
      data: { fov: 1, aspect: 1, near: 0.1, far: 100, clearColor: [0, 0, 0, 1], clearR: 1 },
    });
  });

  it('GlyphText rejects residual colorR at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: GlyphText,
      // @ts-expect-error colorR/G/B/A were collapsed into the color array.
      data: { fontHandle: 0 as never, text: 'x', fontSize: 16, color: [1, 1, 1, 1], colorR: 1 },
    });
  });

  it('Tilemap rejects residual tileSizeX at spawn call-site', () => {
    const world = new World();
    world.spawn({
      component: Tilemap,
      // @ts-expect-error tileSizeX/tileSizeY were collapsed into the tileSize array.
      data: { cols: 4, rows: 4, tileSize: [1, 1], tileSizeX: 1 },
    });
  });
});
