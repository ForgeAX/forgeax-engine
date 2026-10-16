import { defineComponent, type QuerySpan, Update, World } from '@forgeax/engine/ecs';
import {
  defineSharedKernel,
  SHARED_KERNEL_ELIGIBILITY_REASONS,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
  sharedKernelEligibility,
} from '@forgeax/engine/ecs/shared';
import { defineFeature } from '../../lab/feature';

const KPos = defineComponent('FLKernelPos', { x: 'f32' });
const KName = defineComponent('FLKernelName', { value: 'string' });

function flKernelDouble(spans: readonly QuerySpan[]): void {
  for (const span of spans) {
    const col = span.mut(KPos).x;
    for (let i = 0; i < span.length; i += 1) col[i] = (col[i] ?? 0) * 2;
  }
}

function flKernelDom(): void {
  void document;
}

export default defineFeature({
  title: 'Shared numeric kernels',
  catalog: 'Shared numeric kernels',
  kind: 'headless',
  summary:
    'defineSharedKernel accepts only module-loadable named functions over dense numeric QuerySpans; without an executor it runs inline on the same World.',
  expect:
    'All checks pass: an eligible kernel doubles x inline, each ineligible shape reports its closed reason, and a partial-write executor failure poisons the World.',
  run(checks) {
    checks.equal(
      'closed reason set',
      [...SHARED_KERNEL_ELIGIBILITY_REASONS],
      [
        'callback-not-module-function',
        'dom-access',
        'missing-access-declaration',
        'descriptor-conflict',
        'object-field',
        'span-unavailable',
      ],
    );
    const url = import.meta.url;
    const reason = (queries: readonly object[], run: (spans: readonly QuerySpan[]) => void) =>
      sharedKernelEligibility(url, { name: 'fl-bad', queries: queries as never, run });
    checks.equal(
      'arrow callback',
      reason([{ write: [KPos] }], () => undefined),
      'callback-not-module-function',
    );
    checks.equal('DOM access', reason([{ write: [KPos] }], flKernelDom), 'dom-access');
    checks.equal('object field', reason([{ read: [KName] }], flKernelDouble), 'object-field');
    checks.equal('missing access', reason([{}], flKernelDouble), 'missing-access-declaration');
    checks.equal(
      'conflict',
      reason([{ read: [KPos], write: [KPos] }], flKernelDouble),
      'descriptor-conflict',
    );
    checks.equal(
      'changed filter',
      reason([{ write: [KPos], changed: [KPos] }], flKernelDouble),
      'span-unavailable',
    );
    let thrown = 'none';
    try {
      defineSharedKernel(url, {
        name: 'fl-throw',
        queries: [{ write: [KPos] }],
        run: () => undefined,
      });
    } catch (error) {
      thrown = (error as { code?: string }).code ?? 'thrown';
    }
    checks.equal('defineSharedKernel rejects', thrown, 'shared-kernel-ineligible');

    const kernel = defineSharedKernel(url, {
      name: 'fl-double',
      minimumRows: 1,
      queries: [{ write: [KPos] }],
      run: flKernelDouble,
    });
    const world = new World();
    const e = world.spawn({ component: KPos, data: { x: 3 } }).unwrap();
    checks.ok('addSystem(kernel)', world.addSystem(Update, kernel).ok);
    checks.ok('inline update', world.update(1 / 60).ok);
    checks.equal('inline result', world.get(e, KPos).unwrap().x, 6);

    const faulty = new World();
    faulty.spawn({ component: KPos, data: { x: 1 } }).unwrap();
    const executor: SharedKernelExecutor = {
      execute: () => ({
        cause: new Error('fl fault'),
        dispatched: 2,
        completed: 1,
        partialWrite: true,
      }),
    };
    faulty.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
    faulty.addSystem(Update, kernel);
    const failed = faulty.update(1 / 60);
    checks.equal(
      'partial write fails the system',
      failed.ok ? 'ok' : failed.error.code,
      'system-failed',
    );
    checks.equal('World poisoned', faulty.execution.health, 'poisoned');
    checks.equal('fault code', faulty.execution.fault?.code, 'shared-kernel-failed');
    const next = faulty.update(1 / 60);
    checks.equal('next update rejected', next.ok ? 'ok' : next.error.code, 'world-poisoned');
  },
});
