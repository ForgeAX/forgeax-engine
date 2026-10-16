import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M34_PROVIDER_A_ID = 'm34.host.survivor';
export const M34_PROVIDER_B_ID = 'm34.host.session';
// The fresh binding deliberately reuses the provider identity so the retained
// SessionRef crosses a new transport without becoming a provider mismatch.
export const M34_PROVIDER_C_ID = M34_PROVIDER_B_ID;
export const M34_LIMITS = {
  maxInputChars: 64,
  maxOutputChars: 128,
  maxConcurrentActivities: 2,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 1,
} as const;

export interface M34ProviderTrace {
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
  readonly lateCallbackAttempts: number;
}

interface PendingActivity {
  readonly id: ActivityId;
  readonly input: string;
  readonly sink: ActivitySink;
}

export interface M34Provider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M34ProviderTrace;
  readonly waitForLateCallbacks: () => Promise<void>;
}

export function createM34Provider(id: string): M34Provider {
  const activities = new Map<ActivityId, PendingActivity>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const isLateProvider = id === M34_PROVIDER_B_ID;
  let closed = false;
  let startCalls = 0;
  let closeCalls = 0;
  let activeCountAtClose: number | null = null;
  let lateCallbackAttempts = 0;
  let resolveLateCallbacks: (() => void) | undefined;
  const lateCallbacksDone = isLateProvider
    ? new Promise<void>((resolve) => {
        resolveLateCallbacks = resolve;
      })
    : Promise.resolve();
  const trace: M34ProviderTrace = {
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
    get lateCallbackAttempts() {
      return lateCallbackAttempts;
    },
  };

  const failNotFound = (activityId: ActivityId): Result<void, IntelligenceErrorType> =>
    err(
      new IntelligenceError({
        code: 'intelligence-activity-not-found',
        detail: { activityId },
      }),
    );

  const recordEmission = (activity: PendingActivity, event: string): void => {
    trace.emissions.push({
      activityId: String(activity.id),
      input: activity.input,
      event,
    });
  };

  const scheduleWhileOpen = (
    activity: PendingActivity,
    event: string,
    delayMs: number,
    callback: () => void,
  ): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed || activities.get(activity.id) !== activity) return;
      recordEmission(activity, event);
      callback();
    }, delayMs);
    timers.add(timer);
  };

  const scheduleLate = (
    activity: PendingActivity,
    event: string,
    delayMs: number,
    callback: () => void,
  ): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      lateCallbackAttempts += 1;
      recordEmission(activity, event);
      callback();
      if (lateCallbackAttempts === 2) resolveLateCallbacks?.();
    }, delayMs);
    timers.add(timer);
  };

  const provider: M34Provider = {
    id,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      startCalls += 1;
      trace.starts.push({ activityId: String(submission.id), input: submission.input });
      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (id === M34_PROVIDER_A_ID && submission.input === 'survivor') {
        scheduleWhileOpen(activity, 'text', 30, () => activity.sink.text('survivor:'));
        scheduleWhileOpen(activity, 'terminal', 180, () => {
          activities.delete(activity.id);
          activity.sink.complete('survivor-ok');
        });
      } else if (id === M34_PROVIDER_B_ID && submission.input === 'closing') {
        recordEmission(activity, 'text');
        activity.sink.text('closing:');
        scheduleLate(activity, 'late-text', 35, () => activity.sink.text('late-provider:'));
        scheduleLate(activity, 'late-terminal', 70, () => activity.sink.complete('late-provider-ok'));
      } else if (id === M34_PROVIDER_B_ID && submission.input === 'fresh') {
        scheduleWhileOpen(activity, 'text', 15, () => activity.sink.text('fresh:'));
        scheduleWhileOpen(activity, 'terminal', 55, () => {
          activities.delete(activity.id);
          activity.sink.complete('fresh-ok');
        });
      } else {
        scheduleWhileOpen(activity, 'unexpected-terminal', 20, () => {
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
      activities.clear();
      if (!isLateProvider) {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      }
    },
    trace,
    get activeCount() {
      return activities.size;
    },
    get closed() {
      return closed;
    },
    waitForLateCallbacks: () => lateCallbacksDone,
  };
  return provider;
}
