const GiB = 1024 ** 3;

/** Keep host headroom and reserve two GiB per admitted Pack; never exceed four lanes. */
export function packBuildConcurrency(
  memory: {
    readonly parallelism: number;
    readonly freeBytes: number;
    readonly heapHeadroomBytes: number;
  },
  requested?: string,
): number {
  const available = Math.min(memory.freeBytes, memory.heapHeadroomBytes);
  const admitted = Math.max(
    1,
    Math.min(4, memory.parallelism, Math.floor((available - 2 * GiB) / (2 * GiB))),
  );
  if (requested === undefined) return admitted;
  const count = Number(requested);
  if (!Number.isSafeInteger(count) || count < 1 || count > 4)
    throw new RangeError('FORGEAX_BUILD_CONCURRENCY must be an integer between 1 and 4');
  return Math.min(count, admitted);
}
