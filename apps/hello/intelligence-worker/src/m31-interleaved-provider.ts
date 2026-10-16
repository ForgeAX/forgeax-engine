import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M31_PROVIDER_ID = 'm31.host.interleaved';

export interface M31ProviderTrace {
  readonly starts: Array<{ readonly activityId: string; readonly input: string }>;
  readonly emissions: Array<{
    readonly activityId: string;
    readonly input: string;
    readonly event: string;
  }>;
  readonly startCalls: number;
  readonly closeCalls: number;
  readonly activeCountAtClose: number | null;
  readonly activeCount: number;
  readonly closed: boolean;
}

interface PendingActivity {
  readonly id: ActivityId;
  readonly input: string;
  readonly sink: ActivitySink;
}

export interface M31InterleavedProvider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M31ProviderTrace;
}

export function createM31InterleavedProvider(): M31InterleavedProvider {
  const activities = new Map<ActivityId, PendingActivity>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let startCalls = 0;
  let closeCalls = 0;
  let activeCountAtClose: number | null = null;
  const trace: M31ProviderTrace = {
    starts: [],
    emissions: [],
    get startCalls() {
      return startCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    get activeCountAtClose() {
      return activeCountAtClose;
    },
    get activeCount() {
      return activities.size;
    },
    get closed() {
      return closed;
    },
  };

  const failNotFound = (id: ActivityId): Result<void, IntelligenceErrorType> =>
    err(
      new IntelligenceError({
        code: 'intelligence-activity-not-found',
        detail: { activityId: id },
      }),
    );

  const schedule = (
    activity: PendingActivity,
    event: string,
    delayMs: number,
    callback: () => void,
  ): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed || activities.get(activity.id) !== activity) return;
      trace.emissions.push({
        activityId: String(activity.id),
        input: activity.input,
        event,
      });
      callback();
    }, delayMs);
    timers.add(timer);
  };

  const provider: M31InterleavedProvider = {
    id: M31_PROVIDER_ID,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      startCalls += 1;
      trace.starts.push({ activityId: String(submission.id), input: submission.input });
      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (submission.input === 'first') {
        schedule(activity, 'text-1', 20, () => activity.sink.text('first-1'));
        schedule(activity, 'text-2', 55, () => activity.sink.text('first-2'));
        schedule(activity, 'terminal', 150, () => {
          activities.delete(activity.id);
          activity.sink.complete('first-ok');
        });
      } else if (submission.input === 'second') {
        schedule(activity, 'text-1', 35, () => activity.sink.text('second-1'));
        schedule(activity, 'text-2', 70, () => activity.sink.text('second-2'));
        schedule(activity, 'terminal', 115, () => {
          activities.delete(activity.id);
          activity.sink.complete('second-ok');
        });
      } else if (submission.input === 'after terminal') {
        schedule(activity, 'terminal', 20, () => {
          activities.delete(activity.id);
          activity.sink.complete('after-ok');
        });
      }
      return ok(undefined);
    },
    cancel(id: ActivityId): Result<void, IntelligenceErrorType> {
      const activity = activities.get(id);
      if (activity === undefined) return failNotFound(id);
      activities.delete(id);
      activity.sink.cancelled();
      return ok(undefined);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closeCalls += 1;
      activeCountAtClose = activities.size;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      activities.clear();
    },
    trace,
    get activeCount() {
      return activities.size;
    },
    get closed() {
      return closed;
    },
  };
  return provider;
}
