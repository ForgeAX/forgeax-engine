import { describe, expect, it } from 'vitest';
import { blendSurfaces } from '../blend';
import type { Tuple3 } from '../geom';
import type { HighlightOptions } from '../highlight-lines';
import { type NurbsSurface, nurbs } from '../nurbs';
import {
  checkSurfaceQuality,
  type FeatureLine,
  isoparm,
  type NamedSurface,
} from '../surface-quality';
import { halves, panel, split } from './fixtures/crowned-panel';

// Audit B16 A1/A7: highlight lines across patch joints, dicing and run-outs.

/** `s` cut into k x k patches of equal parameter range. */
function dice(s: NurbsSurface, k: number): NamedSurface[] {
  const cut = (pieces: NurbsSurface[], along: 'u' | 'v') =>
    pieces.flatMap((piece) => {
      const out: NurbsSurface[] = [];
      let rest = piece;
      for (let c = 1; c < k; c++) {
        const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(rest);
        const at = along === 'u' ? u0 + (u1 - u0) / (k - c + 1) : v0 + (v1 - v0) / (k - c + 1);
        const [a, b] = split(rest, along, at);
        out.push(a);
        rest = b;
      }
      return [...out, rest];
    });
  return cut(cut([s], 'u'), 'v').map((surface, i) => ({ name: `d${i}`, surface }));
}

const eye: Tuple3 = [0.3, -0.9, 1.1];
const views: Readonly<Record<string, HighlightOptions>> = {
  horizontal: { field: 'reflection', eye, right: [1, 0, 0], up: [0, 0.77, 0.63], width: 3 },
  vertical: {
    field: 'reflection',
    eye,
    right: [1, 0, 0],
    up: [0, 0.77, 0.63],
    width: 3,
    orientation: 90,
  },
  isophote: { field: 'isophote', direction: [0.3, -0.5, 0.8], step: 3 },
};

function highlights(
  surfaces: readonly NamedSurface[],
  view: HighlightOptions,
  curves: readonly FeatureLine[] = [],
  options: { readonly continuity?: 'G1' | 'G2'; readonly samples?: number } = {},
) {
  const report = checkSurfaceQuality(
    { surfaces, curves },
    { highlights: view, isoparms: 0, ...options },
  );
  if (!report.ok) throw report.error;
  return report.value.issues.filter((i) => i.code === 'highlight');
}

const joint = (continuity: FeatureLine['continuity']): FeatureLine => ({
  name: 'joint',
  curve: isoparm(panel(0), 'v', 0.5),
  ...(continuity === undefined ? {} : { continuity }),
});

describe('highlight lines across patch joints', () => {
  it('a 0.25 to 2 degree kink at a joint declared G2 flags in every view', {
    timeout: 120_000,
  }, () => {
    for (const theta of [0.25, 0.5, 1, 2])
      for (const [name, view] of Object.entries(views)) {
        const found = highlights(halves(theta), view, [joint('G2')]);
        expect(found.length, `${theta} degrees, ${name}`).toBeGreaterThan(0);
      }
  });

  it('an undeclared joint flags too; a stripe offset is located at the joint', {
    timeout: 60_000,
  }, () => {
    for (const view of Object.values(views))
      expect(highlights(halves(0.25), view).length).toBeGreaterThan(0);
    const jumps = highlights(halves(0.25), views.vertical as HighlightOptions).filter(
      (i) => i.detail.jump !== undefined,
    );
    expect(jumps.length).toBe(1);
    expect(jumps[0]?.detail.patches).toEqual(['l', 'r']);
    expect(jumps[0]?.detail.jump as number).toBeGreaterThan(0.5);
    expect(((jumps[0]?.detail.point as Tuple3)[0] - 0.3) / 0.3).toBeCloseTo(0, 6);
  });

  it('a kink inside one patch (a full-multiplicity knot) flags like a joint', {
    timeout: 60_000,
  }, () => {
    for (const view of Object.values(views))
      expect(highlights([{ name: 'p', surface: panel(0.25) }], view).length).toBeGreaterThan(0);
  });

  it('a joint declared G1 or G0 is a designed break: no finding', { timeout: 60_000 }, () => {
    for (const continuity of ['G1', 'G0'] as const)
      for (const view of Object.values(views))
        expect(highlights(halves(2), view, [joint(continuity)])).toEqual([]);
  });
});

describe('highlight false findings', () => {
  it('dicing a smooth panel into G2-matched pieces does not change the findings', {
    timeout: 300_000,
  }, () => {
    const smooth = panel(0);
    for (const view of Object.values(views)) {
      const whole = highlights([{ name: 'p', surface: smooth }], view).length;
      expect(highlights(dice(smooth, 4), view).length).toBe(whole);
      expect(highlights(dice(smooth, 8), view).length).toBe(whole);
    }
  });

  it('a clean run-out has no highlight finding', { timeout: 120_000 }, () => {
    const quad = (a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface => ({
      degreeU: 1,
      degreeV: 1,
      points: [
        [a, b],
        [c, d],
      ],
      knotsU: [0, 0, 1, 1],
      knotsV: [0, 0, 1, 1],
    });
    const floor = quad([0, 0, 0], [0, -0.2, 0], [1, 0, 0], [1, -0.2, 0]);
    const wall = quad([0, 0, 0.2], [0, 0, 0], [1, 0, 0.2], [1, 0, 0]);
    const view: HighlightOptions = { field: 'isophote', direction: [0, -0.6, 0.8], step: 5 };
    for (const hold of [0.4, 0.7])
      for (const continuity of ['G1', 'G2'] as const) {
        const blend = blendSurfaces(floor, wall, {
          radius: [
            [0, 0.01],
            [hold, 0.01],
            [1, 0],
          ],
          continuity,
        });
        if (!blend.ok) throw blend.error;
        const surfaces: NamedSurface[] = [
          { name: 'a', surface: floor, trims: [blend.value.trimA] },
          { name: 'roll', surface: blend.value.blend, transition: { kind: 'blend', continuity } },
          { name: 'b', surface: wall, trims: [blend.value.trimB] },
        ];
        expect(
          highlights(surfaces, view, [], { continuity, samples: 64 }),
          `${hold} ${continuity}`,
        ).toEqual([]);
      }
  });
});
