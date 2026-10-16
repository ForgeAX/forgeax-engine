// @forgeax/engine-debug-draw -- constants SSOT (feat-20260615-debug-draw M1 / w3)
//
// Three configurable tunables exported for unit-test consumption.
// All values are per plan-strategy D-4 / D-7 / D-9.

/** Initial CPU staging vertex capacity before any resize. */
export const INITIAL_VERTEX_CAPACITY = 1024;

/** Hard upper bound on vertex count per flush; excess vertices are truncated with a warning. */
export const MAX_VERTEX_CAPACITY = 1_000_000;

/** Vertex stride in bytes: 12 B position (float32x3) + 4 B color (unorm8x4). */
export const VERTEX_STRIDE_BYTES = 16;
