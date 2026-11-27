import { expect, it } from 'vitest';
import type { EngineWorkspaceProjectLifecycle } from '../workspace';
import { snapshotEngineWorkspaceProjectStatus } from '../workspace-project-status';

it('detaches preparation snapshots without changing lifecycle readiness', () => {
  const lifecycle: EngineWorkspaceProjectLifecycle = {
    phase: 'preparing',
    sessionId: 'project-1',
    generation: 4,
    preparation: {
      generation: 2,
      stage: 'shader',
      operation: 'shader-inputs',
      startedAt: 10,
      updatedAt: 20,
      activeCount: 1,
      active: [
        {
          source: 'engine/pbr.wgsl',
          phase: 'shader',
          startedAt: 12,
          progress: { completed: 3, total: 16 },
        },
      ],
      recent: [{ source: 'assets/b.pack.ts', cacheHit: true }],
    },
  };
  const wire = snapshotEngineWorkspaceProjectStatus(lifecycle);
  expect(wire).toEqual(lifecycle);
  expect(wire?.preparation).not.toBe(lifecycle.preparation);
  expect(wire?.preparation?.active[0]).not.toBe(lifecycle.preparation?.active[0]);
  expect(wire?.preparation?.recent[0]).not.toBe(lifecycle.preparation?.recent[0]);
});
