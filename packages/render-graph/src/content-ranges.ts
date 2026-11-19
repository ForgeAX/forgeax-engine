import type { GraphTextureContentRange } from './types.js';

export function textureRangeCovered(
  requested: GraphTextureContentRange,
  writes: readonly GraphTextureContentRange[],
): boolean {
  if (requested.aspect === 'all')
    return (
      textureRangeCovered({ ...requested, aspect: 'depth-only' }, writes) &&
      textureRangeCovered({ ...requested, aspect: 'stencil-only' }, writes)
    );
  const candidates = writes.filter(
    (write) => write.aspect === 'all' || write.aspect === requested.aspect,
  );
  if (candidates.length === 0) return false;
  const mipCuts = new Set([requested.mipStart, requested.mipEnd]);
  const layerCuts = new Set([requested.layerStart, requested.layerEnd]);
  for (const write of candidates) {
    if (write.mipStart < requested.mipEnd && requested.mipStart < write.mipEnd) {
      mipCuts.add(Math.max(requested.mipStart, write.mipStart));
      mipCuts.add(Math.min(requested.mipEnd, write.mipEnd));
    }
    if (write.layerStart < requested.layerEnd && requested.layerStart < write.layerEnd) {
      layerCuts.add(Math.max(requested.layerStart, write.layerStart));
      layerCuts.add(Math.min(requested.layerEnd, write.layerEnd));
    }
  }
  const mips = [...mipCuts].sort((left, right) => left - right);
  const layers = [...layerCuts].sort((left, right) => left - right);
  for (let mip = 0; mip + 1 < mips.length; mip++)
    for (let layer = 0; layer + 1 < layers.length; layer++) {
      const mipStart = mips[mip];
      const mipEnd = mips[mip + 1];
      const layerStart = layers[layer];
      const layerEnd = layers[layer + 1];
      if (
        mipStart === undefined ||
        mipEnd === undefined ||
        layerStart === undefined ||
        layerEnd === undefined
      )
        throw new Error('Texture range partition invariant failed');
      if (
        !candidates.some(
          (write) =>
            write.mipStart <= mipStart &&
            mipEnd <= write.mipEnd &&
            write.layerStart <= layerStart &&
            layerEnd <= write.layerEnd,
        )
      )
        return false;
    }
  return true;
}

export function subtractTextureRange(
  source: GraphTextureContentRange,
  removed: GraphTextureContentRange,
): GraphTextureContentRange[] {
  if (
    (removed.aspect !== 'all' && source.aspect !== 'all' && removed.aspect !== source.aspect) ||
    source.mipEnd <= removed.mipStart ||
    removed.mipEnd <= source.mipStart ||
    source.layerEnd <= removed.layerStart ||
    removed.layerEnd <= source.layerStart
  )
    return [source];
  const mipStart = Math.max(source.mipStart, removed.mipStart);
  const mipEnd = Math.min(source.mipEnd, removed.mipEnd);
  const layerStart = Math.max(source.layerStart, removed.layerStart);
  const layerEnd = Math.min(source.layerEnd, removed.layerEnd);
  const result: GraphTextureContentRange[] = [];
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
  return result;
}
