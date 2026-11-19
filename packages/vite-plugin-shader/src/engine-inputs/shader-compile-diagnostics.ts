export interface ShaderCompileTiming {
  readonly preparationWallMs: number;
  readonly compileWallMs: number;
}

type Phase = 'preparing' | 'compiling';
interface ActiveJob {
  readonly id: number;
  readonly startedAt: number;
  phase: Phase;
  phaseStartedAt: number;
  parentPreparationWallMs: number;
  workerPreparationWallMs: number;
}

/** Optional observations of one existing source batch, never compiler admission. */
export class ShaderCompileDiagnostics {
  private readonly startedAt = performance.now();
  private readonly initialCpu = process.cpuUsage();
  private readonly active = new Map<number, ActiveJob>();
  private readonly timer: ReturnType<typeof setInterval>;
  private submitted = 0;
  private completed = 0;
  private preparationWallMs = 0;
  private compileWallMs = 0;
  private closed = false;
  private unavailableReported = false;

  constructor(
    private readonly family: string,
    private readonly total: number,
  ) {
    this.record('start');
    this.timer = setInterval(() => this.record('progress'), 30_000);
    try {
      this.timer.unref();
    } catch (error) {
      clearInterval(this.timer);
      throw error;
    }
  }

  start(id: number): void {
    const now = performance.now();
    this.submitted++;
    this.active.set(id, {
      id,
      startedAt: now,
      phase: 'preparing',
      phaseStartedAt: now,
      parentPreparationWallMs: 0,
      workerPreparationWallMs: 0,
    });
  }

  prepared(id: number, wallMs: number): void {
    const job = this.active.get(id);
    if (job !== undefined) job.parentPreparationWallMs = wallMs;
  }

  phase(id: number, phase: Phase, preparationWallMs = 0): void {
    const job = this.active.get(id);
    if (job === undefined) return;
    job.phase = phase;
    job.phaseStartedAt = performance.now();
    job.workerPreparationWallMs = preparationWallMs;
  }

  complete(id: number, timing?: ShaderCompileTiming): void {
    const job = this.active.get(id);
    if (job === undefined) return;
    this.completed++;
    this.preparationWallMs +=
      job.parentPreparationWallMs + (timing?.preparationWallMs ?? job.workerPreparationWallMs);
    this.compileWallMs += timing?.compileWallMs ?? 0;
    this.active.delete(id);
  }

  finish(outcome: 'end' | 'error'): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.record(outcome);
  }

  private record(event: 'start' | 'progress' | 'end' | 'error'): void {
    try {
      const now = performance.now();
      const cpu = process.cpuUsage(this.initialCpu);
      const memory = process.memoryUsage();
      process.stderr.write(
        `[shader-compile-diagnostics] ${JSON.stringify({
          event,
          family: this.family,
          total: this.total,
          submitted: this.submitted,
          completed: this.completed,
          active: [...this.active.values()].map((job) => ({
            id: job.id,
            phase: job.phase,
            wallMs: now - job.startedAt,
            phaseWallMs: now - job.phaseStartedAt,
            preparationWallMs: job.parentPreparationWallMs + job.workerPreparationWallMs,
          })),
          wallMs: now - this.startedAt,
          preparationWallMs: this.preparationWallMs,
          compileWallMs: this.compileWallMs,
          processCpuScope: 'entire-process-including-workers',
          memoryScope: 'rss-entire-process-heap-parent-isolate',
          processCpuUserMs: cpu.user / 1000,
          processCpuSystemMs: cpu.system / 1000,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          rssBytes: memory.rss,
        })}\n`,
      );
    } catch {
      if (!this.unavailableReported) {
        this.unavailableReported = true;
        reportUnavailableDiagnostics(this.family, this.total);
      }
    }
  }
}

export function shaderCompileDiagnostics(
  family: string,
  total: number,
): ShaderCompileDiagnostics | undefined {
  if (process.env.FORGEAX_SHADER_COMPILE_DIAGNOSTICS !== '1') return undefined;
  try {
    return new ShaderCompileDiagnostics(family, total);
  } catch {
    reportUnavailableDiagnostics(family, total);
    return undefined;
  }
}

function reportUnavailableDiagnostics(family: string, total: number): void {
  try {
    process.stderr.write(
      `[shader-compile-diagnostics] ${JSON.stringify({
        event: 'unavailable',
        family: family.slice(0, 256),
        total,
        reason: 'observation-unavailable',
      })}\n`,
    );
  } catch {
    // Optional observations never replace compilation or native teardown results.
  }
}
