import { fileURLToPath } from 'node:url';
import { regen, Selector, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildFeatureBracket, FEATURE_BRACKET_SETS } from '../body';

/**
 * Case C-123 gate: the feature bracket rebuilt under three parameter sets keeps its
 * op sequence, its selector match counts and its provenance pairing (`regen`), and an
 * index-based face pick in the same build is reported as a naming-unstable step.
 */
describe('C-123 feature bracket', () => {
  it('rebuilds under three parameter sets with stable naming and valid solids', () => {
    const report = regen(buildFeatureBracket, FEATURE_BRACKET_SETS);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings).toEqual([]);
    expect(report.value.runs.map((r) => r.operations)).toEqual([11, 11, 11]);
    expect(report.value.runs.every((r) => r.poisoned === undefined)).toBe(true);
    for (const set of FEATURE_BRACKET_SETS) {
      expect(buildFeatureBracket(set).validate({ minThickness: 0.002 }).pass).toBe(true);
    }
    const counts = report.value.selectorCounts.flatMap((s) => s.matched);
    expect(counts.length).toBeGreaterThan(8);
  });

  it('falsifier: a fixed face index in place of a createdBy selector fails the named step', () => {
    const indexed = (p: (typeof FEATURE_BRACKET_SETS)[number]) => {
      const m = buildFeatureBracket(p);
      const top = 20;
      const byIndex = new Selector('face', `faceId(${top})`, (mesh) =>
        mesh.faces().filter((f) => f === top),
      );
      m.extrude(byIndex.one(), { distance: 0.001, region: 'merged', label: 'by-index' });
      return m;
    };
    const report = regen(indexed, FEATURE_BRACKET_SETS);
    expect(report.ok && report.value.pass).toBe(false);
    const first = report.ok ? report.value.findings[0] : undefined;
    expect(first).toMatchObject({ step: 12, label: 'by-index', reason: 'selector-provenance' });
    expect(sel.all().description).toBe('all()');
  });

  it('falsifier: boss-fillet faces picked by index land on the other side of the boss', () => {
    const results = [40, 41, 42, 43].map((id) => {
      const indexed = (p: (typeof FEATURE_BRACKET_SETS)[number]) => {
        const m = buildFeatureBracket(p);
        const byIndex = new Selector('face', `faceId(${id})`, (mesh) =>
          mesh.faces().filter((f) => f === id),
        );
        m.extrude(byIndex.one(), { distance: 0.001, region: 'merged', label: 'by-index' });
        return m;
      };
      const report = regen(indexed, FEATURE_BRACKET_SETS);
      return report.ok && report.value.pass;
    });
    expect(results).toContain(false);
  });

  it('falsifier: a stable-text pick whose facing swaps between sets fails on its signature', () => {
    const swapped = (p: (typeof FEATURE_BRACKET_SETS)[number]) => {
      const m = buildFeatureBracket(p);
      const flip = p === FEATURE_BRACKET_SETS[1];
      const pick = new Selector('face', 'pocket-wall', (mesh) =>
        sel
          .createdBy('pocket-cut', 'side')
          .and(sel.facing(flip ? '-x' : '+x'))
          .evaluate(mesh),
      );
      m.extrude(pick.one(), { distance: 0.001, region: 'merged', label: 'swapped' });
      return m;
    };
    const report = regen(swapped, FEATURE_BRACKET_SETS);
    expect(report.ok && report.value.pass).toBe(false);
    expect(report.ok && report.value.findings.map((f) => `${f.step}/${f.reason}`)).toEqual([
      '12/selector-signature',
    ]);
  });

  it('records at least three source-mapped steps', () => {
    const recording = recordingSessions();
    buildFeatureBracket(FEATURE_BRACKET_SETS[0], recording.session);
    const steps = attachSourceLines(
      recording.steps,
      fileURLToPath(new URL('../body.ts', import.meta.url)),
    );
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.every((s) => s.line > 0)).toBe(true);
  });
});
