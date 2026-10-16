import { expectTypeOf, it } from 'vitest';
import type { ExecutionReport, ExecutionSelection } from '../index';

it('exposes stable report fields without transport internals', () => {
  const report = null as unknown as ExecutionReport;
  expectTypeOf(report.workers).toEqualTypeOf<ExecutionSelection>();
  expectTypeOf(report.world.partialWrite).toBeBoolean();
  expectTypeOf(report.world.retryable).toBeBoolean();
  expectTypeOf(report.kernelDispatch.dispatched).toBeNumber();
  expectTypeOf(report.performance.hostFrameMs).toMatchTypeOf<object | null>();
  expectTypeOf(report.audio.owner).toEqualTypeOf<'host'>();
  expectTypeOf(report.render?.capabilities?.storageBuffer).toEqualTypeOf<boolean | undefined>();
  // @ts-expect-error transport identities are private
  void report.workerId;
  // @ts-expect-error SAB shards are private
  void report.shards;
});
