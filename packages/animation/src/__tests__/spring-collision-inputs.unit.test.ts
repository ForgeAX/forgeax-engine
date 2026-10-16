import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import type { SpringBoneChain } from '../skeletal-motion-definition';
import { SkeletonPose } from '../skeleton-pose';
import { SpringBoneSimulation } from '../spring-bone';
import { deriveAnimationTargetId } from '../target-id';

describe('spring collision input projection', () => {
  it.each([
    1, 8, 16,
  ])('projects each live collider once per segment with %i iterations', (iterations) => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [0.25, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const tail = world
      .spawn(
        { component: Transform, data: { pos: [0.25, 0, 0] } },
        { component: ChildOf, data: { parent: child } },
      )
      .unwrap();
    const collider = world
      .spawn({ component: Transform, data: { pos: [0.125, -0.05, 0] } })
      .unwrap();
    const pose = new SkeletonPose(world, [root, child, tail, collider]);
    const readCenter = vi.fn();
    const center = new Proxy<[number, number, number]>([0, 0, 0], {
      get(target, property, receiver) {
        if (property === '0' || property === '1' || property === '2') readCenter();
        return Reflect.get(target, property, receiver);
      },
    });
    const definition: SpringBoneChain = {
      targets: ['root', 'child', 'tail'].map((name) => deriveAnimationTargetId([name])),
      stiffness: 30,
      damping: 6,
      gravity: [0, -9.81, 0],
      radius: 0.02,
      maxAngle: 1.8,
      iterations,
      collisions: [{ target: deriveAnimationTargetId(['collider']), center, radius: 0.1 }],
    };
    const simulation = new SpringBoneSimulation(
      definition,
      [root, child, tail].map((entity) => pose.indices.get(entity) as number),
      [pose.indices.get(collider) as number],
    );
    for (let tick = 0; tick < 60; tick++) {
      world.set(collider, Transform, { pos: [0.125 + (tick % 3) * 0.025, -0.05, 0] }).unwrap();
      pose.read();
      readCenter.mockClear();
      simulation.step(pose, 1 / 60);
      // One solver input and one fresh post-commit penetration observation
      // per segment. Iteration count must not repeat the immutable input.
      expect(readCenter).toHaveBeenCalledTimes(12);
      expect(simulation.maxLengthError).toBeLessThanOrEqual(1e-4);
      pose.validate();
    }
  });
});
