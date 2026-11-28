import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, sphere, torus } from '../../../src/brep/build.ts';
import { pipeElbow } from '../../../src/brep/elbow.ts';
import { filletBox } from '../../../src/brep/fillet-box.ts';
import { findDefects, type HealResult, heal } from '../../../src/brep/heal.ts';
import { measure } from '../../../src/brep/measure.ts';
import type { Shape } from '../../../src/brep/types.ts';
import { validate } from '../../../src/brep/validate.ts';
import {
  allCases,
  damagedBracket,
  damagedHousing,
  damagedStandoff,
  type HealCase,
  tooWide,
} from '../cases.ts';
import { must, shiftEdgeCurve, unsewEdge } from '../damage.ts';
import { buildHousing, buildPlate, buildStandoff } from '../parts.ts';
import { renderCase } from '../render.ts';

function volume(shape: Shape): number {
  return must(measure(shape)).volume;
}

/** What "healed" means for a repairable case: valid, no defects left, same volume and topology counts as the clean part. */
function healedProblems(c: HealCase, r: HealResult): string[] {
  const out: string[] = [];
  if (!validate(r.shape).ok) out.push('invalid');
  if (!r.report.valid) out.push('report.valid false');
  if (must(findDefects(r.shape)).length > 0) out.push('defects remain');
  if (r.report.unrepaired.length > 0) out.push('unrepaired listed');
  if (Math.abs(volume(r.shape) - volume(c.clean)) > 1e-6 * volume(c.clean))
    out.push('volume changed');
  if (r.shape.faces.length !== c.clean.faces.length) out.push('face count');
  if (r.shape.edges.length !== c.clean.edges.length) out.push('edge count');
  if (r.shape.vertices.length !== c.clean.vertices.length) out.push('vertex count');
  return out;
}

describe('heal: healthy parts', () => {
  const parts: [string, Shape][] = [
    ['box', must(box({ size: [4, 5, 6] }))],
    ['cylinder', must(cylinder({ radius: 3, height: 7 }))],
    ['sphere', must(sphere({ radius: 3 }))],
    ['torus', must(torus({ major: 5, minor: 1.5 }))],
    ['cone', must(cone({ radius: 3, height: 6 }))],
    ['filletBox', must(filletBox({ size: [10, 8, 6], radius: 1.5 }))],
    ['pipeElbow', must(pipeElbow({ bend: 12, outer: 3, inner: 2, leg: 8 }))],
    ['bracket', buildPlate()],
    ['housing', buildHousing()],
    ['standoff', buildStandoff()],
  ];
  it.each(parts)('%s: no defects, returned unchanged, no repairs', (_name, shape) => {
    expect(must(findDefects(shape))).toEqual([]);
    const r = must(heal(shape));
    expect(r.shape).toBe(shape);
    expect(r.report.repairs).toEqual([]);
    expect(r.report.unrepaired).toEqual([]);
    expect(r.report.valid).toBe(true);
  });
});

