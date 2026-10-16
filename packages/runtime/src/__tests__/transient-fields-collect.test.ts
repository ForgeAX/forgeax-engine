import * as SceneOwner from '@forgeax/engine-scene';
// feat-20260709-component-vec-fields-and-field-transient-batch M1 / w1 + w2:
//   w1: AC-07 transient exclusion tests for SpriteAnimation and VideoPlayer.
//   w2: AC-08 round-trip + rebuild tests for SpriteAnimation and VideoPlayer.
//
// TDD red-phase: these assertions will FAIL before w3 lands the transient
// declarations, then turn green after w3 adds transient: true to the
// relevant fields.
//
// Rebuild points (research Finding 9):
//   - currentFrame + accumDt ← spriteAnimationTickSystem (sprite-animation-tick.ts:255-256)
//   - VideoPlayer.currentTime: NO ECS rebuild system (D-R2); playback head on host HTMLVideoElement

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { VideoPlayer } from '@forgeax/engine-graphics-extras';
import { SpriteAnimation } from '@forgeax/engine-render/authoring';
import type { SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerRuntimeComponents } from './helpers/register-runtime-components';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function compField(entity: SceneEntity, compName: string, fieldName: string): unknown {
  const comp = (entity.components as Record<string, Record<string, unknown>>)[compName];
  return comp?.[fieldName];
}

function hasComp(entity: SceneEntity, compName: string): boolean {
  return (entity.components as Record<string, Record<string, unknown>>)[compName] !== undefined;
}

