import { err, ok, type Result } from '@forgeax/engine-types';
import {
  IntelligenceError,
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  type IntelligenceError as IntelligenceErrorType,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';

export const M27_PROVIDER_ID = 'm27.host.deterministic';

export interface M27ProviderTrace {
  readonly starts: Array<{
    readonly activityId: string;
    readonly input: string;
    readonly sessionId: string;
    readonly attempt: number;
  }>;
  readonly invalidStartInputs: string[];
  readonly cancels: Array<{ readonly activityId: string; readonly input: string }>;
  startCalls: number;
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

export interface M27DeterministicProvider extends IntelligenceProvider {
  readonly activeCount: number;
  readonly closed: boolean;
  readonly trace: M27ProviderTrace;
}

export function createM27DeterministicProvider(): M27DeterministicProvider {
  const activities = new Map<ActivityId, PendingActivity>();
  const startAttempts = new Map<string, number>();
  const tasks = new Set<ScheduledTask>();
  let closed = false;
  const trace: M27ProviderTrace = {
    starts: [],
    invalidStartInputs: [],
    cancels: [],
    startCalls: 0,
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

  const provider: M27DeterministicProvider = {
    id: M27_PROVIDER_ID,
    start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceErrorType> {
      trace.startCalls += 1;
      const key = `${submission.input}:${submission.session.id}`;
      const attempt = (startAttempts.get(key) ?? 0) + 1;
      startAttempts.set(key, attempt);
      trace.starts.push({
        activityId: String(submission.id),
        input: submission.input,
        sessionId: submission.session.id,
        attempt,
      });

      if (submission.input.length === 0 || submission.input.length > 4) {
        trace.invalidStartInputs.push(submission.input);
        sink.fail(new Error('M27 invalid input reached the Host provider'));
        return ok(undefined);
      }

      const activity: PendingActivity = { id: submission.id, input: submission.input, sink };
      activities.set(activity.id, activity);
      if (submission.input === 'abcd') {
        schedule(() => finish(activity, 'abcd'), 60);
      } else if (submission.input === 'sib') {
        schedule(() => emitDelta(activity, 's:'), 25);
        schedule(() => finish(activity, 'sibling-ok'), 100);
      } else if (submission.input === 'rtry') {
        schedule(() => finish(activity, 'retry-ok'), 70);
      } else {
        schedule(() => finish(activity, 'unexpected-valid-input'), 100);
      }
      return ok(undefined);
    },
    cancel(id: ActivityId): Result<void, IntelligenceErrorType> {
      const activity = activities.get(id);
      if (activity === undefined) return failNotFound(id);
      activities.delete(id);
      trace.cancels.push({ activityId: String(id), input: activity.input });
      activity.sink.cancelled();
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
