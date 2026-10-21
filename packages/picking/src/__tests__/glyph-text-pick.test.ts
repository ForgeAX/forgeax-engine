import { samplerContribution } from '../../../render/src/assets/asset-decoders';
// glyph-text-pick.test.ts — pick() hits a baked GlyphText entity (AC-13).
//
// Extracted from packages/runtime/src/__tests__/text.unit.test.ts (the
// "from glyph-text-pick.test.ts" block) in feat-20260705 M2 / w25 when the pick
// cluster moved to @forgeax/engine-picking. Runtime can no longer import the
// picking package (AC-203), so this cross-cutting test (glyph text bake + pick)
// lives in the downstream picking package that depends on runtime.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { CAMERA_PROJECTION_PERSPECTIVE, Camera } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, FontAsset, GlyphMetric } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { pick } from '../pick';
import { pickTriangle } from '../pick-triangle';
import { pickVertex } from '../pick-vertex';

describe('glyph-text-pick', () => {
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

  function registerFont(assets: AssetRegistry, chars: string): AssetHandle<'font'> {
    const glyphs: Record<number, GlyphMetric> = {};
    for (const ch of chars) glyphs[ch.codePointAt(0) as number] = metric();
    const font: FontAsset = {
      kind: 'font',
      atlas: assets
        .create({
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          mips: { kind: 'none' },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          data: new Uint8Array([255, 255, 255, 255]),
        })
        .unwrap(),
      sampler: assets.create({ kind: 'sampler' }).unwrap(),
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
    return assets.create(font).unwrap();
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

  function spawnLabel(world: World, fontId: AssetHandle<'font'>): EntityHandle {
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
            fontHandle: fontId,
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
      const assets = new AssetRegistry();
      assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
      const world = new World({ assets });
      const fontId = registerFont(assets, 'Hi');
      const camera = spawnCamera(world, 5);
      const label = spawnLabel(world, fontId);

      propagateTransforms(world);

      const hit = pick(world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeDefined();
      expect(hit?.entity).toBe(label);
    });
  });
  it('queries adopted Font geometry without a render or a derived component', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const world = new World({ assets });
    const font = registerFont(assets, 'A');
    assets
      .update(font, {
        glyphs: { 65: { ...metric(), advance: 1, bearingX: 0, bearingY: 0, size: { w: 1, h: 1 } } },
      })
      .unwrap();
    const camera = spawnCamera(world, 5);
    const label = spawnLabel(world, font);
    world.set(label, GlyphText, { text: 'A', fontSize: 1 }).unwrap();
    world.set(label, Transform, { pos: [-1.5, -0.5, 0] }).unwrap();
    propagateTransforms(world);
    expect(pickTriangle(world, camera, VP / 2, VP / 2, VP, VP).status).toBe('miss');
    assets
      .update(font, {
        glyphs: { 65: { ...metric(), advance: 2, bearingX: 0, bearingY: 0, size: { w: 2, h: 1 } } },
      })
      .unwrap();
    expect(pick(world, camera, VP / 2, VP / 2, VP, VP)?.entity).toBe(label);
    const precise = pickTriangle(world, camera, VP / 2, VP / 2, VP, VP);
    expect(precise.status).toBe('hit');
    if (precise.status === 'hit') {
      expect(precise.hit.entity).toBe(label);
      expect(precise.hit.assetHandle).toBeUndefined();
    }
    expect(pickVertex(world, camera, VP / 2, VP / 2, VP, VP)?.entity).toBe(label);
    assets.dispose();
  });

  it('exact queries use the camera-facing billboard basis', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const world = new World({ assets });
    const font = registerFont(assets, 'A');
    assets
      .update(font, {
        glyphs: {
          65: { ...metric(), advance: 1, bearingX: -0.5, bearingY: 0.5, size: { w: 1, h: 1 } },
        },
      })
      .unwrap();
    const camera = spawnCamera(world, 5);
    const label = spawnLabel(world, font);
    world.set(label, GlyphText, { text: 'A', fontSize: 1 }).unwrap();
    world
      .set(camera, Transform, { pos: [5, 0, 0], quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] })
      .unwrap();
    propagateTransforms(world);
    const precise = pickTriangle(world, camera, VP / 2, VP / 2, VP, VP);
    expect(precise.status).toBe('hit');
    if (precise.status === 'hit') expect(precise.hit.entity).toBe(label);
    assets.dispose();
  });
});