describe('w1 — AC-07 transient exclusion (SpriteAnimation, VideoPlayer)', () => {
  it('SpriteAnimation: currentFrame and accumDt are absent from collect output', () => {
    const world = new World();
    registerRuntimeComponents(world);
    const e = world.spawn({
      component: SpriteAnimation,
      data: { frameCount: 4, frameDuration: 0.1, regions: new Float32Array(16) },
    });
    if (!e.ok) return expect(e.ok).toBe(true);

    const reg = makeRegistry();
    const collected = rootsToSceneAsset(reg, world, [e.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const entity = Object.values(collected.value.entities)[0];
    expect(entity).toBeDefined();
    if (!entity) return;

    // SpriteAnimation component should be present (it is not transient at component level).
    expect(hasComp(entity, 'SpriteAnimation')).toBe(true);

    // currentFrame and accumDt are runtime state — should be excluded.
    expect(compField(entity, 'SpriteAnimation', 'currentFrame')).toBeUndefined();
    expect(compField(entity, 'SpriteAnimation', 'accumDt')).toBeUndefined();

    // Other fields (frameCount, frameDuration, playbackMode) should be present.
    expect(compField(entity, 'SpriteAnimation', 'frameCount')).toBe(4);
    expect(compField(entity, 'SpriteAnimation', 'frameDuration')).toBeCloseTo(0.1, 5);
    expect(compField(entity, 'SpriteAnimation', 'playbackMode')).toBe(0);
  });

  it('VideoPlayer: currentTime is absent from collect output', () => {
    const world = new World();
    registerRuntimeComponents(world);
    const e = world.spawn({
      component: VideoPlayer,
      data: { playing: true, loop: false, currentTime: 5.5 },
    });
    if (!e.ok) return expect(e.ok).toBe(true);

    const reg = makeRegistry();
    const collected = rootsToSceneAsset(reg, world, [e.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const entity = Object.values(collected.value.entities)[0];
    expect(entity).toBeDefined();
    if (!entity) return;

    // VideoPlayer component should be present.
    expect(hasComp(entity, 'VideoPlayer')).toBe(true);

    // currentTime is runtime state (playback head on host HTMLVideoElement) — should be excluded.
    expect(compField(entity, 'VideoPlayer', 'currentTime')).toBeUndefined();

    // Other fields should be present.
    expect(compField(entity, 'VideoPlayer', 'playing')).toBe(true);
    expect(compField(entity, 'VideoPlayer', 'loop')).toBe(false);
  });
});

describe('w2 — AC-08 round-trip tests (SpriteAnimation, VideoPlayer)', () => {
  it('SpriteAnimation: currentFrame/accumDt excluded, round-trip defaults to 0', () => {
    const world = new World();
    registerRuntimeComponents(world);
    const e = world.spawn({
      component: SpriteAnimation,
      data: {
        frameCount: 4,
        frameDuration: 0.1,
        regions: new Float32Array(16),
        currentFrame: 3,
        accumDt: 0.5,
      },
    });
    if (!e.ok) return expect(e.ok).toBe(true);

    const reg = makeRegistry();
    const collected = rootsToSceneAsset(reg, world, [e.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const entity = Object.values(collected.value.entities)[0];
    expect(entity).toBeDefined();
    if (!entity) return;

    // Transient fields excluded.
    expect(compField(entity, 'SpriteAnimation', 'currentFrame')).toBeUndefined();
    expect(compField(entity, 'SpriteAnimation', 'accumDt')).toBeUndefined();

    // Round-trip: instantiate the collected scene → read ECS state directly.
    const handle = world.allocSharedRef('SceneAsset', collected.value);
    const inst = SceneOwner.worldInstantiateScene(
      world,
      handle as Parameters<typeof SceneOwner.worldInstantiateScene>[1],
    );
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // Find the SpriteAnimation entity in the instantiated descendant tree.
    let saEnt: EntityHandle | undefined;
    for (const desc of world.iterDescendants(inst.value.root)) {
      const v = world.get(desc, SpriteAnimation);
      if (v.ok) {
        saEnt = desc;
        break;
      }
    }
    expect(saEnt).toBeDefined();
    if (!saEnt) return;
    const saVal = world.get(saEnt, SpriteAnimation);
    expect(saVal.ok).toBe(true);
    if (!saVal.ok) return;
    // currentFrame and accumDt default to 0 (layer-3 fallback for u32/f32).
    expect(saVal.value.currentFrame).toBe(0);
    expect(saVal.value.accumDt).toBe(0);
    // Other fields survive round-trip.
    expect(saVal.value.frameCount).toBe(4);
    expect(saVal.value.frameDuration).toBeCloseTo(0.1, 5);
  });

  it('VideoPlayer: currentTime excluded, round-trip defaults to 0 (D-R2: no system rebuild)', () => {
    // Per D-R2: VideoPlayer.currentTime has NO ECS rebuild system.
    // The playback head is authoritative on the host HTMLVideoElement.
    // This test asserts exclusion + round-trip to default 0 only.
    const world = new World();
    registerRuntimeComponents(world);
    const e = world.spawn({
      component: VideoPlayer,
      data: { playing: true, loop: true, currentTime: 42.0 },
    });
    if (!e.ok) return expect(e.ok).toBe(true);

    const reg = makeRegistry();
    const collected = rootsToSceneAsset(reg, world, [e.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const entity = Object.values(collected.value.entities)[0];
    expect(entity).toBeDefined();
    if (!entity) return;

    // currentTime excluded.
    expect(compField(entity, 'VideoPlayer', 'currentTime')).toBeUndefined();

    // Round-trip: instantiate the collected scene → read ECS state directly.
    const handle = world.allocSharedRef('SceneAsset', collected.value);
    const inst = SceneOwner.worldInstantiateScene(
      world,
      handle as Parameters<typeof SceneOwner.worldInstantiateScene>[1],
    );
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // Find the VideoPlayer entity in the instantiated descendant tree.
    let vpEnt: EntityHandle | undefined;
    for (const desc of world.iterDescendants(inst.value.root)) {
      const v = world.get(desc, VideoPlayer);
      if (v.ok) {
        vpEnt = desc;
        break;
      }
    }
    expect(vpEnt).toBeDefined();
    if (!vpEnt) return;
    const vpVal = world.get(vpEnt, VideoPlayer);
    expect(vpVal.ok).toBe(true);
    if (!vpVal.ok) return;
    expect(vpVal.value.currentTime).toBe(0);
    expect(vpVal.value.playing).toBe(true);
    expect(vpVal.value.loop).toBe(true);
  });
});
