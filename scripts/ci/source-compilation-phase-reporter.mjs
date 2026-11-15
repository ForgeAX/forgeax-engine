import { performance } from 'node:perf_hooks';

export const sourceCompilationPhasePrefix = '[vitest-source-compilation-phase] ';

/** Observe public Vitest lifecycle without changing workers, deadlines or test results. */
export default class SourceCompilationPhaseReporter {
  startedAt = performance.now();
  sequence = 0;

  emit(phase, module, test) {
    if (this.sequence >= 4096) return;
    const file = module?.relativeModuleId;
    if (file !== undefined && (typeof file !== 'string' || /^(?:[/\\]|[A-Za-z]:)|\.\./.test(file)))
      return;
    process.stderr.write(
      `${sourceCompilationPhasePrefix}${JSON.stringify({
        phase,
        file: file?.replaceAll('\\', '/').slice(0, 240) ?? null,
        test: test?.fullName.slice(0, 240) ?? null,
        state: test?.result().state ?? null,
        elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
        pid: process.pid,
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
    this.emit('module-start', module);
  }
  onTestModuleEnd(module) {
    this.emit('module-end', module);
  }
  onTestCaseReady(test) {
    this.emit('case-start', test.module, test);
  }
  onTestCaseResult(test) {
    this.emit('case-end', test.module, test);
  }
  onTestRunEnd() {
    this.emit('run-end');
  }
}
