import { err, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { IntelligenceError } from '../errors';
import { createIntelligenceRuntime } from '../runtime';
import {
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  activityId,
  type IntelligenceProvider,
} from '../types';

function controlledProvider(id = 'test.provider') {
  const sinks = new Map<ActivityId, ActivitySink>();
  let closed = false;
  const provider: IntelligenceProvider = {
    id,
    start(submission, sink) {
      sinks.set(submission.id, sink);
      return ok(undefined);
    },
    cancel(activity) {
      const sink = sinks.get(activity);
      if (sink === undefined) {
        return err(
          new IntelligenceError({
            code: 'intelligence-activity-not-found',
            detail: { activityId: activity },
          }),
        );
      }
      sinks.delete(activity);
      sink.cancelled();
      return ok(undefined);
    },
    async close() {
      closed = true;
      for (const sink of sinks.values()) sink.cancelled();
      sinks.clear();
    },
  };
  return {
    provider,
    sinks,
    get closed() {
      return closed;
    },
  };
}

describe('IntelligenceRuntime', () => {
  it('delivers ordered bounded deltas and a terminal result without awaiting in poll', () => {
    const controlled = controlledProvider();
    const runtime = createIntelligenceRuntime(controlled.provider, {
      createActivityId: () => activityId('activity-a'),
      createSessionId: () => 'session-a',
    });
    const started = runtime.submit({ input: 'hello' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sink = controlled.sinks.get(started.value.id);
    expect(sink).toBeDefined();
    sink?.text('hel');
    sink?.text('lo');
    sink?.complete('hello');

    expect(runtime.poll()).toEqual([
      { type: 'text-delta', activityId: activityId('activity-a'), sequence: 1, text: 'hel' },
      { type: 'text-delta', activityId: activityId('activity-a'), sequence: 2, text: 'lo' },
      {
        type: 'completed',
        activityId: activityId('activity-a'),
        sequence: 3,
        session: { providerId: 'test.provider', id: 'session-a' },
        output: 'hello',
      },
    ]);
    expect(runtime.poll()).toEqual([]);
  });

  it('rejects cross-provider session reuse before provider dispatch', () => {
    const controlled = controlledProvider();
    const runtime = createIntelligenceRuntime(controlled.provider);
    const result = runtime.submit({
      input: 'resume',
      session: { providerId: 'another.provider', id: 'session-a' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('intelligence-session-provider-mismatch');
    expect(controlled.sinks.size).toBe(0);
  });

  it('accepts exact-limit input and rejects invalid input before identity, capacity, or provider start', () => {
    const sinks = new Map<string, ActivitySink>();
    let activityIdentityCalls = 0;
    let sessionIdentityCalls = 0;
    let providerStarts = 0;
    const provider: IntelligenceProvider = {
      id: 'input.boundary.provider',
      start(submission, sink) {
        providerStarts += 1;
        sinks.set(submission.id, sink);
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxInputChars: 4, maxConcurrentActivities: 1 },
      createActivityId: () => {
        activityIdentityCalls += 1;
        return activityId('input-boundary-activity');
      },
      createSessionId: () => {
        sessionIdentityCalls += 1;
        return 'input-boundary-session';
      },
    });

    const exact = runtime.submit({ input: 'abcd' });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(providerStarts).toBe(1);
    expect(activityIdentityCalls).toBe(1);
    expect(sessionIdentityCalls).toBe(1);

    const empty = runtime.submit({ input: '' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('intelligence-invalid-request');
      expect(empty.error.detail).toEqual({ field: 'input', reason: 'input is empty' });
    }

    const overLimit = runtime.submit({ input: 'abcde' });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.error.code).toBe('intelligence-invalid-request');
      expect(overLimit.error.detail).toEqual({
        field: 'input',
        reason: 'input exceeds 4 characters',
      });
    }

    expect(activityIdentityCalls).toBe(1);
    expect(sessionIdentityCalls).toBe(1);
    expect(providerStarts).toBe(1);
    expect(sinks.size).toBe(1);

    sinks.get(exact.value.id)?.complete('done');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: exact.value.id,
        sequence: 1,
        session: exact.value.session,
        output: 'done',
      },
    ]);
  });

  it('turns queue overflow into one structured terminal failure and cancels the provider', () => {
    const controlled = controlledProvider();
    const runtime = createIntelligenceRuntime(controlled.provider, {
      limits: { maxPendingEventsPerActivity: 3 },
      createActivityId: () => activityId('overflow'),
    });
    const started = runtime.submit({ input: 'overflow' });
    if (!started.ok) throw started.error;
    const sink = controlled.sinks.get(started.value.id);
    sink?.text('one');
    sink?.text('two');
    sink?.text('three');

    const events = runtime.poll();
    expect(events).toHaveLength(3);
    expect(events[2]?.type).toBe('failed');
    if (events[2]?.type === 'failed') {
      expect(events[2].error.code).toBe('intelligence-output-overflow');
    }
    expect(controlled.sinks.size).toBe(0);
  });

  it('fails exactly once when cumulative streamed output crosses the character limit', () => {
    const exactId = activityId('exact-stream');
    const overflowId = activityId('stream-output-overflow');
    const ids = [exactId, overflowId];
    const controlled = controlledProvider('output.stream.provider');
    const runtime = createIntelligenceRuntime(controlled.provider, {
      limits: { maxOutputChars: 5, maxPendingEventsPerActivity: 8 },
      createActivityId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('test activity identity exhausted');
        return id;
      },
    });

    const exact = runtime.submit({ input: 'exact' });
    const overflow = runtime.submit({ input: 'stream' });
    expect(exact.ok).toBe(true);
    expect(overflow.ok).toBe(true);
    if (!exact.ok || !overflow.ok) return;
    const exactSink = controlled.sinks.get(exact.value.id);
    const overflowSink = controlled.sinks.get(overflow.value.id);
    expect(exactSink).toBeDefined();
    expect(overflowSink).toBeDefined();

    exactSink?.complete('12345');
    overflowSink?.text('12345');
    overflowSink?.text('!');
    overflowSink?.text('late');
    overflowSink?.complete('duplicate');
    overflowSink?.fail(new Error('duplicate'));

    const events = runtime.poll();
    expect(events).toEqual([
      {
        type: 'completed',
        activityId: exactId,
        sequence: 1,
        session: exact.value.session,
        output: '12345',
      },
      {
        type: 'text-delta',
        activityId: overflowId,
        sequence: 1,
        text: '12345',
      },
      {
        type: 'failed',
        activityId: overflowId,
        sequence: 2,
        error: expect.objectContaining({
          code: 'intelligence-output-overflow',
          detail: {
            activityId: overflowId,
            bound: 'output-chars',
            limit: 5,
          },
        }),
      },
    ]);
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1);
    expect(controlled.sinks.has(overflowId)).toBe(false);
  });

  it('fails exactly once when a completion payload exceeds the character limit', () => {
    const exactId = activityId('exact-completion');
    const overflowId = activityId('completion-output-overflow');
    const ids = [exactId, overflowId];
    const controlled = controlledProvider('output.completion.provider');
    const runtime = createIntelligenceRuntime(controlled.provider, {
      limits: { maxOutputChars: 5, maxPendingEventsPerActivity: 8 },
      createActivityId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('test activity identity exhausted');
        return id;
      },
    });

    const exact = runtime.submit({ input: 'exact' });
    const overflow = runtime.submit({ input: 'completion' });
    expect(exact.ok).toBe(true);
    expect(overflow.ok).toBe(true);
    if (!exact.ok || !overflow.ok) return;
    const exactSink = controlled.sinks.get(exact.value.id);
    const overflowSink = controlled.sinks.get(overflow.value.id);
    expect(exactSink).toBeDefined();
    expect(overflowSink).toBeDefined();

    exactSink?.complete('12345');
    overflowSink?.complete('123456');
    overflowSink?.text('late');
    overflowSink?.complete('duplicate');
    overflowSink?.cancelled();

    const events = runtime.poll();
    expect(events).toEqual([
      {
        type: 'completed',
        activityId: exactId,
        sequence: 1,
        session: exact.value.session,
        output: '12345',
      },
      {
        type: 'failed',
        activityId: overflowId,
        sequence: 1,
        error: expect.objectContaining({
          code: 'intelligence-output-overflow',
          detail: {
            activityId: overflowId,
            bound: 'output-chars',
            limit: 5,
          },
        }),
      },
    ]);
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1);
    expect(controlled.sinks.has(overflowId)).toBe(false);
  });

  it('preserves the provider error category and cause projection', () => {
    const controlled = controlledProvider();
    const runtime = createIntelligenceRuntime(controlled.provider, {
      createActivityId: () => activityId('failed'),
    });
    const started = runtime.submit({ input: 'fail' });
    if (!started.ok) throw started.error;
    controlled.sinks.get(started.value.id)?.fail(new Error('provider exploded'));
    const event = runtime.poll()[0];
    expect(event?.type).toBe('failed');
    if (event?.type === 'failed') {
      expect(event.error.code).toBe('intelligence-provider-failed');
      if (event.error.code === 'intelligence-provider-failed') {
        expect(event.error.detail.cause).toBe('provider exploded');
      }
    }
  });

  it('closes the provider and rejects later work', async () => {
    const controlled = controlledProvider();
    const runtime = createIntelligenceRuntime(controlled.provider);
    await runtime.close();
    expect(controlled.closed).toBe(true);
    const result = runtime.submit({ input: 'late' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('intelligence-closed');
  });

  it('contains provider close rejection, clears records, and quarantines late callbacks', async () => {
    const activity = activityId('close-rejection');
    let sink: ActivitySink | undefined;
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'close.rejection.provider',
      start(_submission, nextSink) {
        sink = nextSink;
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
        throw new Error('sentinel provider close failure');
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      createActivityId: () => activity,
    });
    const started = runtime.submit({ input: 'close me' });
    expect(started.ok).toBe(true);

    const closeTask = runtime.close();
    expect(runtime.close()).toBe(closeTask);
    await expect(closeTask).resolves.toBeUndefined();

    expect(closeCalls).toBe(1);
    expect(runtime.poll()).toEqual([]);
    const late = runtime.submit({ input: 'after close' });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('intelligence-closed');
    sink?.text('late text');
    sink?.complete('late completion');
    sink?.fail(new Error('late failure'));
    expect(runtime.poll()).toEqual([]);
  });

  it('accepts a transport-owned identity and provider session', () => {
    const controlled = controlledProvider();
    const runtime = createIntelligenceRuntime(controlled.provider);
    const submission: ActivitySubmission = {
      id: activityId('transport-owned'),
      session: { providerId: 'test.provider', id: 'saved-session' },
      input: 'next turn',
    };
    const result: Result<void, IntelligenceError> = runtime.accept(submission);
    expect(result.ok).toBe(true);
    expect(controlled.sinks.has(submission.id)).toBe(true);
  });

  it('contains synchronous provider start throws and permits same-runtime retry', () => {
    const siblingId = activityId('sibling');
    const failedId = activityId('failed');
    const spareId = activityId('spare');
    const failedSession = { providerId: 'test.provider', id: 'failed-session' };
    const ids = [siblingId, failedId, spareId, failedId];
    const sinks = new Map<ActivityId, ActivitySink>();
    const starts = new Map<ActivityId, number>();
    let throwOnFailedStart = true;
    let cancelCalls = 0;
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'test.provider',
      start(submission, sink) {
        starts.set(submission.id, (starts.get(submission.id) ?? 0) + 1);
        if (submission.id === failedId && throwOnFailedStart) {
          throw new Error('sentinel provider start failure');
        }
        sinks.set(submission.id, sink);
        return ok(undefined);
      },
      cancel() {
        cancelCalls += 1;
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 2 },
      createActivityId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('test activity identity exhausted');
        return id;
      },
    });

    const sibling = runtime.submit({ input: 'sibling' });
    expect(sibling.ok).toBe(true);
    if (!sibling.ok) return;
    const siblingSink = sinks.get(sibling.value.id);
    expect(siblingSink).toBeDefined();
    siblingSink?.text('sibling');
    expect(runtime.poll()).toEqual([
      { type: 'text-delta', activityId: siblingId, sequence: 1, text: 'sibling' },
    ]);

    let refused: ReturnType<typeof runtime.submit> | undefined;
    let rawThrow: unknown;
    try {
      refused = runtime.submit({ input: 'throw', session: failedSession });
    } catch (error) {
      rawThrow = error;
    }
    expect(rawThrow).toBeUndefined();
    expect(refused?.ok).toBe(false);
    if (refused === undefined || refused.ok) return;
    expect(refused.error.code).toBe('intelligence-provider-failed');
    if (refused.error.code === 'intelligence-provider-failed') {
      expect(refused.error.detail.providerId).toBe(provider.id);
      expect(refused.error.detail.cause).toBeInstanceOf(Error);
      expect(refused.error.message).not.toContain('sentinel provider start failure');
      expect(refused.error.hint).not.toContain('sentinel provider start failure');
    }
    expect(runtime.poll()).toEqual([]);
    expect(sinks.has(failedId)).toBe(false);
    expect(cancelCalls).toBe(0);
    expect(closeCalls).toBe(0);

    const spare = runtime.submit({ input: 'spare' });
    expect(spare.ok).toBe(true);
    if (!spare.ok) return;
    sinks.get(spare.value.id)?.complete('spare');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: spareId,
        sequence: 1,
        session: spare.value.session,
        output: 'spare',
      },
    ]);

    throwOnFailedStart = false;
    const retry = runtime.submit({ input: 'retry', session: failedSession });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.id).toBe(failedId);
    expect(retry.value.session).toBe(failedSession);
    siblingSink?.complete('sibling-done');
    sinks.get(retry.value.id)?.complete('retry-done');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: siblingId,
        sequence: 2,
        session: sibling.value.session,
        output: 'sibling-done',
      },
      {
        type: 'completed',
        activityId: failedId,
        sequence: 1,
        session: failedSession,
        output: 'retry-done',
      },
    ]);
    expect(runtime.poll()).toEqual([]);
    expect(starts.get(siblingId)).toBe(1);
    expect(starts.get(failedId)).toBe(2);
    expect(starts.get(spareId)).toBe(1);
    expect(cancelCalls).toBe(0);

    const close = runtime.close();
    expect(close).toBe(runtime.close());
    return close.then(() => {
      expect(closeCalls).toBe(1);
      expect(runtime.poll()).toEqual([]);
    });
  });

  it('contains synchronous provider cancel throws and preserves the same Activity for retry', () => {
    const siblingId = activityId('cancel-sibling');
    const failedId = activityId('cancel-failed');
    const spareId = activityId('cancel-spare');
    const failedSession = { providerId: 'cancel.throw.provider', id: 'failed-session' };
    const ids = [siblingId, failedId, spareId];
    const sinks = new Map<ActivityId, ActivitySink>();
    const starts = new Map<ActivityId, number>();
    const cancelCalls: ActivityId[] = [];
    const sentinel = new Error('sentinel provider cancel failure');
    let throwOnFailedCancel = true;
    const provider: IntelligenceProvider = {
      id: 'cancel.throw.provider',
      start(submission, sink) {
        starts.set(submission.id, (starts.get(submission.id) ?? 0) + 1);
        sinks.set(submission.id, sink);
        return ok(undefined);
      },
      cancel(activity) {
        cancelCalls.push(activity);
        if (activity === failedId && throwOnFailedCancel) throw sentinel;
        const sink = sinks.get(activity);
        if (sink === undefined) {
          return err(
            new IntelligenceError({
              code: 'intelligence-activity-not-found',
              detail: { activityId: activity },
            }),
          );
        }
        sinks.delete(activity);
        sink.cancelled();
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 2 },
      createActivityId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('test activity identity exhausted');
        return id;
      },
    });

    const sibling = runtime.submit({ input: 'sibling' });
    const failed = runtime.submit({ input: 'cancel', session: failedSession });
    expect(sibling.ok).toBe(true);
    expect(failed.ok).toBe(true);
    if (!sibling.ok || !failed.ok) return;
    expect(runtime.poll()).toEqual([]);

    let rawThrow: unknown;
    let refused: ReturnType<typeof runtime.cancel> | undefined;
    try {
      refused = runtime.cancel(failed.value.id);
    } catch (error) {
      rawThrow = error;
    }
    expect(rawThrow).toBeUndefined();
    expect(refused?.ok).toBe(false);
    if (refused === undefined || refused.ok) return;
    expect(refused.error.code).toBe('intelligence-provider-failed');
    if (refused.error.code === 'intelligence-provider-failed') {
      expect(refused.error.detail.providerId).toBe(provider.id);
      expect(refused.error.detail.cause).toBe(sentinel);
      expect(refused.error.message).not.toContain(sentinel.message);
      expect(refused.error.hint).not.toContain(sentinel.message);
    }
    expect(cancelCalls).toEqual([failedId]);
    expect(runtime.poll()).toEqual([]);

    const spare = runtime.submit({ input: 'spare' });
    expect(spare.ok).toBe(false);
    if (!spare.ok) expect(spare.error.code).toBe('intelligence-capacity-exceeded');
    expect(starts.has(spareId)).toBe(false);

    const siblingSink = sinks.get(sibling.value.id);
    expect(siblingSink).toBeDefined();
    siblingSink?.text('healthy');
    expect(runtime.poll()).toEqual([
      { type: 'text-delta', activityId: siblingId, sequence: 1, text: 'healthy' },
    ]);

    throwOnFailedCancel = false;
    const retried = runtime.cancel(failed.value.id);
    expect(retried.ok).toBe(true);
    expect(cancelCalls).toEqual([failedId, failedId]);
    expect(runtime.poll()).toEqual([{ type: 'cancelled', activityId: failedId, sequence: 1 }]);
    const afterCancel = runtime.cancel(failed.value.id);
    expect(afterCancel.ok).toBe(false);
    if (!afterCancel.ok) expect(afterCancel.error.code).toBe('intelligence-activity-not-found');

    siblingSink?.complete('healthy-done');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: siblingId,
        sequence: 2,
        session: sibling.value.session,
        output: 'healthy-done',
      },
    ]);
    expect(starts.get(siblingId)).toBe(1);
    expect(starts.get(failedId)).toBe(1);
  });

  it('contains a throwing overflow cancellation and preserves provider Result errors', () => {
    const siblingId = activityId('overflow-sibling');
    const returnedId = activityId('returned-cancel-error');
    const overflowId = activityId('overflow-throw');
    const ids = [siblingId, returnedId, overflowId];
    const sinks = new Map<ActivityId, ActivitySink>();
    const cancelCalls: ActivityId[] = [];
    const overflowSentinel = new Error('sentinel overflow cancel failure');
    const returnedError = new IntelligenceError({
      code: 'intelligence-provider-failed',
      detail: { providerId: 'inner.provider', cause: 'provider returned error' },
    });
    const returnedResult = err(returnedError);
    const provider: IntelligenceProvider = {
      id: 'overflow.throw.provider',
      start(submission, sink) {
        sinks.set(submission.id, sink);
        return ok(undefined);
      },
      cancel(activity) {
        cancelCalls.push(activity);
        if (activity === returnedId) return returnedResult;
        if (activity === overflowId) throw overflowSentinel;
        const sink = sinks.get(activity);
        if (sink === undefined) {
          return err(
            new IntelligenceError({
              code: 'intelligence-activity-not-found',
              detail: { activityId: activity },
            }),
          );
        }
        sinks.delete(activity);
        sink.cancelled();
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxPendingEventsPerActivity: 2, maxConcurrentActivities: 3 },
      createActivityId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('test activity identity exhausted');
        return id;
      },
    });

    const sibling = runtime.submit({ input: 'sibling' });
    const returned = runtime.submit({ input: 'returned' });
    const overflow = runtime.submit({ input: 'overflow' });
    expect(sibling.ok).toBe(true);
    expect(returned.ok).toBe(true);
    expect(overflow.ok).toBe(true);
    if (!sibling.ok || !returned.ok || !overflow.ok) return;

    const returnedCancel = runtime.cancel(returned.value.id);
    expect(returnedCancel).toBe(returnedResult);
    expect(runtime.poll()).toEqual([]);
    sinks.get(returned.value.id)?.complete('returned-retry');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: returnedId,
        sequence: 1,
        session: returned.value.session,
        output: 'returned-retry',
      },
    ]);

    const overflowSink = sinks.get(overflow.value.id);
    expect(overflowSink).toBeDefined();
    overflowSink?.text('first');
    let rawThrow: unknown;
    try {
      overflowSink?.text('second');
    } catch (error) {
      rawThrow = error;
    }
    expect(rawThrow).toBeUndefined();
    const events = runtime.poll();
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'text-delta',
      activityId: overflowId,
      sequence: 1,
      text: 'first',
    });
    const overflowEvent = events[1];
    expect(overflowEvent?.type).toBe('failed');
    if (overflowEvent?.type === 'failed') {
      expect(overflowEvent.error.code).toBe('intelligence-output-overflow');
      if (overflowEvent.error.code === 'intelligence-output-overflow') {
        expect(overflowEvent.error.detail).toEqual({
          activityId: overflowId,
          bound: 'pending-events',
          limit: 2,
        });
      }
    }
    expect(cancelCalls).toEqual([returnedId, overflowId]);

    const siblingSink = sinks.get(sibling.value.id);
    siblingSink?.text('sibling-alive');
    expect(runtime.poll()).toEqual([
      { type: 'text-delta', activityId: siblingId, sequence: 1, text: 'sibling-alive' },
    ]);
    siblingSink?.complete('sibling-done');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: siblingId,
        sequence: 2,
        session: sibling.value.session,
        output: 'sibling-done',
      },
    ]);
  });

  it('releases overflow capacity and quarantines late provider output before a same-session retry', async () => {
    const overflowId = activityId('pending-overflow');
    const siblingId = activityId('healthy-sibling');
    const retryId = activityId('overflow-retry');
    const overflowSession = { providerId: 'overflow.recovery.provider', id: 'session-a' };
    const ids = [overflowId, siblingId, retryId];
    const sinks = new Map<ActivityId, ActivitySink>();
    const starts: Array<{ readonly id: ActivityId; readonly session: string }> = [];
    let overflowCancelCalls = 0;
    let lateDelta: (() => void) | undefined;
    let lateCompletion: (() => void) | undefined;
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'overflow.recovery.provider',
      start(submission, sink) {
        starts.push({ id: submission.id, session: submission.session.id });
        sinks.set(submission.id, sink);
        if (submission.input === 'overflow') {
          sink.text('one');
          sink.text('two');
          sink.text('three');
        }
        return ok(undefined);
      },
      cancel(activity) {
        if (activity === overflowId) {
          overflowCancelCalls += 1;
          const sink = sinks.get(activity);
          if (sink !== undefined) {
            sinks.delete(activity);
            lateDelta = () => sink.text('late');
            lateCompletion = () => sink.complete('late');
          }
          throw new Error('sentinel overflow cancel failure');
        }
        const sink = sinks.get(activity);
        if (sink === undefined) {
          return err(
            new IntelligenceError({
              code: 'intelligence-activity-not-found',
              detail: { activityId: activity },
            }),
          );
        }
        sinks.delete(activity);
        sink.cancelled();
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
        sinks.clear();
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 2, maxPendingEventsPerActivity: 3 },
      createActivityId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('test activity identity exhausted');
        return id;
      },
    });

    const overflow = runtime.submit({ input: 'overflow', session: overflowSession });
    const sibling = runtime.submit({ input: 'sibling' });
    expect(overflow.ok).toBe(true);
    expect(sibling.ok).toBe(true);
    if (!overflow.ok || !sibling.ok) return;

    const overflowEvents = runtime.poll();
    expect(overflowEvents).toHaveLength(3);
    expect(overflowEvents[0]).toEqual({
      type: 'text-delta',
      activityId: overflowId,
      sequence: 1,
      text: 'one',
    });
    expect(overflowEvents[1]).toEqual({
      type: 'text-delta',
      activityId: overflowId,
      sequence: 2,
      text: 'two',
    });
    const overflowEvent = overflowEvents[2];
    expect(overflowEvent?.type).toBe('failed');
    if (overflowEvent?.type === 'failed') {
      expect(overflowEvent.error.code).toBe('intelligence-output-overflow');
      if (overflowEvent.error.code === 'intelligence-output-overflow') {
        expect(overflowEvent.error.detail).toEqual({
          activityId: overflowId,
          bound: 'pending-events',
          limit: 3,
        });
      }
    }
    expect(overflowCancelCalls).toBe(1);

    const retry = runtime.submit({ input: 'retry', session: overflow.value.session });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.session).toEqual(overflow.value.session);
    lateDelta?.();
    lateCompletion?.();
    expect(runtime.poll()).toEqual([]);

    sinks.get(sibling.value.id)?.complete('healthy');
    sinks.get(retry.value.id)?.complete('retry');
    expect(runtime.poll()).toEqual([
      {
        type: 'completed',
        activityId: siblingId,
        sequence: 1,
        session: sibling.value.session,
        output: 'healthy',
      },
      {
        type: 'completed',
        activityId: retryId,
        sequence: 1,
        session: retry.value.session,
        output: 'retry',
      },
    ]);
    const close = runtime.close();
    expect(close).toBe(runtime.close());
    await close;
    expect(closeCalls).toBe(1);
    expect(starts).toEqual([
      { id: overflowId, session: overflowSession.id },
      { id: siblingId, session: sibling.value.session.id },
      { id: retryId, session: overflowSession.id },
    ]);
  });
});
