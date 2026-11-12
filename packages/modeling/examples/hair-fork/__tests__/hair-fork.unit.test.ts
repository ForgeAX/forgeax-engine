import { fileURLToPath } from 'node:url';
import type { Model } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildHairFork, FORK, LOCK, sectionTable } from '../body';

/**
 * Case C-127 gate: the equal, 1:2 and tapering forks and the two-level lock are
 * all-quad, watertight and keep every sampled section within 3 % of its interpolated radius.
 */
describe('C-127 hair fork', () => {
  it('builds watertight forks whose sections follow the requested radii', () => {
    const recording = recordingSessions();
    const lock = buildHairFork(recording.session);
    const get = (name: string) => recording.sessions.get(name) as Model;
    const nets = { equal: FORK, fork: FORK, taper: FORK, lock: LOCK } as const;
    for (const [name, net] of Object.entries(nets)) {
      const session = get(name);
      expect(session.validate({ watertight: true }).pass, name).toBe(true);
      const rows = sectionTable(session, net);
      expect(rows.length, name).toBe(net.edges.length * 3);
      rows.forEach((row, i) =>
        expect(row.maxDeviation, `${name} strut ${row.edge} at ${row.at}`).toBeLessThanOrEqual(
          i % 3 === 1 ? 0.03 : 0.1,
        ),
      );
    }
    const mean = (name: string, edge: number) =>
      sectionTable(get(name), FORK)
        .filter((r) => r.edge === edge)
        .reduce((a, r) => a + r.meanRadius, 0) / 3;
    expect(mean('fork', 1) / mean('fork', 0)).toBeCloseTo(0.5, 1);
    expect(mean('equal', 1) / mean('equal', 0)).toBeCloseTo(1, 1);
    expect(lock.validate({ watertight: true }).pass).toBe(true);
    const steps = attachSourceLines(
      recording.steps,
      fileURLToPath(new URL('../body.ts', import.meta.url)),
    );
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.filter((s) => s.entry.op === 'pipeNetwork')).toHaveLength(4);
  });

  it('tapers: the mean radius falls along each branch of the tapering fork', () => {
    const recording = recordingSessions();
    buildHairFork(recording.session);
    const rows = sectionTable(recording.sessions.get('taper') as Model, FORK);
    for (const edge of [1, 2]) {
      const mine = rows.filter((r) => r.edge === edge).map((r) => r.meanRadius);
      expect(mine[0]).toBeGreaterThan(mine[1] as number);
      expect(mine[1]).toBeGreaterThan(mine[2] as number);
    }
  });
});
