import { World } from '@forgeax/engine-ecs';
import { Fog } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { buildFogWorld } from '../fog.js';

function fogCount(world: World): number {
  return Array.from(world.query({ read: [Fog] }).unwrap()).length;
}

describe('Fog demo controller transitions', () => {
  it('reattaches after Off and keeps one owner across active mode changes', () => {
    const world = new World();
    const controller = buildFogWorld(world);

    expect(controller.currentPhase()).toBe('height');
    expect(fogCount(world)).toBe(1);

    controller.setPhase('disabled');
    expect(fogCount(world)).toBe(0);

    controller.setPhase('height');
    expect(fogCount(world)).toBe(1);

    controller.setPhase('uniform');
    expect(fogCount(world)).toBe(1);

    controller.setPhase('height');
    expect(fogCount(world)).toBe(1);
  });
});
