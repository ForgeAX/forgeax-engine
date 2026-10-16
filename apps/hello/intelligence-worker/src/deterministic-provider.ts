import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M26_PROVIDER_ID = 'm26.host.deterministic';

export interface M26ProviderTrace {
  readonly starts: Array<{
    readonly activityId: string;
    readonly input: string;
    readonly sessionId: string;
    readonly attempt: number;
  }>;
  readonly cancels: Array<{
    readonly activityId: string;
    readonly input: string;
    readonly attempt: number;
    readonly outcome: 'provider-throw' | 'cancelled';
  }>;
  readonly cancelFailures: Array<{
    readonly code: 'intelligence-provider-failed';
    readonly providerId: string;
    readonly cause: string;
  }>;
  startThrows: number;
  streamOutputAttempts: number;
  streamOutputReturned: boolean;
  completionOutputAttempts: number;
  completionOutputReturned: boolean;
  outputCancelThrows: number;
  lateDeltaAttempts: number;
  lateCompletionAttempts: number;
  closeCalls: number;
  activeCountAtClose: number | null;
}

interface PendingActivity {
  readonly id: ActivityId;
  readonly input: string;
  readonly sink: ActivitySink;
}

interface ScheduledTask {
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface M26DeterministicProvider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M26ProviderTrace;
}

