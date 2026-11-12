import type { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type { CompiledSceneEntity } from './keyed';

/**
 * Topological sort over the implicit ChildOf graph (parents before children).
 * Cycle-free input always covers all n nodes; cyclic input emits whatever was
 * reachable from indegree-0 (the fallback caller handles cycle reporting via
 * `pack-cyclic-reference` at the upstream scanner / runtime path).
 */
export function sceneTopoSort(
  world: World,
  nodes: readonly CompiledSceneEntity[],
): readonly number[] {
  if (!world.frameArena.isActive)
    return world.withFrameArena(() => ok(sceneTopoSort(world, nodes))).unwrap();
  const n = nodes.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  const indeg = world.frameArena.alloc(Uint32Array, n).unwrap();
  indeg.fill(0);
  const visited = world.frameArena.alloc(Uint8Array, n).unwrap();
  visited.fill(0);
  collectParentEdges(nodes, childrenOf, indeg);
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) if ((indeg[i] ?? 0) === 0) queue.push(i);
  while (queue.length > 0) {
    const head = queue.shift();
    if (head === undefined) break;
    order.push(head);
    visited[head] = 1;
    for (const c of childrenOf[head] ?? []) {
      indeg[c] = (indeg[c] ?? 0) - 1;
      if ((indeg[c] ?? 0) === 0) queue.push(c);
    }
  }
  // Append any nodes left unvisited (defensive — cycle would surface here).
  for (let i = 0; i < n; i += 1) {
    if (visited[i] === 0 && nodes[i] !== undefined) order.push(i);
  }
  return order;
}

/** Build parent adjacency once before Kahn traversal. */
function collectParentEdges(
  nodes: readonly CompiledSceneEntity[],
  childrenOf: number[][],
  indeg: Uint32Array,
): void {
  const n = nodes.length;
  const localIdToIdx = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    localIdToIdx.set(node.localId as unknown as number, i);
  }
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const child = node.components.ChildOf;
    if (child === undefined) continue;
    const p = (child as Record<string, unknown>).parent;
    if (typeof p === 'number') {
      const parentIdx = localIdToIdx.get(p);
      if (parentIdx !== undefined && parentIdx !== i) {
        childrenOf[parentIdx]?.push(i);
        indeg[i] = (indeg[i] ?? 0) + 1;
      }
    }
  }
}
