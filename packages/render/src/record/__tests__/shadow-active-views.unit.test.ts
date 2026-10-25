import { describe, expect, it } from 'vitest';
import { directionalShadowPreparationLimit } from '../frame';
import type { RenderFrameState } from '../frame-snapshot';
import { resolveShadowMapSize } from '../frame-targets';

type Installed = RenderFrameState['compiledFrameGraph'];
const installed = (count?: number): Installed =>
  ({ ...(count === undefined ? {} : { directionalShadowViewCount: count }) }) as Installed;

describe('directional shadow graph demand', () => {
  it('uses the union of the current request and both installed graph owners', () => {
    expect(directionalShadowPreparationLimit(3, installed(3), undefined)).toBe(3);
    expect(directionalShadowPreparationLimit(1, installed(4), undefined)).toBe(4);
    expect(directionalShadowPreparationLimit(4, installed(1), undefined)).toBe(4);
    expect(directionalShadowPreparationLimit(1, installed(1), installed(4))).toBe(4);
    expect(directionalShadowPreparationLimit(2, installed(1), installed(3))).toBe(3);
  });

  it('retains the full original capacity for unknown, legacy, pending, or absent owners', () => {
    expect(directionalShadowPreparationLimit(undefined, installed(3), undefined)).toBeUndefined();
    expect(directionalShadowPreparationLimit(3, null, undefined)).toBeUndefined();
    expect(directionalShadowPreparationLimit(3, installed(), undefined)).toBeUndefined();
    expect(directionalShadowPreparationLimit(3, installed(3), installed())).toBeUndefined();
    expect(directionalShadowPreparationLimit(3, installed(3), null)).toBeUndefined();
  });

  it('rejects invalid counts instead of accidentally dropping a requested cascade', () => {
    for (const invalid of [0, -1, 5, 2.5, NaN, Infinity]) {
      expect(directionalShadowPreparationLimit(invalid, installed(3), undefined)).toBeUndefined();
      expect(directionalShadowPreparationLimit(3, installed(invalid), undefined)).toBeUndefined();
      expect(
        directionalShadowPreparationLimit(3, installed(3), installed(invalid)),
      ).toBeUndefined();
    }
  });

  it('releases old graph demand only when that graph has actually retired', () => {
    const old = installed(4);
    expect(directionalShadowPreparationLimit(1, installed(1), old)).toBe(4);
    expect(directionalShadowPreparationLimit(1, installed(1), undefined)).toBe(1);
    // Recovery drops the installed owner and cannot reuse the old proof.
    expect(directionalShadowPreparationLimit(1, null, undefined)).toBeUndefined();
  });

  it('keeps raw mutable light map-size observations on their original path', () => {
    const trace: string[] = [];
    let count = 1;
    const lights = {
      get cascadeCount() {
        trace.push('count');
        return count;
      },
      get shadowMapSize() {
        trace.push('size');
        count = 4;
        return 64;
      },
    };
    const internals = { device: { limits: { maxTextureDimension2D: 2048 }, caps: {} } };
    expect(resolveShadowMapSize(internals as never, { cascades: lights } as never)).toBe(64);
    expect(trace).toEqual(['count', 'size']);
    expect(count).toBe(4);
    // Raw record callers do not supply the Renderer-private scalar proof.
    expect(directionalShadowPreparationLimit(undefined, installed(1), undefined)).toBeUndefined();
  });
});
