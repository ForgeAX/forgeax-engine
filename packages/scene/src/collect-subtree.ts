// Scene-owned hierarchy traversal shared by scene collection and render hooks.

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';

import { Children } from './components/children';

/** Walk a Children hierarchy breadth-first, reusing an optional visited set. */
export function collectSubtree(
  world: World,
  spawnRoot: EntityHandle,
  visited?: Set<number>,
): Set<number> {
  if (visited === undefined) visited = new Set<number>();
  if (visited.has(spawnRoot as number)) return visited;
  const queue: number[] = [spawnRoot as number];
  visited.add(spawnRoot as number);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor] as number;
    // This synchronous traversal does not mutate storage. Borrow only the
    // requested mirror and finish consuming it before advancing the queue.
    const entities = readRenderArrayView(world, current as EntityHandle, Children, 'entities');
    if (entities === undefined) continue;
    for (let index = 0; index < entities.length; index += 1) {
      const child = entities[index] as number;
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return visited;
}