export function createM26DeterministicProvider(): M26DeterministicProvider {
  const activities = new Map<ActivityId, PendingActivity>();
  const startAttempts = new Map<string, number>();
  const cancelAttempts = new Map<ActivityId, number>();
  const tasks = new Set<ScheduledTask>();
  let closed = false;
  const trace: M26ProviderTrace = {
    starts: [],
    cancels: [],
    cancelFailures: [],
    startThrows: 0,
    streamOutputAttempts: 0,
    streamOutputReturned: false,
    completionOutputAttempts: 0,
    completionOutputReturned: false,
    outputCancelThrows: 0,
    lateDeltaAttempts: 0,
    lateCompletionAttempts: 0,
    closeCalls: 0,
    activeCountAtClose: null,
  };

  const schedule = (callback: () => void, delayMs: number): void => {
    const task: ScheduledTask = {
      timer: setTimeout(() => {
        tasks.delete(task);
        if (!closed) callback();
      }, delayMs),
    };
    tasks.add(task);
  };

  const failNotFound = (id: ActivityId): Result<void, IntelligenceErrorType> =>
    err(
      new IntelligenceError({
        code: 'intelligence-activity-not-found',
        detail: { activityId: id },
      }),
    );

  const finish = (activity: PendingActivity, output: string): void => {
    if (activities.get(activity.id) !== activity) return;
    activities.delete(activity.id);
    activity.sink.complete(output);
  };

  const emitDelta = (activity: PendingActivity, text: string): void => {
    if (activities.get(activity.id) !== activity) return;
    activity.sink.text(text);
  };

  const recordCancelFailure = (cause: string): void => {
    trace.cancelFailures.push({
      code: 'intelligence-provider-failed',
      providerId: M26_PROVIDER_ID,
      cause,
    });
  };

  const scheduleLateOutput = (activity: PendingActivity): void => {
    schedule(() => {
      trace.lateDeltaAttempts += 1;
      activity.sink.text('late-after-overflow');
    }, 60);
    schedule(() => {
      trace.lateCompletionAttempts += 1;
      activity.sink.complete('late-after-overflow');
    }, 65);
  };

  const provider: M26DeterministicProvider = {
    id: M26_PROVIDER_ID,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      const key = `${submission.input}:${submission.session.id}`;
      const attempt = (startAttempts.get(key) ?? 0) + 1;
      startAttempts.set(key, attempt);
      trace.starts.push({
        activityId: String(submission.id),
        input: submission.input,
        sessionId: submission.session.id,
        attempt,
      });

      if (submission.input === 'start-fault' && attempt === 1) {
        trace.startThrows += 1;
        throw new Error('m26 sentinel provider start failure');
      }

      const activity: PendingActivity = {
        id: submission.id,
        input: submission.input,
        sink,
      };
      activities.set(activity.id, activity);

      if (submission.input === 'sibling') {
        schedule(() => emitDelta(activity, 'sib:'), 35);
        schedule(() => finish(activity, 'sib-ok'), 180);
      } else if (submission.input === 'start-fault') {
        schedule(() => emitDelta(activity, 'retry:'), 25);
        schedule(() => finish(activity, 'retry-ok'), 100);
      } else if (submission.input === 'late-cancel') {
        schedule(() => emitDelta(activity, 'pre:'), 35);
      } else if (submission.input === 'cancel-sibling') {
        schedule(() => emitDelta(activity, 'cs:'), 55);
        schedule(() => finish(activity, 'cs-ok'), 150);
      } else if (submission.input === 'fresh') {
        schedule(() => finish(activity, 'fresh-ok'), 65);
      } else if (submission.input === 'exact-limit') {
        schedule(() => finish(activity, '12345678'), 55);
      } else if (submission.input === 'output-sibling') {
        schedule(() => emitDelta(activity, 'sib:'), 50);
        schedule(() => finish(activity, 'sib-ok'), 140);
      } else if (submission.input === 'stream-output-overflow') {
        for (const text of '12345678') {
          trace.streamOutputAttempts += 1;
          sink.text(text);
        }
        trace.streamOutputAttempts += 1;
        sink.text('!');
        trace.streamOutputReturned = true;
      } else if (submission.input === 'completion-output-overflow') {
        trace.completionOutputAttempts += 1;
        sink.complete('123456789');
        trace.completionOutputReturned = true;
      } else if (submission.input === 'stream-output-retry') {
        schedule(() => finish(activity, 'retry-ok'), 65);
      }
      return ok(undefined);
    },
    cancel(id: ActivityId): Result<void, IntelligenceErrorType> {
      const activity = activities.get(id);
      if (activity === undefined) return failNotFound(id);
      const attempt = (cancelAttempts.get(id) ?? 0) + 1;
      cancelAttempts.set(id, attempt);

      if (activity.input === 'late-cancel' && attempt === 1) {
        trace.cancels.push({
          activityId: String(id),
          input: activity.input,
          attempt,
          outcome: 'provider-throw',
        });
        recordCancelFailure('m26 sentinel provider cancel failure');
        throw new Error('m26 sentinel provider cancel failure');
      }

      if (
        activity.input === 'stream-output-overflow' ||
        activity.input === 'completion-output-overflow'
      ) {
        trace.outputCancelThrows += 1;
        trace.cancels.push({
          activityId: String(id),
          input: activity.input,
          attempt,
          outcome: 'provider-throw',
        });
        recordCancelFailure('m26 sentinel output overflow cancel failure');
        activities.delete(id);
        scheduleLateOutput(activity);
        throw new Error('m26 sentinel output overflow cancel failure');
      }

      trace.cancels.push({
        activityId: String(id),
        input: activity.input,
        attempt,
        outcome: 'cancelled',
      });
      activities.delete(id);
      activity.sink.cancelled();
      if (activity.input === 'late-cancel') {
        schedule(() => {
          trace.lateDeltaAttempts += 1;
          activity.sink.text('late-after-cancel');
        }, 60);
        schedule(() => {
          trace.lateCompletionAttempts += 1;
          activity.sink.complete('late-after-cancel');
        }, 65);
      }
      return ok(undefined);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      trace.closeCalls += 1;
      trace.activeCountAtClose = activities.size;
      for (const activity of activities.values()) activity.sink.cancelled();
      activities.clear();
      for (const task of tasks) clearTimeout(task.timer);
      tasks.clear();
    },
    get activeCount(): number {
      return activities.size;
    },
    get closed(): boolean {
      return closed;
    },
    trace,
  };
  return provider;
}
