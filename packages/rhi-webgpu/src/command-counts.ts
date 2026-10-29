/**
 * Always-on cumulative counts of the commands this realm encodes through
 * rhi-webgpu. Each wrapper adds an integer on its existing path; readers take
 * the difference of two snapshots (for example per submitted frame). The
 * counts are backend-call counts on the CPU side, identical with the WebGPU
 * stub and a real GPU, and say nothing about GPU execution time.
 */

/** Count fields, in report order. The single list behind every reader and helper. */
export const RHI_COMMAND_COUNT_KEYS = [
  'submits',
  'renderPasses',
  'computePasses',
  'draws',
  'pipelineSets',
  'bindGroupSets',
  'vertexBufferSets',
  'dispatches',
  'bundlesExecuted',
  'bundleDraws',
  'bundlePipelineSets',
  'bundleBindGroupSets',
  'bundleVertexBufferSets',
  'bindGroupCreates',
  'bufferCreates',
  'textureCreates',
  'bufferWrites',
  'bufferWriteBytes',
  'textureWrites',
  'textureWriteBytes',
] as const;

export type RhiCommandCountKey = (typeof RHI_COMMAND_COUNT_KEYS)[number];

/**
 * Pass fields count commands encoded into render and compute passes; `bundle*`
 * fields count commands recorded into render bundles, which replay through
 * `bundlesExecuted` without being counted again. Write bytes are the copied
 * source bytes.
 */
export type RhiCommandCounts = { readonly [K in RhiCommandCountKey]: number };

/** Realm-wide accumulator; mutated only by the rhi-webgpu wrappers. */
export const COMMAND_COUNTS: { -readonly [K in RhiCommandCountKey]: number } = Object.fromEntries(
  RHI_COMMAND_COUNT_KEYS.map((key) => [key, 0]),
) as { -readonly [K in RhiCommandCountKey]: number };

/** Snapshot of every count since this realm loaded rhi-webgpu. */
export function readRhiCommandCounts(): RhiCommandCounts {
  return { ...COMMAND_COUNTS };
}

/** Counts encoded between two snapshots (`after` minus `before`). */
export function subtractRhiCommandCounts(
  after: RhiCommandCounts,
  before: RhiCommandCounts,
): RhiCommandCounts {
  const out = {} as { -readonly [K in RhiCommandCountKey]: number };
  for (const key of RHI_COMMAND_COUNT_KEYS) out[key] = after[key] - before[key];
  return out;
}
