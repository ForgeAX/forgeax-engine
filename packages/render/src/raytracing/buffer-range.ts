import type { RhiLimits } from '@forgeax/engine-rhi';

/** Callers own exact kernel sizes and alias policy; these checks own device limits. */
export function isBufferOffsetAligned(
  limits: RhiLimits,
  offset: number,
  uniform: boolean,
): boolean {
  const alignment = uniform
    ? limits.minUniformBufferOffsetAlignment
    : limits.minStorageBufferOffsetAlignment;
  return Number.isSafeInteger(offset) && offset >= 0 && offset % alignment === 0;
}

export function isBufferRangeWithinLimits(
  limits: RhiLimits,
  range: { readonly offset?: number; readonly size?: number },
  uniform: boolean,
): boolean {
  const offset = range.offset ?? 0;
  if (range.size === undefined) return offset < limits.maxBufferSize;
  const limit = uniform ? limits.maxUniformBufferBindingSize : limits.maxStorageBufferBindingSize;
  return (
    Number.isSafeInteger(offset + range.size) &&
    offset + range.size <= limits.maxBufferSize &&
    range.size <= limit
  );
}
