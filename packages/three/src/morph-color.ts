import { ok, type Result } from '@forgeax/engine-types';
import type { BufferGeometry } from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

/** r187 color morphs use existing vertex-color bytes; prepare only on a source/weight revision. */
export function applyMorphColor(
  geometry: BufferGeometry,
  colors: Float32Array | undefined,
  weights: readonly number[],
): Result<void, Error> {
  const targets = geometry.morphAttributes.color;
  const count = geometry.getAttribute('position')?.count ?? 0;
  const width = targets?.[0]?.itemSize;
  if (colors === undefined)
    return unsupported('Color morph requires a base color attribute', geometry.uuid);
  if (
    targets === undefined ||
    targets.length !== weights.length ||
    (width !== 3 && width !== 4) ||
    targets.some((target) => target.count !== count || target.itemSize !== width) ||
    !weights.every(Number.isFinite)
  )
    return invalid('Color morph target extent/weights', geometry.uuid);
  const base = geometry.morphTargetsRelative
    ? 1
    : 1 - weights.reduce((sum, value) => sum + value, 0);
  for (let vertex = 0; vertex < count; vertex++) {
    for (let lane = 0; lane < width; lane++) {
      const offset = vertex * 4 + lane;
      let value = (colors[offset] ?? 1) * base;
      let index = 0;
      for (const target of targets)
        value += target.getComponent(vertex, lane) * (weights[index++] ?? 0);
      if (!Number.isFinite(Math.fround(value))) return invalid('Color morph value', geometry.uuid);
      colors[offset] = value;
    }
  }
  return ok(undefined);
}
