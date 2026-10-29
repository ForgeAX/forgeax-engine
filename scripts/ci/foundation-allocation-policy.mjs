export const MATH_BYTES_PER_CALL_LIMIT = 8;
export const ECS_FIXED_GROWTH_MARGIN = 512;
export const ECS_BYTES_PER_ADDED_ROW_LIMIT = 0.25;

export function mathAllocationFailure(result) {
  if (!Number.isFinite(result.bytesPerCall) || result.bytesPerCall < 0)
    return 'Math allocation requires a finite nonnegative sample';
  return result.bytesPerCall > MATH_BYTES_PER_CALL_LIMIT
    ? `Math allocated ${result.bytesPerCall.toFixed(2)} sampled bytes/call; budget ${MATH_BYTES_PER_CALL_LIMIT}`
    : undefined;
}

export function ecsAllocationFailure(small, large) {
  if (
    ![small.allocation.bytesPerCall, large.allocation.bytesPerCall].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    return 'ECS allocation requires finite nonnegative samples';
  if (small.batchCount !== large.batchCount || small.kind !== large.kind)
    return 'ECS scaling comparison requires the same batch count and selection kind';
  const addedRows = large.selectedRows - small.selectedRows;
  if (addedRows <= 0) return 'ECS scaling comparison requires a larger selected population';
  const budget = ECS_FIXED_GROWTH_MARGIN + addedRows * ECS_BYTES_PER_ADDED_ROW_LIMIT;
  const growth = large.allocation.bytesPerCall - small.allocation.bytesPerCall;
  return growth > budget
    ? `ECS sampled allocation grew ${growth.toFixed(2)} bytes/traversal for ${addedRows} added rows; budget ${budget}`
    : undefined;
}
