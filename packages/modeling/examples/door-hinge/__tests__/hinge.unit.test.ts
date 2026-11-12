import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildDoorHinge, DOOR_HINGE_DEFAULTS } from '../hinge';

describe('C-103 door hinge', () => {
  it('assembles a clean hinge with panel lines at every opening', { timeout: 300000 }, () => {
    for (const openAngle of [100, 110, 150, 180]) {
      const m = buildDoorHinge({ openAngle });
      expect(m.poisoned).toBeUndefined();
      const report = m.validate();
      expect(report.closed).toBe(true);
      expect(report.issues.filter((i) => i.severity !== 'info'), `open ${openAngle}`).toEqual([]);
      const warnings = m.journal.flatMap((e) => (e.diagnostics ?? []).filter((d) => d.severity === 'warn'));
      expect(warnings).toEqual([]);
      expect(m.count(sel.createdBy('cover-seam', 'groove'))).toBeGreaterThan(0);
      expect(m.count(sel.createdBy('cover-seam', 'lip'))).toBeGreaterThan(0);
      expect(m.count(sel.createdBy('cover-band', 'groove'))).toBeGreaterThan(0);
    }
  });

  it('records one step per source line and is deterministic', { timeout: 120000 }, () => {
    const recording = recordingSessions();
    buildDoorHinge(DOOR_HINGE_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, new URL('../hinge.ts', import.meta.url).pathname);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(buildDoorHinge().snapshot()).toEqual(buildDoorHinge().snapshot());
  });
});
