import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeAnimationDiagnostics } from '../animation-diagnostic';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { animationPlugin } from '../plugin';

const TARGET_ID = 'a95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;
const INVALID_TARGET_ID = 'f'.repeat(32) as AnimationTargetIdValue;

function clip(): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId: TARGET_ID,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 4, 0, 0]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

async function spawnAnimatedPair(world: World): Promise<{
  brokenPlayer: EntityHandle;
  brokenTarget: EntityHandle;
  healthyTarget: EntityHandle;
}> {
  const handle = world.allocSharedRef('AnimationClip', clip());
  const spawn = (name: string) => {
    const player = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: name } },
        {
          component: AnimationPlayer,
          data: { clips: [handle], times: [0], weights: [1], speeds: [1] },
        },
      )
      .unwrap() as EntityHandle;
    const target = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: 'Joint' } },
        { component: ChildOf, data: { parent: player } },
        { component: AnimationTargetId, data: { value: TARGET_ID } },
      )
      .unwrap() as EntityHandle;
    expect(bindAnimationTargets(world, player, [target]).ok).toBe(true);
    return { player, target };
  };

  const broken = spawn('Broken');
  const healthy = spawn('Healthy');
  return {
    brokenPlayer: broken.player,
    brokenTarget: broken.target,
    healthyTarget: healthy.target,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function positionX(world: World, entity: EntityHandle): number {
  return world.get(entity, Transform).unwrap().pos[0] ?? 0;
}

describe('same-world animation binding recovery', () => {
  it('keeps healthy siblings alive and repairs a missing target binding without rebuilding the world', async () => {
    const world = new World();
    await createWorldContext(world, [scenePlugin()]);
    await createWorldContext(world, [animationPlugin()]);
    const { brokenPlayer, brokenTarget, healthyTarget } = await spawnAnimatedPair(world);
    const diagnostics: unknown[] = [];
    const unsubscribe = subscribeAnimationDiagnostics((source, diagnostic) => {
      if (source === world) diagnostics.push(diagnostic);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    world.update(0.2);
    const healthyBeforeFault = positionX(world, healthyTarget);
    const brokenBeforeFault = positionX(world, brokenTarget);

    world.set(brokenTarget, AnimationTargetId, { value: INVALID_TARGET_ID }).unwrap();
    world.update(0.2);

    const healthyDuringFault = positionX(world, healthyTarget);
    const brokenDuringFault = positionX(world, brokenTarget);
    expect(healthyDuringFault).toBeGreaterThan(healthyBeforeFault);
    expect(brokenDuringFault).toBeCloseTo(brokenBeforeFault);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'animation-target-missing',
        detail: expect.objectContaining({
          player: brokenPlayer as number,
          targetId: TARGET_ID,
          reason: 'target-missing',
        }),
      }),
    );

    const diagnosticCountAtFault = diagnostics.length;
    world.set(brokenTarget, AnimationTargetId, { value: TARGET_ID }).unwrap();
    world.update(0.2);

    const brokenAfterRepair = positionX(world, brokenTarget);
    expect(brokenAfterRepair).toBeGreaterThan(brokenDuringFault);
    expect(diagnostics).toHaveLength(diagnosticCountAtFault);
    expect(warn).toHaveBeenCalledTimes(diagnosticCountAtFault);

    unsubscribe();
    unsubscribe();
    expect(world.despawn(brokenPlayer).ok).toBe(true);
  });
});
