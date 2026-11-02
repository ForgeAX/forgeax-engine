import { type BakeOptions, bakeMaps, bakeSurface, decodeSnapshot } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import {
  analyticHit,
  decodeTexelNormal,
  type GoldenCase,
  type GoldenShape,
  goldenCase,
  goldenReport,
  goldenTexels,
} from '../tools/golden';

/**
 * Golden bake harness (U40, R7 3.6 / BK9): bakes of analytic shapes measured in object
 * space against their exact normals and occlusion. Gates are R7's (normal p95 3, p99 8
 * degrees; AO MAE 0.05, tightened to 0.003 for the torus); each has a falsifier.
 */

const R = 128;
const DISTANCE = 0.05;
const AO = { rays: 64, bias: 15, distance: 0.6 };

function bake(g: GoldenCase, extra: Partial<BakeOptions> = {}) {
  const r = bakeMaps({
    base: g.base,
    detail: g.detail,
    maps: ['normal', 'ao'],
    resolution: R,
    normals: g.normals,
    ao: AO,
    budget: 1e12,
    ...extra,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

const report = (g: GoldenCase, extra: Partial<BakeOptions> = {}, aoDistance = AO.distance) =>
  goldenReport(g, bake(g, extra), {
    resolution: R,
    distance: DISTANCE,
    ao: { bias: AO.bias, distance: aoDistance },
  });

describe('golden bakes against analytic truth', () => {
  it.each([
    'sphere',
    'torus',
    'bevelledBox',
  ] as GoldenShape[])('%s passes the R7 normal and AO gates', (shape) => {
    const r = report(goldenCase(shape, R));
    expect(r.issues).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.texels).toBeGreaterThan(4000);
    // Measured at 128 px with the default B-spline filter: sphere and torus p95 under 0.7
    // degrees, the bevelled box 2.7 (its 12-segment bevel facets).
    expect(r.normal?.p95).toBeLessThan(shape === 'bevelledBox' ? 3 : 1);
  }, 60_000);

  it('a hard-rimmed cylinder passes with shading-normal rays', () => {
    const r = report(goldenCase('cylinder', R), { direction: 'shading' });
    expect(r.pass).toBe(true);
    expect(r.normal?.max).toBeLessThan(1);
  }, 60_000);

  // Was an S1 finding (averaged rays baked the cap into the first side row); S1b fixed it.
  it('a hard-rimmed cylinder passes with the default averaged rays', () => {
    const r = report(goldenCase('cylinder', R));
    expect(r.pass).toBe(true);
    expect(r.normal?.max).toBeLessThan(1);
  }, 60_000);

  it('torus AO converges to the analytic linear-attenuated open fraction (MAE <= 0.003); falsifier: half the AO distance misses it', () => {
    const g = goldenCase('torus', R);
    const right = report(g);
    expect(right.ao?.mae).toBeLessThan(0.003);
    const short = report(g, { ao: { ...AO, distance: AO.distance / 2 } });
    expect(short.ao?.mae).toBeGreaterThan(0.003);
  }, 60_000);

  it('falsifier: a faceted detail fails the normal gate with a golden-normal issue', () => {
    const g = goldenCase('sphere', R);
    const faceted = { ...g, detail: g.base };
    const r = report(faceted, { detailNormals: { mode: 'flat' } });
    expect(r.pass).toBe(false);
    expect(r.issues[0]).toMatchObject({
      code: 'bake',
      severity: 'warn',
      detail: { check: 'golden-normal' },
    });
  }, 60_000);

  it('falsifier: decoding with the opposite tangent handedness is far off the truth', () => {
    const g = goldenCase('torus', R);
    const baked = bake(g, { maps: ['normal'] });
    const mesh = decodeSnapshot(g.base.snapshot());
    if (!mesh.ok) throw mesh.error;
    const surface = bakeSurface(mesh.value, g.normals);
    if (!surface.ok) throw surface.error;
    const errors = goldenTexels(surface.value, R).map((f) => {
      const truth = g.surface.normal(analyticHit(g.surface, f.p, f.n, DISTANCE));
      const m = decodeTexelNormal(baked.textures.normal as never, R, { ...f, w: -f.w });
      return (
        (Math.acos(Math.min(1, m[0] * truth[0] + m[1] * truth[1] + m[2] * truth[2])) * 180) /
        Math.PI
      );
    });
    errors.sort((a, b) => a - b);
    // The correct decode has p95 under 1 degree; a mirrored bitangent tilts the normals the wrong way.
    expect(errors[Math.floor(0.95 * errors.length)]).toBeGreaterThan(3);
  }, 60_000);
});
