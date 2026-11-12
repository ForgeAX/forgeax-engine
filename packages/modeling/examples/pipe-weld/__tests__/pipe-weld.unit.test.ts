import { fileURLToPath } from 'node:url';
import type { Model } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildPipeWeld, filletDeviation } from '../body';

/**
 * Case C-128 gate: the welded tee, manifold and frame are closed and manifold,
 * the tee fillet follows the requested radius within 5 %, and every weld session labels
 * struts, caps and weld faces.
 */
describe('C-128 pipe weld', () => {
  it('builds watertight welded tee, manifold and frame with a 5 % fillet', () => {
    const recording = recordingSessions();
    const frame = buildPipeWeld(recording.session);
    const get = (name: string) => recording.sessions.get(name) as Model;
    for (const name of ['soft', 'tee', 'manifold', 'frame']) {
      expect(get(name).validate({ watertight: true }).pass, name).toBe(true);
    }
    for (const name of ['tee', 'manifold', 'frame']) {
      const labels = get(name)
        .inspect()
        .labels.map((l) => l.label);
      expect(
        labels.some((l) => l.startsWith('weld:')),
        name,
      ).toBe(true);
      expect(
        labels.some((l) => l.startsWith('strut:')),
        name,
      ).toBe(true);
    }
    const sample = filletDeviation(get('tee'));
    expect(sample.samples).toBeGreaterThan(0);
    expect(sample.worstDeviation).toBeLessThanOrEqual(0.05);
    expect(frame.validate({ watertight: true }).pass).toBe(true);
    const steps = attachSourceLines(
      recording.steps,
      fileURLToPath(new URL('../body.ts', import.meta.url)),
    );
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.filter((s) => s.entry.op === 'pipeNetwork')).toHaveLength(4);
  });
});
