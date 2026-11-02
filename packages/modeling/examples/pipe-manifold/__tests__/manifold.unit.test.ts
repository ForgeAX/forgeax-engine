import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildManifold, CROSS, FIVE, MANIFOLD, sectionTable, TEE } from '../body';

/**
 * Case C-121 gate: a tee, a cross and a 5-way built by pipeNetwork alone and as one
 * connected manifold are all-quad, watertight, and keep the strut section radius within 3 %.
 */
describe('C-121 pipe manifold', () => {
  it('builds all-quad watertight manifolds with the section radius within 3 %', () => {
    const recording = recordingSessions();
    const m = buildManifold(recording.session);
    for (const [name, net] of [
      ['tee', TEE],
      ['cross', CROSS],
      ['five-way', FIVE],
      ['manifold', MANIFOLD],
    ] as const) {
      const session = recording.sessions.get(name);
      expect(session, name).toBeDefined();
      const report = session?.validate({ watertight: true });
      expect(report?.pass, name).toBe(true);
      const rows = sectionTable(session as typeof m, net);
      expect(rows.length).toBe(net.edges.length * 3);
      for (const row of rows)
        expect(row.maxDeviation, `${name} strut ${row.edge}`).toBeLessThanOrEqual(0.03);
    }
    const steps = attachSourceLines(
      recording.steps,
      fileURLToPath(new URL('../body.ts', import.meta.url)),
    );
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.filter((s) => s.entry.op === 'pipeNetwork')).toHaveLength(4);
  });
});
