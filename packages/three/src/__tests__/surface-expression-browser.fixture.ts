import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, replayChecks } from './render.fixture';
import { verifySurfaceExpression } from './surface-expression.fixture';
import { surfaceExpressionReference } from './surface-expression-reference.fixture';

export function registerSurfaceExpressionBrowserCase(kind: 'standard' | 'unlit' | 'roughness') {
  it(`submits ${kind} expression recipes for sixty completed Chromium frames and dynamic updates`, {
    timeout: 120_000,
  }, async () => {
    const started = performance.now();
    const record = (phase: string) => {
      // biome-ignore lint/suspicious/noConsole: Retain phase timings under the original case deadline.
      console.info(
        '[three-surface-expression]',
        JSON.stringify({
          kind,
          phase,
          elapsedMs: performance.now() - started,
        }),
      );
    };
    record('cook-start');
    const publication = commands.prepareThreeSurfaceExpression(kind).then((cooked) => {
      record('cook-complete');
      return cooked;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const renderer = new WebGPURenderer({
      canvas,
      forgeax: { materialPrograms: publication.then(({ publications }) => publications) },
    });
    const replays = replayChecks();
    const evidenceJobs: Promise<void>[] = [];
    const failures: unknown[] = [];
    let referenceQueue = Promise.resolve();
    try {
      await verifySurfaceExpression(
        renderer,
        await publication,
        kind,
        async (name, capture) => {
          record(`captured:${name}`);
          // A file owns one native Three reference device. Keep its renders serial
          // while the Engine renders the next phase on its own device.
          const evidence = referenceQueue.then(async () => {
            const reference = await surfaceExpressionReference(kind, name);
            await saveBrowserEvidence(`surface-expression-${name}`, capture, reference);
            if (kind !== 'standard') comparePixels(displayPixels(capture), reference);
            record(`evidence:${name}`);
          });
          evidenceJobs.push(evidence);
          referenceQueue = evidence.catch(() => {});
        },
        replays.queue,
        kind === 'unlit',
      ).catch((cause: unknown) => {
        failures.push(cause);
      });
      const evidenceResults = await Promise.allSettled([...evidenceJobs, replays.complete()]);
      for (const result of evidenceResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      if (failures.length !== 0)
        throw new AggregateError(failures, 'Three surface expression verification failed');
    } finally {
      await renderer.dispose();
      canvas.remove();
    }
  });
}
