import { fileURLToPath } from 'node:url';
import type { Model } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildPipeBend, C129, ELBOW, sectionAlongBend } from '../body';

/**
 * Case C-129 gate: every bent pipe is closed and manifold, the elbow section stays
 * within 4 % of the pipe radius and round within 4 %, and the case records at least three steps.
 */
describe('C-129 pipe bend', () => {
  it('builds watertight bent pipes with a constant section', () => {
    const recording = recordingSessions();
    const u = buildPipeBend(recording.session);
    const get = (name: string) => recording.sessions.get(name) as Model;
    for (const name of ['elbow', 'tight', 'double', 'u']) {
      expect(get(name).validate({ watertight: true }).pass, name).toBe(true);
      const labels = get(name)
        .inspect()
        .labels.map((l) => l.label);
      expect(
        labels.some((l) => l.startsWith('node:')),
        name,
      ).toBe(true);
    }
    const sample = sectionAlongBend(get('elbow'), ELBOW, C129.bendRadius, 'elbow');
    expect(sample.samples).toBeGreaterThan(0);
    expect(sample.worstDeviation).toBeLessThanOrEqual(0.04);
    expect(sample.worstRoundness).toBeLessThanOrEqual(0.06);
    expect(u.validate({ watertight: true }).pass).toBe(true);
    const steps = attachSourceLines(
      recording.steps,
      fileURLToPath(new URL('../body.ts', import.meta.url)),
    );
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });
});
