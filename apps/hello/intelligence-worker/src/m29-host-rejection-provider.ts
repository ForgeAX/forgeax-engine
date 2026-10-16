import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M29_PROVIDER_ID = 'm29.host.rejection';

export interface M29ProviderTrace {
  readonly starts: Array<{ readonly activityId: string; readonly input: string }>;
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

export interface M29HostRejectionProvider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M29ProviderTrace;
}

export function createM29HostRejectionProvider(): M29HostRejectionProvider {
  const activities = new Map<ActivityId, PendingActivity>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let startCalls = 0;
  let closeCalls = 0;
  let activeCountAtClose: number | null = null;
  const trace: M29ProviderTrace = {
    starts: [],
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

  const schedule = (callback: () => void, delayMs: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
  };

  const provider: M29HostRejectionProvider = {
    id: M29_PROVIDER_ID,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      startCalls += 1;
      trace.starts.push({ activityId: String(submission.id), input: submission.input });
      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (submission.input === 'keep-live') {
        schedule(() => {
          if (activities.get(activity.id) !== activity) return;
          activity.sink.text('keep:');
        }, 20);
        schedule(() => {
          if (activities.get(activity.id) !== activity) return;
          activities.delete(activity.id);
          activity.sink.complete('keep-ok');
        }, 70);
      } else if (submission.input === 'retry') {
        schedule(() => {
          if (activities.get(activity.id) !== activity) return;
          activities.delete(activity.id);
          activity.sink.complete('retry-ok');
        }, 20);
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
