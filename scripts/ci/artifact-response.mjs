import { getDefaultHighWaterMark, Readable } from 'node:stream';
import { withinHttpDeadline } from '../lib/http-deadline.mjs';

export function withinArtifactDeadline(operation, controller, timeoutMs, kind) {
  return withinHttpDeadline(
    operation,
    controller,
    timeoutMs,
    `artifact ${kind} timeout after ${timeoutMs}ms`,
  );
}

export async function* readArtifactChunks(body, controller, idleTimeoutMs, kind) {
  const reader = body.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await withinArtifactDeadline(
        () => reader.read(),
        controller,
        idleTimeoutMs,
        kind,
      );
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) {
      controller?.abort();
      // Cancel releases pending reads synchronously. The transport can finish
      // its asynchronous cleanup after the file writer and reader have closed.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

export function artifactResponseStream(body, controller, idleTimeoutMs) {
  return Readable.from(readArtifactChunks(body, controller, idleTimeoutMs, 'transfer idle'), {
    objectMode: false,
    highWaterMark: getDefaultHighWaterMark(false),
  });
}
