import { Materials } from '@forgeax/engine-render';
import { resolveMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { withPhysicalMaterialModule } from '../material-contract';
import factor from '../standard-clearcoat-factor-r.pack.json';
// @ts-expect-error Independent reference quadrature is shared JavaScript.
import { equirectRadiance, integrateEnvironment } from '../../evidence/environment-reference.mjs';

describe('physical material independent reference', () => {
  it('binds a package shader with its own ABI and preserves the Engine shadow owner', () => {
    const material = Materials.standard({ staticSwitches: { clearcoat: true }, baseColor: [0.62, 0.14, 0.04, 1], clearcoat: 1 });
    const result = withPhysicalMaterialModule(material, 'physical-material::standard-clearcoat-factor-r');
    expect(result.parameters).toEqual(factor.assets[0]!.payload.parameters);
    expect(result.passes?.find((pass) => pass.name === 'shadow-caster')).toBe(
      material.passes?.find((pass) => pass.name === 'shadow-caster'),
    );
    expect(resolveMaterialAsset('physical', { physical: result })).toMatchObject({ ok: true });
    expect(result.values).toMatchObject({ baseColor: material.values?.baseColor, clearcoat: 1 });
  });

  it('uses incident radiance linearly, not the square of one environment texel', () => {
    const material = { baseColor: [0.6, 0.2, 0.1], roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.18 };
    const evaluate = (scale: number, count = 2048): number[] => integrateEnvironment(
      [0, 0, 1], [0, 0, 1], material, () => [scale, 2 * scale, 3 * scale], count,
    );
    const a = evaluate(1), b = evaluate(2), refined = evaluate(1, 8192);
    a.forEach((value, channel) => {
      expect(b[channel]).toBeCloseTo(value * 2, 10);
      expect(refined[channel]).toBeCloseTo(value, 3);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(channel + 1);
    });
  });

  it('wraps the equirect seam and clamps the poles without changing constant radiance', () => {
    const sample = equirectRadiance({ width: 2, height: 2, data: new Float32Array(Array(4).fill([1, 2, 3, 1]).flat()) });
    for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
      expect(sample(direction)).toEqual([1, 2, 3]);
    }
  });
});
