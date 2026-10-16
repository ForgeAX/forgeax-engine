import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityEvent,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M28_PROVIDER_ID = 'm28.host.close-rejection';

export interface M28ProviderTrace {
  readonly starts: Array<{ readonly activityId: string; readonly input: string }>;
  readonly lateCallbackAttempts: number;
  readonly eventsObservedDuringClose: readonly ActivityEvent[];
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

interface M28ProviderOptions {
  readonly onCloseAttempt: () => void;
}

export interface M28RejectingProvider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M28ProviderTrace;
  attachPoll(poll: () => readonly ActivityEvent[]): void;
}

export function createM28RejectingProvider(
  options: M28ProviderOptions,
): M28RejectingProvider {
  const activities = new Map<ActivityId, PendingActivity>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let pollDuringClose: (() => readonly ActivityEvent[]) | undefined;
  let lateCallbackAttempts = 0;
  let eventsObservedDuringClose: readonly ActivityEvent[] = [];
  let startCalls = 0;
  let closeCalls = 0;
  let activeCountAtClose: number | null = null;
  const trace: M28ProviderTrace = {
    starts: [],
    get lateCallbackAttempts() {
      return lateCallbackAttempts;
    },
    get eventsObservedDuringClose() {
      return eventsObservedDuringClose;
    },
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

  const provider: M28RejectingProvider = {
    id: M28_PROVIDER_ID,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      startCalls += 1;
      trace.starts.push({ activityId: String(submission.id), input: submission.input });
      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (submission.input === 'terminal') {
        schedule(() => {
          if (activities.get(activity.id) !== activity) return;
          activity.sink.text('pending:');
        }, 20);
        schedule(() => {
          if (activities.get(activity.id) !== activity) return;
          activities.delete(activity.id);
          activity.sink.complete('terminal-ok');
        }, 60);
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
      options.onCloseAttempt();
      for (const activity of activities.values()) {
        lateCallbackAttempts += 1;
        activity.sink.text('late-after-close');
        activity.sink.complete('late-after-close');
      }
      eventsObservedDuringClose = pollDuringClose?.() ?? [];
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      activities.clear();
      throw new Error('sentinel M28 Host provider close rejection');
    },
    attachPoll(poll) {
      pollDuringClose = poll;
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
