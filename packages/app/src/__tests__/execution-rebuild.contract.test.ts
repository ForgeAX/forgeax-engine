import { Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { createExecutionReport, unavailableExecutionCapabilities } from '../execution';
import { createLocalExecutionControl } from '../execution/control';
import { workerSelection } from './execution-fixtures';

describe('execution rebuild contract', () => {
  it('keeps low-level local assembly explicit when no bootstrap exists', async () => {
    const control = createLocalExecutionControl(
      createExecutionReport(
        unavailableExecutionCapabilities('local'),
        workerSelection({ engine: false }),
      ),
    );
    const before = control.report();
    const result = await control.rebuild();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('app-execution-rebuild-failed');
    expect(control.report()).toEqual(before);
  });

  it('projects live local lifecycle and World state without a duplicate ledger', () => {
    const world = new World();
    const control = createLocalExecutionControl(
      createExecutionReport(
        unavailableExecutionCapabilities('local'),
        workerSelection({ engine: false }),
      ),
      { world: () => world.execution },
    );

    control.setEngineHealth('running');
    expect(control.report().engine.health).toBe('running');
    world
      .addSystem(Update, {
        name: 'execution-contract-failure',
        queries: [],
        fn() {
          throw new Error('execution contract failure');
        },
      })
      .unwrap();
    expect(world.update(1 / 60).ok).toBe(false);
    expect(control.report().world).toEqual({
      identity: world.identity,
      health: 'poisoned',
      partialWrite: true,
      retryable: false,
    });
    control.setEngineHealth('stopped');
    expect(control.report().engine.health).toBe('faulted');
  });
});
