import { describe, expect, it } from 'vitest';
import { buildCorner, buildRoll, buildRunOut, buildSharp } from '../../blend-corner/body';
import { buildPanels, hoodPatches, SURFACE_TOLERANCE } from '../../body-panels/panels';
import { CORNER, CORNER_BLENDS, CORNER_FACES } from '../../c131/body';
import { buildLayout } from '../../patch-network/body';
import { buildRight } from '../../quality-body/body';
import { type Model, model } from '../../../src/model';
import { type Audited, auditSeams, type Named } from '../../../src/__tests__/support/seams';

/**
 * Every example that tessellates patches through `m.surface`, except the mech-gt rooms (their
 * whole-run scan has its own gate). Each builder returns the session; the audit reads the patches
 * the kernel recorded for it.
 */
type Built = Pick<Model, 'diagnostics'>;

const CORPUS: readonly { name: string; build: () => Built; minSeams: number }[] = [
  { name: 'blend-corner/sharp', build: () => buildSharp(), minSeams: 2 },
  { name: 'blend-corner/roll', build: () => buildRoll(), minSeams: 2 },
  { name: 'blend-corner/run-out', build: () => buildRunOut(), minSeams: 2 },
  { name: 'blend-corner/corner', build: () => buildCorner(), minSeams: 6 },
  { name: 'body-panels/panels', build: () => buildPanels(), minSeams: 1 },
  { name: 'patch-network/layout', build: () => buildLayout(), minSeams: 9 },
  { name: 'quality-body/right', build: () => buildRight(), minSeams: 6 },
  {
    name: 'c131/corner',
    build: () => {
      const m = model();
      m.surface({ patches: CORNER_FACES, blends: CORNER_BLENDS, corners: [CORNER], chord: 0.0005 });
      return m;
    },
    minSeams: 6,
  },
];

const recorded = (m: Built): Named[] =>
  m.diagnostics().surfaces.map((s) => ({ name: s.name, surface: s.surface }));

describe('surface seam corpus', () => {
  for (const row of CORPUS) {
    it(`${row.name}: seams close by identity, open edges stay on the declared boundary`, () => {
      const m = row.build();
      const audit = auditSeams(m as unknown as Audited, recorded(m));
      expect(
        audit.seams,
        'non-vacuous: the example has patch-to-patch seams',
      ).toBeGreaterThanOrEqual(row.minSeams);
      expect(audit.openOnSeam).toEqual([]);
      expect(audit.openOffBoundary).toEqual([]);
      expect(audit.duplicates).toBe(0);
      expect(audit.issues).toEqual([]);
    });
  }

  it('flags a seam tessellated twice (falsifier)', () => {
    const patches = hoodPatches().map((p, i) => ({ ...p, name: p.name ?? `hood-${i}` }));
    const together = model();
    together.surface({ patches, ...SURFACE_TOLERANCE });
    const joined = auditSeams(together as unknown as Audited, patches);
    expect(joined.seams).toBe(1);
    expect(joined.openOnSeam).toEqual([]);
    expect(joined.duplicates).toBe(0);
    const apart = model();
    for (const p of patches) apart.surface({ patches: [p], ...SURFACE_TOLERANCE });
    const audit = auditSeams(apart as unknown as Audited, patches);
    expect(audit.seams).toBe(1);
    expect(audit.openOnSeam.length).toBeGreaterThan(0);
    expect(audit.duplicates).toBeGreaterThan(0);
  });
});
