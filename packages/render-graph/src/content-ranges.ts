import type { GraphAccessUsage, GraphTextureContentRange } from './types.js';

export interface InheritedTextureRead {
  readonly range: GraphTextureContentRange;
  readonly passName: string;
  readonly usage: GraphAccessUsage;
}

/** An inherited read needs bytes held by this exact physical allocation. */
export function firstMissingTextureRead(
  reads: readonly InheritedTextureRead[],
  committed: readonly GraphTextureContentRange[] | undefined,
): InheritedTextureRead | undefined {
  if (committed === undefined) return reads[0];
  for (const read of reads) if (!textureRangeCovered(read.range, committed)) return read;
  return undefined;
}

export function containsTextureRange(
  outer: GraphTextureContentRange,
  inner: GraphTextureContentRange,
): boolean {
  return (
    (outer.aspect === 'all' || outer.aspect === inner.aspect) &&
    outer.mipStart <= inner.mipStart &&
    outer.mipEnd >= inner.mipEnd &&
    outer.layerStart <= inner.layerStart &&
    outer.layerEnd >= inner.layerEnd
  );
}

export function overlapsTextureRange(
  a: GraphTextureContentRange,
  b: GraphTextureContentRange,
): boolean {
  return (
    (a.aspect === 'all' || b.aspect === 'all' || a.aspect === b.aspect) &&
    a.mipStart < b.mipEnd &&
    b.mipStart < a.mipEnd &&
    a.layerStart < b.layerEnd &&
    b.layerStart < a.layerEnd
  );
}

/** The exact aspect, mip and layer cells shared by two ranges. */
export function intersectTextureRange(
  a: GraphTextureContentRange,
  b: GraphTextureContentRange,
): GraphTextureContentRange | undefined {
  if (containsTextureRange(a, b)) return b;
  if (containsTextureRange(b, a)) return a;
  if (!overlapsTextureRange(a, b)) return undefined;
  return {
    mipStart: Math.max(a.mipStart, b.mipStart),
    mipEnd: Math.min(a.mipEnd, b.mipEnd),
    layerStart: Math.max(a.layerStart, b.layerStart),
    layerEnd: Math.min(a.layerEnd, b.layerEnd),
    aspect: a.aspect === 'all' ? b.aspect : a.aspect,
  };
}

/**
 * applyTextureContentWrite keeps valid rectangles disjoint within each aspect.
 * Summing their intersections therefore counts each initialized mip/layer cell once.
 */
export function textureRangeCovered(
  requested: GraphTextureContentRange,
  committed: readonly GraphTextureContentRange[],
): boolean {
  const cells =
    (requested.mipEnd - requested.mipStart) * (requested.layerEnd - requested.layerStart);
  let depth = 0;
  let stencil = 0;
  for (const range of committed) {
    if (containsTextureRange(range, requested)) return true;
    if (!overlapsTextureRange(range, requested)) continue;
    const mips =
      Math.min(requested.mipEnd, range.mipEnd) - Math.max(requested.mipStart, range.mipStart);
    const layers =
      Math.min(requested.layerEnd, range.layerEnd) -
      Math.max(requested.layerStart, range.layerStart);
    const covered = mips * layers;
    if (range.aspect !== 'stencil-only') depth += covered;
    if (range.aspect !== 'depth-only') stencil += covered;
  }
  return (
    (requested.aspect === 'stencil-only' || depth === cells) &&
    (requested.aspect === 'depth-only' || stencil === cells)
  );
}

function appendUncoveredRanges(
  result: GraphTextureContentRange[],
  source: GraphTextureContentRange,
  removed: GraphTextureContentRange,
): void {
  const mipStart = Math.max(source.mipStart, removed.mipStart);
  const mipEnd = Math.min(source.mipEnd, removed.mipEnd);
  const layerStart = Math.max(source.layerStart, removed.layerStart);
  const layerEnd = Math.min(source.layerEnd, removed.layerEnd);
  const add = (m0: number, m1: number, l0: number, l1: number, aspect = source.aspect): void => {
    if (m0 < m1 && l0 < l1)
      result.push({ ...source, mipStart: m0, mipEnd: m1, layerStart: l0, layerEnd: l1, aspect });
  };
  add(source.mipStart, mipStart, source.layerStart, source.layerEnd);
  add(mipEnd, source.mipEnd, source.layerStart, source.layerEnd);
  add(mipStart, mipEnd, source.layerStart, layerStart);
  add(mipStart, mipEnd, layerEnd, source.layerEnd);
  if (source.aspect === 'all' && removed.aspect !== 'all')
    add(
      mipStart,
      mipEnd,
      layerStart,
      layerEnd,
      removed.aspect === 'depth-only' ? 'stencil-only' : 'depth-only',
    );
}

/** Advance physical subresource validity in order, retaining unaffected or partially covered writes. */
export function applyTextureContentWrite(
  committed: GraphTextureContentRange[],
  range: GraphTextureContentRange,
  stored: boolean,
): void {
  // A complete overwrite replaces all covered subresources directly.
  let kept = 0;
  const initial = committed.length;
  for (let i = 0; i < initial; i++) {
    const prior = committed[i] as GraphTextureContentRange;
    // Stored content only adds validity. A containing entry is disjoint from
    // every earlier entry on these aspects, so none has been removed or split.
    if (stored && containsTextureRange(prior, range)) return;
    if (containsTextureRange(range, prior)) continue;
    if (!overlapsTextureRange(range, prior)) {
      committed[kept++] = prior;
      continue;
    }
    appendUncoveredRanges(committed, prior, range);
  }
  for (let i = initial; i < committed.length; i++)
    committed[kept++] = committed[i] as GraphTextureContentRange;
  committed.length = kept;
  if (!stored) return;

  // Neighboring face, layer and mip writes can describe a single rectangle.
  // Fold only the adjacent tail; each successful fold consumes one entry.
  let { mipStart, mipEnd, layerStart, layerEnd, aspect } = range;
  while (kept > 0) {
    const last = committed[kept - 1] as GraphTextureContentRange;
    const sameMips = last.mipStart === mipStart && last.mipEnd === mipEnd;
    const sameLayers = last.layerStart === layerStart && last.layerEnd === layerEnd;
    if (sameMips && sameLayers && last.aspect !== aspect) {
      aspect = 'all';
    } else if (
      last.aspect === aspect &&
      sameMips &&
      (last.layerEnd === layerStart || layerEnd === last.layerStart)
    ) {
      layerStart = Math.min(layerStart, last.layerStart);
      layerEnd = Math.max(layerEnd, last.layerEnd);
    } else if (
      last.aspect === aspect &&
      sameLayers &&
      (last.mipEnd === mipStart || mipEnd === last.mipStart)
    ) {
      mipStart = Math.min(mipStart, last.mipStart);
      mipEnd = Math.max(mipEnd, last.mipEnd);
    } else {
      break;
    }
    kept--;
  }
  if (committed.length === kept) {
    committed.push(range);
  } else {
    committed.length = kept;
    committed.push({ mipStart, mipEnd, layerStart, layerEnd, aspect });
  }
}
