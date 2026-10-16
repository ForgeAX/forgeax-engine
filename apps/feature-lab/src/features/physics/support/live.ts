import type { World } from '@forgeax/engine/ecs';

/** physicsPlugin loads Rapier WASM asynchronously; resolve the resource once it is inserted. */
export async function waitForPhysicsWorld<T>(
  world: World,
  frames: (count: number) => Promise<void>,
  maxFrames = 600,
): Promise<{ readonly physics: T | undefined; readonly waitedFrames: number }> {
  for (let waited = 0; waited <= maxFrames; waited += 1) {
    const physics = tryResource<T>(world);
    if (physics !== undefined) return { physics, waitedFrames: waited };
    await frames(1);
  }
  return { physics: undefined, waitedFrames: maxFrames };
}

export function tryResource<T>(world: World, key = 'PhysicsWorld'): T | undefined {
  return world.hasResource(key) ? world.getResource<T>(key) : undefined;
}

export async function waitUntil(
  frames: (count: number) => Promise<void>,
  condition: () => boolean,
  maxFrames = 300,
): Promise<number | undefined> {
  for (let waited = 0; waited <= maxFrames; waited += 1) {
    if (condition()) return waited;
    await frames(1);
  }
  return undefined;
}
