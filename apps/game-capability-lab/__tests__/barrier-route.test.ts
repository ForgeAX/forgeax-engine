import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { BarrierRoute, resolveBarrierImpact } from '../assets/plugins/barrier-route.js';
import { SCENE_GUID, sceneAssetGuid } from '../assets/plugins/scene-runtime.js';

describe('game-default charged barrier route', () => {
  it('starts dormant until the existing relay unlocks it', () => {
    const world = new World();
    const emitter = world.spawn({ component: BarrierRoute, data: {} }).unwrap();

    expect(world.get(emitter, BarrierRoute).unwrap()).toEqual({
      active: false,
      opens: 0,
      ordinaryHits: 0,
      alreadyOpenHits: 0,
    });
  });

  it('opens exactly once only for a real charged projectile impact', () => {
    expect(resolveBarrierImpact({ active: true, projectileContact: false, impactScale: 2 })).toBe('non-projectile');
    expect(resolveBarrierImpact({ active: true, projectileContact: true, impactScale: 1 })).toBe('ordinary');
    expect(resolveBarrierImpact({ active: true, projectileContact: true, impactScale: 1.01 })).toBe('open');
    expect(resolveBarrierImpact({ active: false, projectileContact: true, impactScale: 2 })).toBe('already-open');
  });

  it('authors one stable emitter and barrier guarding EnergyCoreAlpha', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Record<string, {
        payload: { entities?: Record<string, { components: Record<string, Record<string, unknown>> }> };
      }>;
    };
    expect(pack.assets['scene/main']).toBeDefined();
    expect(SCENE_GUID).toBe(sceneAssetGuid('scene/main'));
    const scene = pack.assets['scene/main'];
    const emitter = scene?.payload.entities?.barrieremitter;
    const barrier = scene?.payload.entities?.energybarrier;

    expect(emitter).toMatchObject({
      components: { Transform: { pos: [-4.2, 0.7, -1.5] } },
    });
    expect(barrier).toMatchObject({
      components: { Transform: { pos: [-2.5, 0.9, -1.5], scale: [3.4, 1.8, 0.16] } },
    });
  });
});
