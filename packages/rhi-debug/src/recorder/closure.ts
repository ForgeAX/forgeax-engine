// @forgeax/engine-rhi-debug/src/recorder/closure -- transitive handle closure owner.

import { EVENT_SEMANTICS } from '../protocol/event-semantics';
import type { HandleId, RhiCallEvent } from '../types';

/** Handles frame events name; bootstrap creates they reach become prefix seeds. */
export function _collectFrameReferencedHandleIds(events: readonly RhiCallEvent[]): Set<HandleId> {
  const refs = new Set<HandleId>();
  for (const event of events)
    for (const id of EVENT_SEMANTICS[event.kind].read(event)) refs.add(id);
  return refs;
}

/**
 * @internal
 * Compute the transitive closure of handleIds from bootstrapCreates.
 *
 * Starting from the given seed set, recursively walks all referenced handleIds
 * via EVENT_SEMANTICS read edges. Returns the set of all handleIds
 * whose create events must be included in the tape prefix for self-containment.
 *
 * If a referenced handleId is not found in bootstrapCreates, returns
 * `null` for that id — the caller should produce a structured tape error.
 */
export function _computeClosure(
  seedHandleIds: Set<HandleId>,
  bootstrapCreates: Map<HandleId, RhiCallEvent>,
  inFrameHandleIds: Set<HandleId>,
): { closure: Set<HandleId>; missing: HandleId | null } {
  const closure = new Set(seedHandleIds);
  const queue = [...seedHandleIds];

  while (queue.length > 0) {
    const current: HandleId | undefined = queue.shift();
    if (current === undefined) break;
    const createEvent = bootstrapCreates.get(current);
    if (createEvent === undefined) {
      // The handle is not in bootstrapCreates. If it is declared in
      // s.events (e.g. swapchain textures from getCurrentTexture), treat it
      // as a leaf — no further expansion needed.
      if (inFrameHandleIds.has(current)) continue;
      return { closure, missing: current };
    }
    const edges = EVENT_SEMANTICS[createEvent.kind].read(createEvent);
    for (const target of edges) {
      if (!closure.has(target)) {
        closure.add(target);
        queue.push(target);
      }
    }
  }
  return { closure, missing: null };
}

/**
 * @internal
 * Topologically sort the closure set so that dependencies appear before dependents.
 *
 * Builds a dep-graph: if event A references handleId of event B, then B must
 * appear before A. Uses Kahn's algorithm.
 */
export function _topoSortClosure(
  closure: Set<HandleId>,
  bootstrapCreates: Map<HandleId, RhiCallEvent>,
): RhiCallEvent[] {
  const inDegree = new Map<HandleId, number>();
  const dependents = new Map<HandleId, HandleId[]>();

  for (const hId of closure) {
    inDegree.set(hId, 0);
    dependents.set(hId, []);
  }

  for (const hId of closure) {
    const event = bootstrapCreates.get(hId);
    if (event === undefined) continue;
    const edges = EVENT_SEMANTICS[event.kind].read(event);
    for (const target of edges) {
      if (closure.has(target)) {
        // hId depends on target
        const current = dependents.get(target);
        if (current !== undefined) current.push(hId);
        inDegree.set(hId, (inDegree.get(hId) ?? 0) + 1);
      }
    }
  }

  const queue: HandleId[] = [];
  for (const [hId, deg] of inDegree) {
    if (deg === 0) queue.push(hId);
  }

  const sorted: RhiCallEvent[] = [];
  while (queue.length > 0) {
    const current: HandleId | undefined = queue.shift();
    if (current === undefined) break;
    const event = bootstrapCreates.get(current);
    if (event !== undefined) sorted.push(event);

    const deps = dependents.get(current);
    if (deps !== undefined) {
      for (const dep of deps) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }
  }

  return sorted;
}

// ============================================================================
// DebugRhiInstance — public interface
// ============================================================================
