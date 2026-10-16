// @forgeax/engine-animation -- AnimationGraph cluster structured errors.
//
// feat-20260713-animation-state-machine-plugin M2 / w14: defineAnimationGraph
// validates graph topology at CONSTRUCTION time (plan D-5) -- before a GUID
// handle is minted, so an illegal graph can never be registered or serialized
// into a pack (AC-14). Each illegal shape returns a structured error carrying a
// machine-readable `.code` / `.hint` / `.detail` so AI users self-repair by
// property access without parsing prose (requirements AC-11, charter P3). This
// mirrors the player-errors.ts convention (code/expected/hint/detail
// four-field surface + closed code union + closed error union).

// -- AnimationGraphEmptyError ----------------------------------------------------

/**
 * Structured error for an empty graph (zero nodes).
 *
 *   - `.code = 'animation-graph-empty'`
 *   - `.expected` -- a graph declares at least one node
 *   - `.hint` -- add at least one clip/blend/add node before returning the root
 */
export class AnimationGraphEmptyError extends Error {
  readonly code = 'animation-graph-empty' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    super('AnimationGraph is empty: the builder produced zero nodes');
    this.name = 'AnimationGraphEmptyError';
    this.expected = 'an AnimationGraph declares at least one node';
    this.hint =
      'declare at least one clip/blend/add node inside defineAnimationGraph(...) and return its ref as the root';
  }
}

// -- AnimationGraphNodeOutOfRangeError -------------------------------------------

/** Detail for `'animation-graph-node-out-of-range'`. */
export interface AnimationGraphNodeOutOfRangeDetail {
  /** Index of the node holding the offending reference, or the graph root. */
  readonly node: number;
  /** The out-of-range reference value that was encountered. */
  readonly ref: number;
  /** Total node count -- valid refs live in `[0, nodeCount)`. */
  readonly nodeCount: number;
}

/**
 * Structured error for a node reference that points outside `[0, nodeCount)`.
 *
 *   - `.code = 'animation-graph-node-out-of-range'`
 *   - `.expected` -- every child/base/additive/root ref is in `[0, nodeCount)`
 *   - `.hint` -- reference only node refs returned by the builder in this graph
 *   - `.detail = { node, ref, nodeCount }`
 */
export class AnimationGraphNodeOutOfRangeError extends Error {
  readonly code = 'animation-graph-node-out-of-range' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationGraphNodeOutOfRangeDetail;

  constructor(detail: AnimationGraphNodeOutOfRangeDetail) {
    const { node, ref, nodeCount } = detail;
    super(
      `AnimationGraph node ${node} references out-of-range node ${ref} (graph has ${nodeCount} nodes)`,
    );
    this.name = 'AnimationGraphNodeOutOfRangeError';
    this.expected = 'every node reference is a valid index in [0, nodeCount)';
    this.hint = `node ${node} references index ${ref}, but valid indices are 0..${nodeCount - 1}; reference only node refs returned by the builder in this graph`;
    this.detail = detail;
  }
}

// -- AnimationGraphNodeWeightInvalidError ----------------------------------------

/** Detail for `'animation-graph-node-weight-invalid'`. */
export interface AnimationGraphNodeWeightInvalidDetail {
  /** Index of the node whose static weight is invalid. */
  readonly node: number;
  /** The offending weight value (negative or non-finite / NaN). */
  readonly weight: number;
}

/**
 * Structured error for a negative or non-finite (NaN / Infinity) static weight.
 *
 *   - `.code = 'animation-graph-node-weight-invalid'`
 *   - `.expected` -- every node static weight is a finite value `>= 0`
 *   - `.hint` -- pass a finite non-negative weight (Add layers may exceed 1)
 *   - `.detail = { node, weight }`
 */
export class AnimationGraphNodeWeightInvalidError extends Error {
  readonly code = 'animation-graph-node-weight-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationGraphNodeWeightInvalidDetail;

  constructor(detail: AnimationGraphNodeWeightInvalidDetail) {
    const { node, weight } = detail;
    super(`AnimationGraph node ${node} has an invalid static weight ${weight}`);
    this.name = 'AnimationGraphNodeWeightInvalidError';
    this.expected = 'every node static weight is a finite number >= 0';
    this.hint = `node ${node} has weight ${weight}; pass a finite non-negative static weight (Add layers may sum above 1, but a single node weight must be >= 0)`;
    this.detail = detail;
  }
}

