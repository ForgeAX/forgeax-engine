/**
 * Always-on Render Worker frame-stall accounting for `frame-submitted`.
 *
 * One instance lives for the Render Worker realm and is mutated in place; a
 * frame costs a few `performance.now()` and counter reads and no allocation
 * beyond the submitted payload that already exists.
 *
 * Draw interval (start to start) decomposes exactly into
 *   previous turn (previous draw CPU + its post-submit tail)
 *   + await (this message arrived after the previous turn ended)
 *   + queued (the admitted message waited behind the serial drain).
 */

/** Largest contributor to a frame's Render Worker draw interval. */
export type RenderStallReason = 'render-cpu' | 'credit' | 'simulation' | 'publication' | 'queue';

/**
 * Pure attribution of one draw interval. The await is split, in order, into
 * the Engine Worker's publication-credit wait, its World update, and the rest
 * (Host admission, vsync and message transport). Ties keep the earlier reason.
 */
export function renderStallReason(
  previousTurnMs: number,
  awaitMs: number,
  queuedMs: number,
  engineCreditWaitMs: number,
  engineUpdateMs: number,
): RenderStallReason {
  const credit = Math.min(awaitMs, Math.max(0, engineCreditWaitMs));
  const simulation = Math.min(awaitMs - credit, Math.max(0, engineUpdateMs));
  const publication = awaitMs - credit - simulation;
  const largest = Math.max(previousTurnMs, credit, simulation, publication, queuedMs);
  if (previousTurnMs === largest) return 'render-cpu';
  if (credit === largest) return 'credit';
  if (simulation === largest) return 'simulation';
  if (publication === largest) return 'publication';
  return 'queue';
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export interface RenderDrawTimingSources {
  readonly now: () => number;
  readonly graphCompiles: () => number;
  readonly pipelineCreations: () => number;
}

interface DrawTimingMessage {
  readonly engineUpdateMs?: number;
  readonly engineCreditWaitMs?: number;
}

export class RenderDrawTiming {
  private readonly arrivals = new WeakMap<object, number>();
  private previousStartedAt: number | undefined;
  private previousEndedAt: number | undefined;
  private startedAt = 0;
  private graphCompilesAtStart = 0;
  private pipelineCreationsAtStart = 0;
  /** Start-to-start milliseconds; absent on the first draw. */
  intervalMs: number | undefined;
  awaitMs = 0;
  queuedMs = 0;
  stallReason: RenderStallReason | undefined;
  cpuMs = 0;
  graphCompiles = 0;
  pipelineCreations = 0;

  constructor(private readonly sources: RenderDrawTimingSources) {}

  /** Records when an admitted draw message reached the Render Worker. */
  arrive(message: object): void {
    this.arrivals.set(message, this.sources.now());
  }

  /** Opens a draw turn: interval, await, queue and stall attribution. */
  begin(message: object & DrawTimingMessage): void {
    const startedAt = this.sources.now();
    const arrivedAt = this.arrivals.get(message) ?? startedAt;
    const previousStartedAt = this.previousStartedAt;
    const previousEndedAt = this.previousEndedAt ?? arrivedAt;
    this.startedAt = startedAt;
    this.previousStartedAt = startedAt;
    this.intervalMs = previousStartedAt === undefined ? undefined : startedAt - previousStartedAt;
    this.awaitMs = roundMs(arrivedAt - previousEndedAt);
    this.queuedMs = roundMs(startedAt - Math.max(arrivedAt, previousEndedAt));
    this.stallReason =
      previousStartedAt === undefined
        ? undefined
        : renderStallReason(
            previousEndedAt - previousStartedAt,
            this.awaitMs,
            this.queuedMs,
            message.engineCreditWaitMs ?? 0,
            message.engineUpdateMs ?? 0,
          );
    this.graphCompilesAtStart = this.sources.graphCompiles();
    this.pipelineCreationsAtStart = this.sources.pipelineCreations();
  }

  /** Closes the CPU part of the turn at queue submission. */
  submit(): void {
    this.cpuMs = roundMs(this.sources.now() - this.startedAt);
    this.graphCompiles = this.sources.graphCompiles() - this.graphCompilesAtStart;
    this.pipelineCreations = this.sources.pipelineCreations() - this.pipelineCreationsAtStart;
  }

  /** Ends the whole draw turn, including its post-submit tail. */
  end(): void {
    this.previousEndedAt = this.sources.now();
  }
}
