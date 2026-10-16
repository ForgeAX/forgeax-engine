const GiB = 1024 ** 3;

/** Keep host headroom and reserve two GiB per admitted Pack; never exceed two lanes. */
export function packBuildConcurrency(
  memory: {
    readonly parallelism: number;
    readonly freeBytes: number;
    readonly heapHeadroomBytes: number;
    readonly concurrentCookers: boolean;
  },
  requested?: string,
): number {
  const available = Math.min(memory.freeBytes, memory.heapHeadroomBytes);
  const admitted = memory.concurrentCookers
    ? Math.max(1, Math.min(2, memory.parallelism, Math.floor((available - 2 * GiB) / (2 * GiB))))
    : 1;
  if (requested === undefined) return admitted;
  const count = Number(requested);
  if (!Number.isSafeInteger(count) || count < 1 || count > 2)
    throw new RangeError('FORGEAX_BUILD_CONCURRENCY must be 1 or 2');
  return Math.min(count, admitted);
}
