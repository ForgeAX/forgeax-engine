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
  readonly task: Promise<void>;
}

/** Adapt one ready DSH realm bridge to the provider-neutral AI Native Activity contract. */
export function createDshRealmIntelligenceProvider(
  connection: DshRealmConnection,
): IntelligenceProvider {
  const running = new Map<ActivityId, RunningActivity>();
  let closeTask: Promise<void> | undefined;

  return {
    id: 'deepseek-harness-federated',
    start(submission, sink) {
      if (closeTask !== undefined) {
        return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
      }
      const controller = new AbortController();
      const task = Promise.resolve().then(() => run(submission, sink, controller));
      running.set(submission.id, { controller, task });
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
    close() {
      if (closeTask !== undefined) return closeTask;
      const current = [...running.values()];
      closeTask = Promise.allSettled(current.map((activity) => activity.task)).then(
        () => undefined,
      );
      for (const activity of current) activity.controller.abort();
      return closeTask;
    },
  };

  async function run(
    submission: ActivitySubmission,
    sink: ActivitySink,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (controller.signal.aborted) {
        sink.cancelled();
        return;
      }
      const result = await connection.activity(
        submission.input,
        submission.session.id,
        controller.signal,
      );
      if (!controller.signal.aborted) sink.text(result.output);
      if (controller.signal.aborted) sink.cancelled();
      else sink.complete(result.output);
    } catch (error) {
      if (controller.signal.aborted) sink.cancelled();
      else sink.fail(error);
    } finally {
      if (running.get(submission.id)?.controller === controller) running.delete(submission.id);
    }
  }
}
