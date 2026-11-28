export const DEFAULT_DYNAMIC_GEOMETRY_MESH_BUDGET_BYTES = 64 * 1024 * 1024;

/** Shared admission check for lifecycle and renderer construction, before backend allocation. */
export function validateDynamicGeometryMeshBudget(maxMeshBytes: number): void {
  const maxMeshByteLimit = 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMeshBytes) || maxMeshBytes < 1 || maxMeshBytes > maxMeshByteLimit) {
    throw new RangeError(
      `maxMeshBytes must be a positive safe integer no greater than ${maxMeshByteLimit}`,
    );
  }
}