// -- AnimationGraphCycleError ----------------------------------------------------

/** Detail for `'animation-graph-cycle'`. */
export interface AnimationGraphCycleDetail {
  /** A node index that participates in the detected cycle (the back edge). */
  readonly node: number;
}

/**
 * Structured error for a cycle in the (must-be-acyclic) graph.
 *
 *   - `.code = 'animation-graph-cycle'`
 *   - `.expected` -- the graph is a DAG (no node reaches itself)
 *   - `.hint` -- remove the self/back reference so the graph is acyclic
 *   - `.detail = { node }`
 */
export class AnimationGraphCycleError extends Error {
  readonly code = 'animation-graph-cycle' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationGraphCycleDetail;

  constructor(detail: AnimationGraphCycleDetail) {
    const { node } = detail;
    super(`AnimationGraph contains a cycle reachable from node ${node}`);
    this.name = 'AnimationGraphCycleError';
    this.expected = 'the AnimationGraph is a DAG (no node reaches itself)';
    this.hint = `node ${node} participates in a cycle; a graph must be acyclic -- remove the self/back reference so no node transitively references itself`;
    this.detail = detail;
  }
}

// -- AnimationGraphClipMissingError ----------------------------------------------

/** Detail for `'animation-graph-clip-missing'`. */
export interface AnimationGraphClipMissingDetail {
  /** Index of the clip node whose `shared<AnimationClip>` handle failed to resolve. */
  readonly node: number;
  /** The raw clip handle that did not resolve (never registered / rc released). */
  readonly clip: number;
}

/**
 * Structured error for a graph clip leaf whose `shared<AnimationClip>` handle
 * cannot be resolved at evaluation time (never registered, or its refcount was
 * released). Raised by `evaluateAnimationGraph` (M3 / w25) BEFORE any derived
 * slot is written, so a dangling clip never leaves a dirty pose (requirements
 * AC-11 clip-missing branch, plan §8). Unlike the construction-time
 * {@link AnimationGraphError} shapes, this is an EVALUATION-time error: it is not
 * part of `defineAnimationGraph`'s `Result` (topology is validated at build, clip
 * liveness only at eval), so it stays out of the construction closed union.
 *
 *   - `.code = 'animation-graph-clip-missing'`
 *   - `.expected` -- every clip node's handle resolves to a live AnimationClip
 *   - `.hint` -- keep the clip asset registered (rc retained) while the graph
 *     references it
 *   - `.detail = { node, clip }`
 */
export class AnimationGraphClipMissingError extends Error {
  readonly code = 'animation-graph-clip-missing' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationGraphClipMissingDetail;

  constructor(detail: AnimationGraphClipMissingDetail) {
    const { node, clip } = detail;
    super(`AnimationGraph clip node ${node} references unresolved AnimationClip handle ${clip}`);
    this.name = 'AnimationGraphClipMissingError';
    this.expected = 'every clip node handle resolves to a live AnimationClip';
    this.hint = `clip node ${node} references AnimationClip handle ${clip}, which did not resolve; keep the clip asset registered (refcount retained) for as long as the graph references it`;
    this.detail = detail;
  }
}

// -- AnimationGraphErrorCode / AnimationGraphError closed unions ------------------

/**
 * Closed union of AnimationGraph-cluster error codes. AI users perform
 * exhaustive `switch (err.code)` without default; TS guards completeness.
 */
export type AnimationGraphErrorCode =
  | 'animation-graph-empty'
  | 'animation-graph-node-out-of-range'
  | 'animation-graph-node-weight-invalid'
  | 'animation-graph-cycle';

/**
 * Closed union of the AnimationGraph-cluster structured error classes, each
 * carrying an `AnimationGraphErrorCode` discriminant on `.code`.
 */
export type AnimationGraphError =
  | AnimationGraphEmptyError
  | AnimationGraphNodeOutOfRangeError
  | AnimationGraphNodeWeightInvalidError
  | AnimationGraphCycleError;
