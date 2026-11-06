import { performance } from 'node:perf_hooks';

export const modelingFilePhasePrefix = '[vitest-modeling-file-phase] ';

// Public Vitest module lifecycle only; this reporter owns no timers, workers or disposers.
export default class ModelingFilePhaseReporter {
  startedAt = performance.now();
  sequence = 0;

  emit(phase, module) {
    if (this.sequence >= 4096) return;
    const file = module?.relativeModuleId;
    if (
      file !== undefined &&
      (typeof file !== 'string' || /^(?:[/\\]|[A-Za-z]:)|\.\./.test(file))
    ) {
      return;
    }
    process.stderr.write(
      `${modelingFilePhasePrefix}${JSON.stringify({
        phase,
        file: file?.replaceAll('\\', '/').slice(0, 240) ?? null,
        elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
        pid: process.pid,
        pidRole: 'vitest-reporter',
        sequence: this.sequence++,
      })}\n`,
    );
  }

  onTestModuleQueued(module) {
    this.emit('queued', module);
  }

  onTestModuleCollected(module) {
    this.emit('collected', module);
  }

  onTestModuleStart(module) {
    this.emit('start', module);
  }

  onTestModuleEnd(module) {
    this.emit('end', module);
  }

  onTestRunEnd() {
    this.emit('run-end');
  }
}

// A separate parent prefix makes immediate evidence distinct from the unchanged close-time replay.
export function createModelingFilePhaseStream(progress) {
  let tail = Buffer.alloc(0);
  let stopped = false;
  let rows = 0;
  let truncated = false;
  return {
    collect(chunk) {
      if (stopped || rows >= 4096) return;
      const bytes = Buffer.concat([tail, chunk]);
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end).toString('utf8');
        start = end + 1;
        if (
          !truncated &&
          line.startsWith(modelingFilePhasePrefix) &&
          line.length <= 1024 &&
          rows < 4096
        ) {
          process.stderr.write(
            `[vitest-modeling-file-phase-live] ${JSON.stringify({
              groupIndex: progress.groupIndex,
              total: progress.total,
              label: progress.label.slice(0, 256),
              record: line.slice(modelingFilePhasePrefix.length),
            })}\n`,
          );
          rows += 1;
        }
        truncated = false;
      }
      // Oversized or unrelated lines never retain unbounded diagnostic scratch.
      const remaining = bytes.subarray(start);
      truncated ||= remaining.length > 1024;
      tail = Buffer.from(remaining.subarray(-1024));
    },
    stop() {
      stopped = true;
      tail = Buffer.alloc(0);
    },
  };
}
