import type {
  ActivityEvent,
  ActivitySink,
  IntelligenceProvider,
} from '@forgeax/engine/intelligence';
import { createIntelligenceRuntime, IntelligenceError } from '@forgeax/engine/intelligence';
import { err, ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

function echoProvider(id: string): IntelligenceProvider & { flush(): void } {
  const sinks = new Map<string, { sink: ActivitySink; input: string }>();
  return {
    id,
    start(submission, sink) {
      if (submission.input === 'throw') throw new Error('provider exploded');
      if (submission.input === 'reject') {
        return err(
          new IntelligenceError({
            code: 'intelligence-provider-failed',
            detail: { providerId: id, cause: 'rejected' },
          }),
        );
      }
      sinks.set(submission.id, { sink, input: submission.input });
      return ok(undefined);
    },
    cancel(activity) {
      const entry = sinks.get(activity);
      if (entry === undefined) {
        return err(
          new IntelligenceError({
            code: 'intelligence-activity-not-found',
            detail: { activityId: activity },
          }),
        );
      }
      sinks.delete(activity);
      entry.sink.cancelled();
      return ok(undefined);
    },
    flush() {
      for (const [key, { sink, input }] of sinks) {
        sinks.delete(key);
        sink.text(input.toUpperCase());
        sink.complete(`done:${input}`);
      }
    },
    async close() {
      sinks.clear();
    },
  };
}

const codeOf = (result: { ok: boolean; error?: { code: string } }): string =>
  result.ok ? 'ok' : (result.error?.code ?? 'unknown');

export default defineFeature({
  title: 'Provider-neutral Activity',
  catalog: 'Provider-neutral Activity',
  kind: 'headless',
  summary:
    'IntelligenceRuntime wraps any IntelligenceProvider (here a hand-written echo provider) and turns its sink calls into ordered, bounded, polled POD ActivityEvent values with structured IntelligenceError failures.',
  expect:
    'All checks pass: events arrive in per-Activity sequence order, sessions are reused, cancel yields a cancelled terminal, and invalid input / capacity / mismatch / overflow / provider failure / closed all return their closed error codes.',
  async run(checks) {
    const provider = echoProvider('lab.echo');
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 2, maxOutputChars: 32 },
    });
    checks.equal(
      'limits merge with defaults',
      [runtime.limits.maxConcurrentActivities, runtime.limits.maxInputChars],
      [2, 16384],
    );
    const first = runtime.submit({ input: 'hi' });
    checks.ok('submit returns an ActivityRef', first.ok);
    if (!first.ok) return;
    checks.equal('session belongs to the provider', first.value.session.providerId, 'lab.echo');
    checks.equal('no events before the provider emits', runtime.poll().length, 0);
    provider.flush();
    const events: ActivityEvent[] = [...runtime.poll()];
    checks.equal(
      'ordered text-delta then completed',
      events.map((event) => [event.type, event.sequence]),
      [
        ['text-delta', 1],
        ['completed', 2],
      ],
    );
    const done = events[1];
    checks.ok(
      'completed carries output and session',
      done?.type === 'completed' &&
        done.output === 'done:hi' &&
        done.session.id === first.value.session.id,
    );

    const reuse = runtime.submit({ input: 'again', session: first.value.session });
    checks.ok(
      'session can be reused for a follow-up',
      reuse.ok && reuse.value.session.id === first.value.session.id,
    );
    const second = runtime.submit({ input: 'two' });
    checks.equal(
      'third concurrent Activity exceeds capacity',
      codeOf(runtime.submit({ input: 'three' })),
      'intelligence-capacity-exceeded',
    );
    if (second.ok) {
      checks.ok('cancel ok', runtime.cancel(second.value.id).ok);
      const cancelled = runtime.poll().filter((event) => event.activityId === second.value.id);
      checks.equal(
        'cancelled terminal',
        cancelled.map((event) => event.type),
        ['cancelled'],
      );
      checks.equal(
        'cancel after terminal is activity-not-found',
        codeOf(runtime.cancel(second.value.id)),
        'intelligence-activity-not-found',
      );
    }
    provider.flush();
    runtime.poll();

    checks.equal(
      'empty input is invalid-request',
      codeOf(runtime.submit({ input: '' })),
      'intelligence-invalid-request',
    );
    checks.equal(
      'foreign session is provider-mismatch',
      codeOf(runtime.submit({ input: 'x', session: { providerId: 'other', id: 's' } })),
      'intelligence-session-provider-mismatch',
    );
    checks.equal(
      'throwing provider is provider-failed',
      codeOf(runtime.submit({ input: 'throw' })),
      'intelligence-provider-failed',
    );
    checks.equal(
      'rejecting provider result is forwarded',
      codeOf(runtime.submit({ input: 'reject' })),
      'intelligence-provider-failed',
    );

    const big = runtime.submit({ input: 'x'.repeat(40) });
    provider.flush();
    const overflow = runtime.poll().filter((event) => big.ok && event.activityId === big.value.id);
    checks.ok(
      'output beyond maxOutputChars fails with output-overflow',
      overflow.length === 1 &&
        overflow[0]?.type === 'failed' &&
        overflow[0].error.code === 'intelligence-output-overflow',
      JSON.stringify(overflow.map((event) => event.type)),
    );

    await runtime.close();
    checks.equal(
      'submit after close is closed',
      codeOf(runtime.submit({ input: 'late' })),
      'intelligence-closed',
    );
    checks.equal('poll after close is empty', runtime.poll().length, 0);
  },
});
