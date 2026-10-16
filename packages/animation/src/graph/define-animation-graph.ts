// @forgeax/engine-animation -- defineAnimationGraph builder + construction-time
// topology validation.
//
// feat-20260713-animation-state-machine-plugin M2 / w14 (plan D-4 landing (2),
// D-5 construct-time validation):
//
//   const g = defineAnimationGraph((b) => {
//     const walk = b.clip(walkGuid);
//     const run = b.clip(runGuid);
//     const loco = b.blend([walk, run]);       // normalizing
//     const overlay = b.clip(overlayGuid, 0.3);
//     return b.add(loco, [overlay]);           // non-normalizing; returns root
//   });                                        // -> Result<AnimationGraph, AnimationGraphError>
//   if (!g.ok) return; // g.error.code / g.error.hint (AC-11)
//
// This is a pure library: NO evaluation system, NO AnimationPlayer change, NO
// loader/serialization (those are M3/M4). The builder assembles a flat node
// array and validates topology BEFORE returning ok(graph) -- an illegal graph
// (empty / out-of-range ref / cycle / invalid weight) fails fast with a
// structured error (charter P3, requirements AC-11) so it can never be minted
// into a GUID handle or serialized into a pack (AC-14).

import type { AnimationGraph, AnimationGraphNode } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  AnimationGraphCycleError,
  AnimationGraphEmptyError,
  type AnimationGraphError,
  AnimationGraphNodeOutOfRangeError,
  AnimationGraphNodeWeightInvalidError,
} from '../errors';

/**
 * Opaque reference to a node inside the graph under construction. Branded so a
 * raw number cannot be passed where a node ref is expected without an explicit
 * cast (the illegal-graph tests forge refs deliberately). At runtime it is the
 * node's index in {@link AnimationGraph.nodes}.
 */
export type AnimationGraphNodeRef = number & {
  readonly __animationGraphNodeRef: unique symbol;
};

/**
 * Declarative builder handed to the `defineAnimationGraph` callback. Exposes
 * exactly the three node kinds (clip / blend / add) + nesting -- no FSM /
 * transition / mask surface is reserved (OOS-1..4, charter F4). Each method
 * appends a node and returns its {@link AnimationGraphNodeRef}.
 */
export interface AnimationGraphBuilder {
  /** Add a Clip leaf sampling `clip` with the given static `weight` (default 1). */
  clip(clip: string, weight?: number): AnimationGraphNodeRef;
  /** Add a Blend node (normalizing lerp) over `children` with static `weight` (default 1). */
  blend(children: readonly AnimationGraphNodeRef[], weight?: number): AnimationGraphNodeRef;
  /** Add an Add node (non-normalizing) stacking `additive` layers onto `base`; static `weight` default 1. */
  add(
    base: AnimationGraphNodeRef,
    additive: readonly AnimationGraphNodeRef[],
    weight?: number,
  ): AnimationGraphNodeRef;
}

/**
 * Enumerate the child node indices a node references: clip -> none; blend ->
 * its children; add -> `[base, ...additive]`. Exhaustive over the closed node
 * union (charter P3). Shared by the validator here and describeAnimationGraph.
 */
export function animationGraphNodeChildren(node: AnimationGraphNode): readonly number[] {
  switch (node.type) {
    case 'clip':
      return [];
    case 'blend':
      return node.children;
    case 'add':
      return [node.base, ...node.additive];
  }
}

function makeBuilder(nodes: AnimationGraphNode[]): AnimationGraphBuilder {
  return {
    clip(clip, weight = 1) {
      const index = nodes.length;
      nodes.push({ type: 'clip', clip, weight });
      return index as AnimationGraphNodeRef;
    },
    blend(children, weight = 1) {
      const index = nodes.length;
      nodes.push({ type: 'blend', children: children.slice(), weight });
      return index as AnimationGraphNodeRef;
    },
    add(base, additive, weight = 1) {
      const index = nodes.length;
      nodes.push({ type: 'add', base, additive: additive.slice(), weight });
      return index as AnimationGraphNodeRef;
    },
  };
}

function findInvalidWeight(
  nodes: readonly AnimationGraphNode[],
): AnimationGraphNodeWeightInvalidError | null {
  for (let i = 0; i < nodes.length; i++) {
    const weight = nodes[i]?.weight ?? Number.NaN;
    if (!Number.isFinite(weight) || weight < 0) {
      return new AnimationGraphNodeWeightInvalidError({ node: i, weight });
    }
  }
  return null;
}

function isRef(ref: number, nodeCount: number): boolean {
  return Number.isInteger(ref) && ref >= 0 && ref < nodeCount;
}

function findOutOfRangeRef(
  nodes: readonly AnimationGraphNode[],
  root: number,
): AnimationGraphNodeOutOfRangeError | null {
  const nodeCount = nodes.length;
  if (!isRef(root, nodeCount)) {
    return new AnimationGraphNodeOutOfRangeError({ node: root, ref: root, nodeCount });
  }
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    if (node === undefined) continue;
    for (const ref of animationGraphNodeChildren(node)) {
      if (!isRef(ref, nodeCount)) {
        return new AnimationGraphNodeOutOfRangeError({ node: i, ref, nodeCount });
      }
    }
  }
  return null;
}

function findCycle(nodes: readonly AnimationGraphNode[]): AnimationGraphCycleError | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Uint8Array(nodes.length);
  let cycleNode = -1;

  const visit = (i: number): boolean => {
    color[i] = GRAY;
    const node = nodes[i];
    const children = node === undefined ? [] : animationGraphNodeChildren(node);
    for (const child of children) {
      if (color[child] === GRAY) {
        cycleNode = child;
        return true;
      }
      if (color[child] === WHITE && visit(child)) return true;
    }
    color[i] = BLACK;
    return false;
  };

  for (let i = 0; i < nodes.length; i++) {
    if (color[i] === WHITE && visit(i)) {
      return new AnimationGraphCycleError({ node: cycleNode });
    }
  }
  return null;
}

/**
 * Validate a graph's topology (order: empty -> invalid weight -> out-of-range
 * ref -> cycle). Returns the first structured error found, or null when the
 * graph is a well-formed DAG. Runs before a handle is minted (plan D-5).
 */
function validateAnimationGraph(
  nodes: readonly AnimationGraphNode[],
  root: number,
): AnimationGraphError | null {
  if (nodes.length === 0) return new AnimationGraphEmptyError();
  return findInvalidWeight(nodes) ?? findOutOfRangeRef(nodes, root) ?? findCycle(nodes);
}

/**
 * Construct an {@link AnimationGraph} declaratively. The callback receives a
 * builder, adds clip/blend/add nodes, and returns the ref of the root node.
 * The graph's topology is validated at construction time; on success the POD is
 * returned in `ok(graph)` ready to be minted into a `shared<AnimationGraph>`
 * handle (AC-02) and serialized (AC-14). On an illegal topology a structured
 * {@link AnimationGraphError} is returned in `err(...)` (AC-11).
 */
export function defineAnimationGraph(
  build: (builder: AnimationGraphBuilder) => AnimationGraphNodeRef,
): Result<AnimationGraph, AnimationGraphError> {
  const nodes: AnimationGraphNode[] = [];
  const root = build(makeBuilder(nodes)) as number;
  const error = validateAnimationGraph(nodes, root);
  if (error) return err(error);
  return ok({ kind: 'animation-graph', nodes, root });
}
