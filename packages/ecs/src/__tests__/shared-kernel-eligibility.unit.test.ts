import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { SharedKernelEligibilityError } from '../errors';
import {
  defineSharedKernel,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
  sharedKernelEligibility,
} from '../execution/shared-kernel';
import { defineSystemSet } from '../schedule';
import { Update } from '../schedule-token';
import { World } from '../world';

const Position = defineComponent('SharedKernelEligibilityPosition', { x: 'f32' });
const Name = defineComponent('SharedKernelEligibilityName', { value: 'string' });

function integrate(): void {}
function touchesDom(): void {
  void document;
}

describe('SharedKernel eligibility', () => {
  it('accepts a module-loadable named numeric QuerySpan kernel', () => {
    const kernel = defineSharedKernel(import.meta.url, {
      name: 'integrate',
      queries: [{ write: [Position] }],
      run: integrate,
    });
    expect(kernel.queries[0]?.write).toEqual([Position]);
  });

  it('rejects capture-shaped callbacks, DOM, object fields, missing access and conflicts', () => {
    const fixtures = [
      { queries: [{ write: [Position] }], run: () => {} },
      { queries: [{ write: [Position] }], run: touchesDom },
      { queries: [{ read: [Name] }], run: integrate },
      { queries: [{}], run: integrate },
      { queries: [{ read: [Position], write: [Position] }], run: integrate },
    ] as const;
    expect(
      fixtures.map((fixture) =>
        sharedKernelEligibility(import.meta.url, { name: 'bad', ...fixture }),
      ),
    ).toEqual([
      'callback-not-module-function',
      'dom-access',
      'object-field',
      'missing-access-declaration',
      'descriptor-conflict',
    ]);
    expect(() => defineSharedKernel(import.meta.url, { name: 'bad', ...fixtures[0] })).toThrow(
      SharedKernelEligibilityError,
    );
  });

  it('warms shared executors through every system registration entry', () => {
    const world = new World();
    const warmed: string[] = [];
    const executor: SharedKernelExecutor = {
      warmup: (kernel) => warmed.push(kernel.name),
      execute: () => ({ mode: 'forced-inline', dispatched: 0, completed: 0, waitMs: 0 }),
    };
    world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
    const kernel = (name: string) =>
      defineSharedKernel(import.meta.url, {
        name,
        queries: [{ write: [Position] }],
        run: integrate,
      });

    world.addSystem(Update, kernel('direct')).unwrap();
    const Batch = defineSystemSet({ name: 'shared-kernel-batch' });
    world.addSystems(Update, Batch, [kernel('batch')]).unwrap();
    world.replaceSystem(Update, 'direct', kernel('replacement')).unwrap();

    expect(warmed).toEqual(['direct', 'batch', 'replacement']);
  });
});
