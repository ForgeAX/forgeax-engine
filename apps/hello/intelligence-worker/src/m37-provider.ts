import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M37_PROVIDER_A_ID = 'm37.host.control';
export const M37_PROVIDER_B_ID = 'm37.host.cancel-target';
export const M37_PROVIDER_C_ID = M37_PROVIDER_B_ID;
export const M37_LIMITS = {
  maxInputChars: 64,
  maxOutputChars: 128,
  maxConcurrentActivities: 2,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 1,
} as const;

export interface M37ProviderTrace {
  readonly id: string;
  readonly starts: Array<{ readonly activityId: string; readonly input: string }>;
  readonly emissions: Array<{
    readonly activityId: string;
    readonly input: string;
    readonly event: string;
  }>;
  readonly startCalls: number;
  readonly cancelCalls: number;
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

export interface M37Provider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M37ProviderTrace;
  readonly waitForLateCallbacks: () => Promise<void>;
}

export function createM37Provider(id: string): M37Provider {
  const activities = new Map<ActivityId, PendingActivity>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const lateProvider = id === M37_PROVIDER_B_ID;
  let closed = false;
  let startCalls = 0;
  let cancelCalls = 0;
  let closeCalls = 0;
  let activeCountAtClose: number | null = null;
  let lateCallbackAttempts = 0;
  let resolveLateCallbacks: (() => void) | undefined;
  const lateCallbacksDone = lateProvider
    ? new Promise<void>((resolve) => {
        resolveLateCallbacks = resolve;
      })
    : Promise.resolve();
  const trace: M37ProviderTrace = {
    id,
    starts: [],
    emissions: [],
    get startCalls() {
      return startCalls;
    },
    get cancelCalls() {
      return cancelCalls;
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
    err(new IntelligenceError({ code: 'intelligence-activity-not-found', detail: { activityId } }));

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

  const provider: M37Provider = {
    id,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      startCalls += 1;
      trace.starts.push({ activityId: String(submission.id), input: submission.input });
      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (id === M37_PROVIDER_A_ID && submission.input === 'control') {
        scheduleWhileOpen(activity, 'text', 15, () => activity.sink.text('control:'));
        scheduleWhileOpen(activity, 'terminal', 210, () => {
          activities.delete(activity.id);
          activity.sink.complete('control-ok');
        });
      } else if (id === M37_PROVIDER_B_ID && submission.input === 'cancel-target') {
        recordEmission(activity, 'staged-text');
        activity.sink.text('target:');
        scheduleLate(activity, 'late-text', 45, () => activity.sink.text('late-provider:'));
        scheduleLate(activity, 'late-terminal', 90, () => activity.sink.complete('late-provider-ok'));
      } else if (id === M37_PROVIDER_C_ID && submission.input === 'fresh') {
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
      cancelCalls += 1;
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
      if (!lateProvider) {
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
