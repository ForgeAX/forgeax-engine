import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildJoint, JOINT_DEFAULTS } from '../joint';

describe('C-102 hydraulic joint', () => {
  it('assembles a clean joint from recipes at every extension', { timeout: 300000 }, () => {
    for (const extension of [0, 0.5, 1]) {
      const m = buildJoint({ extension });
      expect(m.poisoned).toBeUndefined();
      const report = m.validate();
      expect(report.closed).toBe(true);
      expect(report.issues.filter((i) => i.severity !== 'info'), `extension ${extension}`).toEqual([]);
      const warnings = m.journal.flatMap((e) => (e.diagnostics ?? []).filter((d) => d.severity === 'warn'));
      expect(warnings).toEqual([]);
      expect(m.count(sel.tag('cylinder'))).toBeGreaterThan(0);
      expect(m.count(sel.createdBy('bearing-front-ball'))).toBeGreaterThan(0);
    }
  });

  it('records one step per source line and is deterministic', { timeout: 120000 }, () => {
    const recording = recordingSessions();
    buildJoint(JOINT_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, new URL('../joint.ts', import.meta.url).pathname);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(buildJoint().snapshot()).toEqual(buildJoint().snapshot());
  });
});
