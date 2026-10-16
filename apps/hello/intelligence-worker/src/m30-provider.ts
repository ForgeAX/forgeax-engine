import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M30_PROVIDER_A_ID = 'm30.host.provider-a';
export const M30_PROVIDER_B_ID = 'm30.host.provider-b';
export const M30_LIMITS = {
  maxInputChars: 64,
  maxOutputChars: 128,
  maxConcurrentActivities: 1,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 8,
} as const;

export interface M30ProviderTrace {
  readonly id: string;
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

export interface M30Provider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M30ProviderTrace;
}

export function createM30Provider(id: string): M30Provider {
  const activities = new Map<ActivityId, PendingActivity>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let startCalls = 0;
  let closeCalls = 0;
  let activeCountAtClose: number | null = null;
  const trace: M30ProviderTrace = {
    id,
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

  const failNotFound = (activityId: ActivityId): Result<void, IntelligenceErrorType> =>
    err(
      new IntelligenceError({
        code: 'intelligence-activity-not-found',
        detail: { activityId },
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

  const provider: M30Provider = {
    id,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      startCalls += 1;
      trace.starts.push({ activityId: String(submission.id), input: submission.input });
      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (submission.input === 'a-first') {
        schedule(activity, 'text', 15, () => activity.sink.text('a:'));
        schedule(activity, 'terminal', 55, () => {
          activities.delete(activity.id);
          activity.sink.complete('a-first-ok');
        });
      } else if (submission.input === 'a-retry') {
        schedule(activity, 'terminal', 20, () => {
          activities.delete(activity.id);
          activity.sink.complete('a-retry-ok');
        });
      } else if (submission.input === 'b-valid') {
        schedule(activity, 'text', 15, () => activity.sink.text('b:'));
        schedule(activity, 'terminal', 50, () => {
          activities.delete(activity.id);
          activity.sink.complete('b-valid-ok');
        });
      } else {
        schedule(activity, 'unexpected-terminal', 20, () => {
          activities.delete(activity.id);
          activity.sink.complete('unexpected-ok');
        });
      }
      return ok(undefined);
    },
    cancel(activityId: ActivityId): Result<void, IntelligenceErrorType> {
      const activity = activities.get(activityId);
      if (activity === undefined) return failNotFound(activityId);
      activities.delete(activityId);
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
