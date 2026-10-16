import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRecoveryBaseline, repositoryRoot } from './fixtures/recovery-baseline';

describe('M16 recovery baseline', () => {
  it('records the repository root and current head', () => {
    const baseline = collectRecoveryBaseline();

    expect(resolve(baseline.repositoryRoot)).toBe(repositoryRoot);
    expect(baseline.head.ok, `${baseline.head.command}: ${baseline.head.output}`).toBe(true);
    expect(baseline.head.output).toMatch(/^[0-9a-f]{40}$/);
  });

  it('freezes package ownership, public exports, and cohesion observations', () => {
    const baseline = collectRecoveryBaseline();

    expect(baseline.packageOwnership).toHaveLength(3);
    expect(baseline.packageOwnership.flatMap((entry) => entry.paths)).toEqual(
      expect.arrayContaining([
        'packages/net/src/session',
        'packages/net-websocket/src/node.ts',
        'apps/multiplayer-snake/src/client.ts',
      ]),
    );
    expect(baseline.packageOwnership.every((entry) => entry.cohesion.length > 0)).toBe(true);
    expect(baseline.publicExports).toEqual([
      expect.objectContaining({
        packageName: '@forgeax/engine-net',
        entries: expect.arrayContaining(['NetEndpoint', 'NetSession', 'ReplicaCoordinator']),
      }),
      expect.objectContaining({
        packageName: '@forgeax/engine-net-websocket',
        entries: ['./browser', './node'],
      }),
    ]);
  });

  it('fails with the affected path and command when a boundary drifts', () => {
    const baseline = collectRecoveryBaseline();
    const checks = [...baseline.readmeRecoveryBoundaries, ...baseline.lifecycleFacts];

    expect(checks).not.toHaveLength(0);
    for (const check of checks) {
      expect(check.present, `${check.path}; rerun: ${check.command}`).toBe(true);
    }
  });

  it('retains the AC-02/03/04/06/07/12 falsifier inventory', () => {
    const baseline = collectRecoveryBaseline();

    expect(baseline.intendedFalsifiers.map((entry) => entry.acceptanceId)).toEqual([
      'AC-02',
      'AC-03',
      'AC-04',
      'AC-06',
      'AC-07',
      'AC-12',
    ]);
    expect(baseline.intendedFalsifiers.every((entry) => entry.expectedOutcome.length > 0)).toBe(true);
  });
});
