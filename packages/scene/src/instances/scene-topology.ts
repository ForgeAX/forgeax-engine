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
  const indeg = world.frameArena.alloc(Uint32Array, n).unwrap();
  indeg.fill(0);
  const visited = world.frameArena.alloc(Uint8Array, n).unwrap();
  visited.fill(0);
  const steps = sceneTopoSortWithStorage(nodes, indeg, visited, false);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Owned scratch may span continuations; no FrameArena view escapes a frame. */
export function* sceneTopoSortSteps(
  nodes: readonly CompiledSceneEntity[],
): Generator<void, readonly number[], void> {
  yield;
  return yield* sceneTopoSortWithStorage(
    nodes,
    new Uint32Array(nodes.length),
    new Uint8Array(nodes.length),
    true,
  );
}

function* sceneTopoSortWithStorage(
  nodes: readonly CompiledSceneEntity[],
  indeg: Uint32Array,
  visited: Uint8Array,
  incremental: boolean,
): Generator<void, readonly number[], void> {
  const n = nodes.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  yield* collectParentEdgesSteps(nodes, childrenOf, indeg, incremental);
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (incremental) yield;
    if ((indeg[i] ?? 0) === 0) queue.push(i);
  }
  let cursor = 0;
  while (cursor < queue.length) {
    if (incremental) yield;
    const head = queue[cursor++];
    if (head === undefined) break;
    order.push(head);
    visited[head] = 1;
    for (const c of childrenOf[head] ?? []) {
      if (incremental) yield;
      indeg[c] = (indeg[c] ?? 0) - 1;
      if ((indeg[c] ?? 0) === 0) queue.push(c);
    }
  }
  // Append any nodes left unvisited (defensive — cycle would surface here).
  for (let i = 0; i < n; i += 1) {
    if (incremental) yield;
    if (visited[i] === 0 && nodes[i] !== undefined) order.push(i);
  }
  return order;
}

/** Build parent adjacency once before Kahn traversal. */
function* collectParentEdgesSteps(
  nodes: readonly CompiledSceneEntity[],
  childrenOf: number[][],
  indeg: Uint32Array,
  incremental: boolean,
): Generator<void, void, void> {
  const n = nodes.length;
  const localIdToIdx = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    if (incremental) yield;
    const node = nodes[i];
    if (node === undefined) continue;
    localIdToIdx.set(node.localId as unknown as number, i);
  }
  for (let i = 0; i < n; i += 1) {
    if (incremental) yield;
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