describe('heal: damaged parts', () => {
  const repairable: [string, () => HealCase][] = [
    ['bracket', damagedBracket],
    ['housing', damagedHousing],
    ['standoff', damagedStandoff],
  ];

  it.each(repairable)('%s: damage is real, heal repairs all of it', (_n, make) => {
    const c = make();
    expect(validate(c.damaged).ok || must(findDefects(c.damaged)).length > 0).toBe(true);
    expect(must(findDefects(c.damaged)).length).toBeGreaterThanOrEqual(c.damage.length);
    const r = must(heal(c.damaged));
    expect(healedProblems(c, r)).toEqual([]);
    expect(r.report.repairs.length).toBeGreaterThan(0);
  });

  it('every defect kind is detected and repaired somewhere in the corpus', () => {
    const seen = new Set<string>();
    const fixed = new Set<string>();
    for (const [, make] of repairable) {
      const c = make();
      for (const d of must(findDefects(c.damaged))) seen.add(d.kind);
      for (const rep of must(heal(c.damaged)).report.repairs) fixed.add(rep.kind);
    }
    expect([...seen].sort()).toEqual([
      'duplicate-vertex',
      'edge-gap',
      'free-edge',
      'sliver-edge',
      'sliver-face',
      'vertex-gap',
    ]);
    expect([...fixed].sort()).toEqual([
      'fit-vertex',
      'merge-sliver-edge',
      'merge-sliver-face',
      'merge-vertices',
      'raise-edge-tolerance',
      'sew-edges',
    ]);
  });

  it('heal is idempotent', () => {
    for (const [, make] of repairable) {
      const once = must(heal(make().damaged));
      const twice = must(heal(once.shape));
      expect(twice.shape).toBe(once.shape);
      expect(twice.report.repairs).toEqual([]);
    }
  });

  it('a gap over maxTol is reported with a reason, not hidden, and the shape stays invalid', () => {
    const c = tooWide();
    const r = must(heal(c.damaged));
    expect(r.report.repairs).toEqual([]);
    expect(r.report.unrepaired.map((u) => u.defect.kind).sort()).toEqual([
      'edge-gap',
      'vertex-gap',
      'vertex-gap',
    ]);
    for (const u of r.report.unrepaired) expect(u.reason).toContain('maxTol');
    expect(r.report.valid).toBe(false);
    expect(r.report.issuesAfter.length).toBeGreaterThan(0);
  });

  it('provenance maps healed entities to input ids', () => {
    const c = damagedBracket();
    const r = must(heal(c.damaged));
    expect(r.provenance.faces).toHaveLength(r.shape.faces.length);
    expect(r.provenance.edges).toHaveLength(r.shape.edges.length);
    expect(r.provenance.vertices).toHaveLength(r.shape.vertices.length);
    const inputFaces = c.damaged.faces.length;
    // the sliver face and its neighbour are one healed face
    const merged = r.provenance.faces.filter((f) => f.length === 2);
    expect(merged).toHaveLength(1);
    for (const f of r.provenance.faces.flat()) expect(f).toBeLessThan(inputFaces);
    for (const rep of r.report.repairs) {
      for (const v of rep.vertices) expect(v).toBeLessThan(c.damaged.vertices.length);
      for (const e of rep.edges) expect(e).toBeLessThan(c.damaged.edges.length);
      for (const f of rep.faces) expect(f).toBeLessThan(inputFaces);
    }
  });

  it('a Shape that is not structurally sound is refused', () => {
    const c = damagedStandoff();
    const broken = { ...c.damaged, loops: [] } as unknown as Shape;
    expect(heal(broken).ok).toBe(false);
  });

  it('a non-positive tol is refused', () => {
    expect(heal(buildStandoff(), { tol: 0 }).ok).toBe(false);
    expect(heal(buildStandoff(), { tol: Number.NaN }).ok).toBe(false);
  });
});

describe('heal: the checks can fail', () => {
  const cases = allCases().filter((c) => c.unrepairable === 0);

  it('a heal that does nothing is caught by the same oracle', () => {
    for (const c of cases) {
      const noop: HealResult = {
        shape: c.damaged,
        provenance: { faces: [], edges: [], vertices: [] },
        report: {
          before: [],
          repairs: [],
          unrepaired: [],
          issuesBefore: [],
          issuesAfter: [],
          valid: true,
          notes: [],
        },
      };
      expect(healedProblems(c, noop).length).toBeGreaterThan(0);
    }
  });

  it('healing with a tolerance below the damage repairs less, and the oracle sees it', () => {
    const c = damagedHousing();
    const r = must(heal(c.damaged, { tol: 1e-6 }));
    expect(healedProblems(c, r).length).toBeGreaterThan(0);
  });

  it('an unsewn edge is invalid before heal and valid after: sewing, not tolerance, closes it', () => {
    const shape = buildHousing();
    const cut = unsewEdge(shape, 5);
    expect(validate(cut).ok).toBe(false);
    const r = must(heal(cut));
    expect(r.report.repairs.map((x) => x.kind)).toContain('sew-edges');
    expect(validate(r.shape).ok).toBe(true);
  });

  it('a moved edge curve is invalid before heal and valid after, volume unchanged', () => {
    const shape = buildHousing();
    const moved = shiftEdgeCurve(shape, 5, [0.002, 0, 0]);
    expect(validate(moved).ok).toBe(false);
    const r = must(heal(moved));
    expect(validate(r.shape).ok).toBe(true);
    expect(volume(r.shape)).toBeCloseTo(volume(shape), 6);
  });
});

describe('heal: render', () => {
  it('renders before/after sheets with the defects marked, deterministically', () => {
    const a = mkdtempSync(join(tmpdir(), 'brep-heal-a-'));
    try {
      const r = renderCase(damagedStandoff(), a, 200);
      expect(r.before.length).toBe(6);
      expect(r.after.length).toBe(0);
      expect(r.valid).toBe(true);
      const again = renderCase(damagedStandoff(), a, 200);
      expect(again.before).toEqual(r.before);
    } finally {
      rmSync(a, { recursive: true });
    }
  });
});
