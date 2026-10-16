import type {
  ActivityId,
  ActivitySink,
  ActivitySubmission,
  IntelligenceError,
  IntelligenceProvider,
} from '@forgeax/engine-intelligence';
import { IntelligenceError as IntelligenceErrorValue } from '@forgeax/engine-intelligence';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface FakeActivityScript {
  readonly deltas: readonly string[];
  readonly output?: string;
  readonly failure?: unknown;
}

export interface FakeIntelligenceProviderOptions {
  readonly id?: string;
  readonly script?: (submission: ActivitySubmission) => FakeActivityScript;
}

interface PendingFakeActivity {
  readonly id: ActivityId;
  readonly sink: ActivitySink;
  readonly script: FakeActivityScript;
  index: number;
}

export interface FakeIntelligenceProvider extends IntelligenceProvider {
  /** Advance every active Activity by one deterministic stream event. */
  advance(): void;
  readonly activeCount: number;
  readonly closed: boolean;
}

export function createFakeIntelligenceProvider(
  options: FakeIntelligenceProviderOptions = {},
): FakeIntelligenceProvider {
  const providerId = options.id ?? 'forgeax.fake';
  const activities = new Map<ActivityId, PendingFakeActivity>();
  let closed = false;
  const provider: FakeIntelligenceProvider = {
    id: providerId,
    start(submission, sink): Result<void, IntelligenceError> {
      if (closed) {
        return err(new IntelligenceErrorValue({ code: 'intelligence-closed', detail: {} }));
      }
      const script = options.script?.(submission) ?? {
        deltas: [`${submission.input}:`, 'ok'],
        output: `${submission.input}:ok`,
      };
      activities.set(submission.id, { id: submission.id, sink, script, index: 0 });
      return ok(undefined);
    },
    cancel(id): Result<void, IntelligenceError> {
      const activity = activities.get(id);
      if (activity === undefined) {
        return err(
          new IntelligenceErrorValue({
            code: 'intelligence-activity-not-found',
            detail: { activityId: id },
          }),
        );
      }
      activities.delete(id);
      activity.sink.cancelled();
      return ok(undefined);
    },
    advance(): void {
      for (const [id, activity] of activities) {
        const delta = activity.script.deltas[activity.index];
        if (delta !== undefined) {
          activity.index += 1;
          activity.sink.text(delta);
          continue;
        }
        activities.delete(id);
        if (activity.script.failure !== undefined) {
          activity.sink.fail(activity.script.failure);
        } else {
          activity.sink.complete(activity.script.output ?? activity.script.deltas.join(''));
        }
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const activity of activities.values()) activity.sink.cancelled();
      activities.clear();
    },
    get activeCount(): number {
      return activities.size;
    },
    get closed(): boolean {
      return closed;
    },
  };
  return provider;
}
