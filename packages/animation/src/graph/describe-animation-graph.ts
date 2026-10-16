// @forgeax/engine-animation -- describeAnimationGraph machine-readable introspection.
//
// feat-20260713-animation-state-machine-plugin M2 / w15 (plan §8.4, AC-12):
//
//   const desc = describeAnimationGraph(graph);
//   desc.root;           // index of the output node (construction order)
//   desc.nodes;          // per-node { index, type, weight, children }
//   desc.staticWeights;  // per-node static weight, construction order
//
// AI users discover a graph's structure (nodes / topology / root / per-node
// static weights) WITHOUT reading implementation source -- mirroring the
// World-local component catalog reflection (research Finding H, charter F1/P1).
//
// Presentation order matches the graph POD construction order so that
// `desc.nodes[i].index === i` aligns with runtime `nodeWeights[i]` /
// `nodeTimes[i]` / `nodeSpeeds[i]` (verify V-1: introspect-then-drive path for
// shared/deserialized graphs must not silently remap indices). The builder must
// create a child ref before referencing it, so construction order is already a
// valid topological order. This is a pure, read-only projection of the validated
// POD -- no evaluation, no mutation.

import type { AnimationGraph, AnimationGraphNode } from '@forgeax/engine-types';
import { animationGraphNodeChildren } from './define-animation-graph';

/**
 * Machine-readable description of a single graph node: its index in the
 * construction order, its `type` discriminant, its static `weight`, and the
 * child node indices it references (construction order, canonical child ordering).
 */
export interface AnimationGraphNodeDescription {
  /** Index of this node in {@link AnimationGraphDescription.nodes} (construction order). */
  readonly index: number;
  /** Node kind discriminant (clip / blend / add). */
  readonly type: AnimationGraphNode['type'];
  /** The node's static weight (effective weight = runtime weight x static). */
  readonly weight: number;
  /** Child node indices referenced by this node (clip -> []), construction order. */
  readonly children: readonly number[];
}

/**
 * Machine-readable description of an entire {@link AnimationGraph}: the ordered
 * per-node descriptions (construction order), the root node index, and the
 * per-node static weights (a flat projection of each node's `weight`).
 */
export interface AnimationGraphDescription {
  /** Per-node descriptions, in graph POD construction order. */
  readonly nodes: readonly AnimationGraphNodeDescription[];
  /** Index of the graph's root (output) node, in construction order. */
  readonly root: number;
  /** Per-node static weights, in construction order. */
  readonly staticWeights: readonly number[];
}

/**
 * Enumerate a validated {@link AnimationGraph}'s nodes, topology, root, and
 * per-node static weights for machine-readable introspection (AC-12). Pure and
 * read-only -- returns a fresh description derived from the POD in construction
 * order so described indices match runtime `nodeWeights` indices.
 */
export function describeAnimationGraph(graph: AnimationGraph): AnimationGraphDescription {
  const nodes = graph.nodes.map((node, index) => ({
    index,
    type: node.type,
    weight: node.weight,
    children: animationGraphNodeChildren(node),
  }));

  return {
    nodes,
    root: graph.root,
    staticWeights: nodes.map((node) => node.weight),
  };
}
