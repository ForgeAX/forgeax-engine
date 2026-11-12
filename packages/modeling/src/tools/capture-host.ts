import { Worker } from 'node:worker_threads';
import { type CaptureRequest, type CaptureResponse, captureHeapFailure } from './protocol';

process.once('disconnect', () => process.exit(0));
process.once('message', (input: { request: CaptureRequest; heapMb: number }) => {
  const capture = new Worker(new URL('./capture-worker.mjs', import.meta.url), {
    workerData: input.request,
    resourceLimits: { maxOldGenerationSizeMb: input.heapMb },
  });
  let settled = false;
  const finish = (response: CaptureResponse) => {
    if (settled) return;
    settled = true;
    void capture.terminate();
    if (process.connected) process.send?.(response);
  };
  capture.once('message', finish);
  capture.once('error', (error: Error & { code?: string }) =>
    finish(
      error.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? captureHeapFailure(input.heapMb)
        : {
            ok: false,
            error: {
              code: 'model-capture-failed',
              expected: 'the capture Worker completes',
              hint: 'inspect detail',
              detail: String(error),
            },
          },
    ),
  );
  capture.once('exit', (code) =>
    finish({
      ok: false,
      error: {
        code: 'model-capture-failed',
        expected: 'the capture Worker reports a result before exiting',
        hint: 'the Pack or selector ended the Worker early (for example process.exit)',
        detail: { exitCode: code },
      },
    }),
  );
});
