// glyph-text-pick.test.ts — pick() hits a baked GlyphText entity (AC-13).
//
// Extracted from packages/runtime/src/__tests__/text.unit.test.ts (the
// "from glyph-text-pick.test.ts" block) in feat-20260705 M2 / w25 when the pick
// cluster moved to @forgeax/engine-picking. Runtime can no longer import the
// picking package (AC-203), so this cross-cutting test (glyph text bake + pick)
// lives in the downstream picking package that depends on runtime.

import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { CAMERA_PROJECTION_PERSPECTIVE, Camera } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { FontAsset, GlyphMetric, Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import {
  glyphTextLayoutSystem,
  resetGlyphBakeCache,
} from '../../../render/src/glyph-text-layout-system';
import { pick } from '../pick';

describe('glyph-text-pick', () => {
  // Pick tests do not wire a GPU device; the residency store stays CPU-only.
  const gpuStore = new GpuResidencyCache();

  const VP = 600;

  function metric(): GlyphMetric {
    return {
      advance: 10,
      bearingX: 0,
      bearingY: 8,
      size: { w: 8, h: 8 },
      region: { x: 0, y: 0, w: 8, h: 8 },
    };
  }

  function registerFont(world: World, chars: string): number {
    const glyphs: Record<number, GlyphMetric> = {};
    for (const ch of chars) glyphs[ch.codePointAt(0) as number] = metric();
    const font: FontAsset = {
      kind: 'font',
      atlas: 0 as never,
      sampler: 0 as never,
      glyphs,
      common: {
        lineHeight: 12,
        base: 8,
        distanceRange: 4,
        pxRange: 4,
        atlasWidth: 64,
        atlasHeight: 64,
      },
    };
    return world.allocSharedRef('FontAsset', font) as unknown as number;
  }

  function makeWorld(): World {
    const world = new World();
    return world;
  }

  function spawnCamera(world: World, z: number): EntityHandle {
    return world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, z],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_PERSPECTIVE,
            left: -1,
            right: 1,
            bottom: -1,
            top: 1,
          },
        },
      )
      .unwrap();
  }

  function spawnLabel(world: World, fontId: number): EntityHandle {
    return world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        {
          component: GlyphText,
          data: {
            fontHandle: fontId as unknown as Handle<'FontAsset', 'shared'>,
            text: 'Hi',
            fontSize: 1,
            color: [1, 1, 1, 1],
          },
        },
      )
      .unwrap();
  }

  describe('glyph text pick (AC-13, pick.ts unchanged)', () => {
    it('(d) center-viewport ray hits the baked text entity', () => {
      resetGlyphBakeCache();
      const world = makeWorld();
      const fontId = registerFont(world, 'Hi');
      const camera = spawnCamera(world, 5);
      const label = spawnLabel(world, fontId);

      glyphTextLayoutSystem(world, gpuStore); // bake + attach MeshFilter + MeshRenderer
      propagateTransforms(world);

      const hit = pick(world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeDefined();
      expect(hit?.entity).toBe(label);
    });
  });
});
