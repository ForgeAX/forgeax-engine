import { assert } from 'vitest';
import type { SurfaceCapture } from '../../raytracing/surface-cards';
import {
  customCardSource,
  type NumericCardCase,
  numericExpected,
} from './custom-surface-cards.fixture';

export const cardParameterValues = [
  { roughness: 0.25, emissiveIntensity: 0 },
  { roughness: 0.75, emissiveIntensity: 1 },
  { roughness: 0.5, emissiveIntensity: 2 },
] as const;

export function cardParameterSource() {
  const roughness = '0.45 + 0.1 * input.uv1.x';
  const emission = 'emission, 1.0, 1.0';
  assert(customCardSource.split(roughness).length === 2);
  assert(customCardSource.split(emission).length === 2);
  return customCardSource
    .replace(
      'fn evaluate_surface',
      '#import forgeax_material::parameters::{material}\nfn evaluate_surface',
    )
    .replace(roughness, 'material.roughness')
    .replace(emission, 'emission * material.emissiveIntensity, 1.0, 1.0');
}

/** Author-declared scalar updates over the independent geometric property oracle. */
export function cardParameterExpected(value: (typeof cardParameterValues)[number]) {
  return (context: NumericCardCase, x: number, y: number) => {
    const original = numericExpected(context, x, y);
    return {
      ...original,
      albedo: [...original.albedo.slice(0, 3), value.roughness],
      emission: original.emission.map((component, channel) =>
        channel < 3 ? component * value.emissiveIntensity : component,
      ),
    };
  };
}

export function cardTilePlanes(
  planes: readonly Uint8Array[],
  capture: SurfaceCapture,
  tile: number,
) {
  const columns = capture.width / 32;
  const ox = (tile % columns) * 32,
    oy = Math.floor(tile / columns) * 32;
  return planes.map((plane) => {
    const cropped = new Uint8Array(32 * 32 * 8);
    for (let y = 0; y < 32; y++) {
      const first = ((oy + y) * capture.width + ox) * 8;
      cropped.set(plane.subarray(first, first + 32 * 8), y * 32 * 8);
    }
    return cropped;
  });
}
