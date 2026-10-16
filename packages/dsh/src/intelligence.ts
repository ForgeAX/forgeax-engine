import {
  type ActivityId,
  type ActivitySink,
  type ActivitySubmission,
  IntelligenceError,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';
import { err, ok } from '@forgeax/engine-types';

import type { DshRealmConnection } from './engine-host';

interface RunningActivity {
  readonly controller: AbortController;
  readonly sink: ActivitySink;
  readonly task: Promise<void>;
}

/** Adapt one ready DSH realm bridge to the provider-neutral AI Native Activity contract. */
export function createDshRealmIntelligenceProvider(
  connection: DshRealmConnection,
): IntelligenceProvider {
  const running = new Map<ActivityId, RunningActivity>();
  let closed = false;

  return {
    id: 'deepseek-harness-federated',
    start(submission, sink) {
      if (closed) {
        return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
      }
      const controller = new AbortController();
      const task = run(submission, sink, controller);
      running.set(submission.id, { controller, sink, task });
      return ok(undefined);
    },
    cancel(id) {
      const activity = running.get(id);
      if (activity === undefined) {
        return err(
          new IntelligenceError({
            code: 'intelligence-activity-not-found',
            detail: { activityId: id },
          }),
        );
      }
      activity.controller.abort();
      return ok(undefined);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const activity of running.values()) activity.controller.abort();
      await Promise.allSettled([...running.values()].map((activity) => activity.task));
      running.clear();
    },
  };

  async function run(
    submission: ActivitySubmission,
    sink: ActivitySink,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await connection.activity(
        submission.input,
        submission.session.id,
        controller.signal,
      );
      sink.text(result.output);
      sink.complete(result.output);
    } catch (error) {
      if (controller.signal.aborted) sink.cancelled();
      else sink.fail(error);
    } finally {
      running.delete(submission.id);
    }
  }
}
