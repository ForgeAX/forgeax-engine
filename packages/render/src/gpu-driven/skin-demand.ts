import { RhiError } from '@forgeax/engine-rhi';

function u32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** Offsets are vec4 rows in the existing view output, never Scene row addresses. */
export interface SkinDemandLayout {
  readonly hashCapacity: number;
  /** Distinct Skin demand keys; every key owns at least one joint. */
  readonly rosterCapacity: number;
  /** One candidate reference per actual task candidate, independent of the roster. */
  readonly candidateCapacity: number;
  readonly jointCapacity: number;
  readonly descriptorBase: number;
  readonly rosterBase: number;
  readonly candidateBase: number;
  readonly paletteBase: number;
  readonly outputBytes: number;
  readonly counterWords: number;
}

function powerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}

/**
 * Constant-time capacity derivation; no Binding/candidate enumeration.
 * Only a Binding with joints claims a demand key, so the roster and hash scale
 * with min(candidates, joints); a large rigid task keeps only its per-candidate
 * reference column.
 */
export function skinDemandLayout(
  candidateCapacity: number,
  jointCapacity: number,
  visiblePrefixBytes = 0,
): SkinDemandLayout {
  for (const value of [candidateCapacity, jointCapacity, visiblePrefixBytes])
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'finite u32 Skin demand capacities',
        hint: 'derive capacity from the fixed input root and actual task extent',
      });
  const candidates = powerOfTwo(candidateCapacity);
  const rosterCapacity = powerOfTwo(Math.min(candidateCapacity, jointCapacity));
  const hashCapacity = rosterCapacity * 2;
  const descriptorBase = Math.ceil(visiblePrefixBytes / 16);
  const rosterBase = descriptorBase + hashCapacity;
  // The kernel derives the candidate column as rosterBase + rosterCapacity.
  const candidateBase = rosterBase + rosterCapacity;
  const paletteBase = Math.ceil((candidateBase + candidates) / 4) * 4;
  const outputBytes = (paletteBase + jointCapacity * 8) * 16;
  const counterWords = 4 + hashCapacity;
  if (outputBytes > 0xffffffff || counterWords * 4 > 0xffffffff)
    throw new RhiError({
      code: 'limit-exceeded',
      expected: 'Skin demand output and counter addresses fit u32 bytes',
      hint: 'reject oversized tasks before creating or publishing GPU buffers',
    });
  return {
    hashCapacity,
    rosterCapacity,
    candidateCapacity: candidates,
    jointCapacity,
    descriptorBase,
    rosterBase,
    candidateBase,
    paletteBase,
    outputBytes,
    counterWords,
  };
}

/** Write into the caller's current task constants without a temporary integer view. */
export function writeSkinDemandConstants(
  out: DataView,
  offset: number,
  layout: SkinDemandLayout,
  currentRoot: number,
  previousRoot: number,
  candidateCount: number,
  counterBase = 0,
  dispatchBase = 0,
  maxWorkgroups = 65535,
): void {
  if (
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < 0 ||
    candidateCount > layout.candidateCapacity
  )
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'Skin candidates fit the admitted task roster',
      hint: 'derive constants and buffers from the same fixed task',
    });
  if (
    !u32(currentRoot) ||
    !u32(previousRoot) ||
    !u32(counterBase) ||
    counterBase + layout.counterWords > 0xffffffff ||
    !u32(dispatchBase) ||
    dispatchBase + 3 > 0xffffffff ||
    !Number.isSafeInteger(maxWorkgroups) ||
    maxWorkgroups < 1 ||
    maxWorkgroups > 65535 ||
    layout.rosterCapacity > maxWorkgroups * maxWorkgroups
  )
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected:
        'u32 Skin task roots, offsets and a device-qualified two-dimensional dispatch extent',
      hint: 'keep the owning source root and physical task buffers retained',
    });
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % 4 !== 0 ||
    offset + 48 > out.byteLength
  )
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'one aligned 48-byte Skin demand constant window',
      hint: 'reserve constants with the existing view uniform owner',
    });
  out.setUint32(offset, currentRoot, true);
  out.setUint32(offset + 4, previousRoot, true);
  out.setUint32(offset + 8, candidateCount, true);
  out.setUint32(offset + 12, layout.hashCapacity, true);
  out.setUint32(offset + 16, counterBase, true);
  out.setUint32(offset + 20, layout.descriptorBase, true);
  out.setUint32(offset + 24, layout.rosterBase, true);
  out.setUint32(offset + 28, layout.paletteBase, true);
  out.setUint32(offset + 32, layout.jointCapacity, true);
  out.setUint32(offset + 36, layout.rosterCapacity, true);
  out.setUint32(offset + 40, dispatchBase, true);
  out.setUint32(offset + 44, maxWorkgroups, true);
}
