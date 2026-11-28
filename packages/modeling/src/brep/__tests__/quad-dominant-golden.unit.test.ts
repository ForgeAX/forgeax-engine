import { beforeAll, describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { housing } from '../housing';
import { type QuadOptions, quadrangulate } from '../quad';
import type { Shape } from '../types';

/**
 * Quad-dominant output on the five quad-feature-baseline shapes is pinned to the #580 baseline
 * (345c45dc). A later change that admits pairs by a scaled-Jacobian floor in dominant mode leaves
 * flange bolts with triangles and changes their quad counts; these goldens fail on that change.
 */
interface Golden {
  readonly quads: number;
  readonly triangles: number;
  readonly minSj: number;
}

const GOLDEN: Record<string, Golden> = {
  'plate-grid3x4': { quads: 357, triangles: 56, minSj: 0.33670528075560285 },
  'box-minus-cyl': { quads: 183, triangles: 18, minSj: 0.4339261051481127 },
  'flange-bolt6': { quads: 268, triangles: 0, minSj: 0.12053668025532027 },
  'flange-bolt12': { quads: 348, triangles: 0, minSj: 0.12053668025532148 },
  housing: { quads: 201, triangles: 18, minSj: 0.5395042867796358 },
};

const OPTIONS: QuadOptions = { size: 5, trimmed: 'quad-dominant', source: 'boolean' };

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`fixture failed: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value;
}

interface Row {
  readonly quads: number;
  readonly triangles: number;
  readonly minSj: number;
  readonly openEdges: number;
  readonly nonManifoldEdges: number;
}

// Fixtures and quadrangulation run once per file: each boolean or pattern build is expensive.
const rows = new Map<string, Row>();

beforeAll(() => {
  const cyl = must(cylinder({ radius: 0.3, height: 3, label: 'cyl' }));
  const boxS = must(box({ size: [2.6, 1, 1], label: 'box' }));
  const pattern = (k: string): Shape => (PATTERN_CASES[k] as () => { shape: Shape })().shape;
  const shapes: [string, Shape][] = [
    ['plate-grid3x4', pattern('grid3x4')],
    ['box-minus-cyl', must(booleanSolids(boxS, cyl, 'difference'))],
    ['flange-bolt6', pattern('bolt6')],
    ['flange-bolt12', pattern('bolt12')],
    [
      'housing',
      must(
        housing({
          size: [2.6, 1, 1],
          bossX: 0.8,
          bossRadius: 0.3,
          bossHeight: 1.6,
          boreRadius: 0.15,
        }),
      ),
    ],
  ];
  for (const [id, shape] of shapes) {
    const size = id.startsWith('plate') || id.startsWith('flange') ? 5 : 0.25;
    const r = must(quadrangulate(shape, { ...OPTIONS, size }));
    rows.set(id, {
      quads: r.report.quads,
      triangles: r.report.triangles,
      minSj: r.report.scaledJacobian.min,
      openEdges: r.report.openEdges,
      nonManifoldEdges: r.report.nonManifoldEdges,
    });
  }
}, 600_000);

describe('quad-dominant baseline goldens', () => {
  for (const id of Object.keys(GOLDEN)) {
    it(`${id}: quad and triangle counts match the #580 baseline`, () => {
      const row = rows.get(id) as Row;
      const want = GOLDEN[id] as Golden;
      expect(row.triangles).toBe(want.triangles);
      expect(row.quads).toBe(want.quads);
      expect(row.openEdges).toBe(0);
      expect(row.nonManifoldEdges).toBe(0);
      expect(row.minSj).toBeCloseTo(want.minSj, 9);
    });
  }

  it('flange bolts stay all-quad in quad-dominant mode (0 triangles)', () => {
    expect(rows.get('flange-bolt6')?.triangles).toBe(0);
    expect(rows.get('flange-bolt12')?.triangles).toBe(0);
  });
});
