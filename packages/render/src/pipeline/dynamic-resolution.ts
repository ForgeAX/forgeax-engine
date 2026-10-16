import type { DynamicResolutionData } from '../components/dynamic-resolution';
import type { GpuPassTimingFrame } from '../record/gpu-pass-timing/contract';
import { deriveRenderExtent, type RenderExtent } from './render-extent';

export interface DynamicResolutionInspection {
  readonly status: 'fixed' | 'warming' | 'adaptive' | 'unavailable';
  readonly targetGpuMs: number;
  readonly gpuMs: number | undefined;
  /** Dimensions of the last successful submit, never a pending graph. */
  readonly extent: RenderExtent | undefined;
}

/** Recover the full GPU interval, including gaps; a sum of pass costs is not a frame. */
export function gpuPassFrameMilliseconds(
  frame: GpuPassTimingFrame,
  viewId?: number,
): number | undefined {
  if (frame.droppedPassCount > 0 || frame.passes.length === 0) return;
  let first: bigint | undefined;
  let last: bigint | undefined;
  for (const pass of frame.passes) {
    if (viewId !== undefined && pass.viewId !== viewId) continue;
    if (pass.status !== 'measured') return;
    const begin = BigInt(pass.beginningTick);
    const end = BigInt(pass.endTick);
    if (end < begin) return;
    if (first === undefined || begin < first) first = begin;
    if (last === undefined || end > last) last = end;
  }
  return first === undefined || last === undefined
    ? undefined
    : (Number(last - first) * frame.timestampPeriodNanoseconds) / 1_000_000;
}

/** One bounded asynchronous feedback lane per Renderer; no World mutations or CPU clocks. */
export class DynamicResolutionController {
  #key = '';
  #owner: object | undefined;
  #revision = 0;
  #pending = false;
  #scale = 1;
  #headroomProbe:
    | {
        readonly scale: number;
        readonly gpuMs: number | undefined;
        readonly state: 'probing' | 'blocked';
      }
    | undefined;
  #parameters: DynamicResolutionData | undefined;
  #gpuMs: number | undefined;
  #windowMinimumMs: number | undefined;
  #windowMaximumMs = 0;
  #windowSecondMaximumMs = 0;
  #samples = 0;
  #budgetOverruns = 0;
  #status: DynamicResolutionInspection['status'] = 'warming';
  #extent: RenderExtent | undefined;
  #rasterRows: number | undefined;

  configure(
    parameters: DynamicResolutionData | undefined,
    owner: object,
    camera: number,
    width: number,
    height: number,
    generation: number,
    timingAvailable: boolean,
  ): RenderExtent | undefined {
    const key = `${camera}:${width}:${height}:${generation}:${timingAvailable}`;
    const contextChanged = key !== this.#key || owner !== this.#owner;
    const previous = this.#parameters;
    if (
      contextChanged ||
      parameters?.targetGpuMs !== previous?.targetGpuMs ||
      parameters?.minScale !== previous?.minScale ||
      parameters?.maxScale !== previous?.maxScale
    ) {
      const accepted = this.#extent;
      const scale = this.#scale;
      this.reset();
      this.#extent = accepted?.generation === generation ? accepted : undefined;
      this.#key = key;
      this.#owner = owner;
      this.#parameters = parameters;
      this.#scale =
        parameters === undefined
          ? 1
          : contextChanged || previous === undefined || !timingAvailable
            ? parameters.maxScale
            : Math.max(parameters.minScale, Math.min(parameters.maxScale, scale));
      if (
        !contextChanged &&
        timingAvailable &&
        parameters !== undefined &&
        previous !== undefined &&
        parameters.minScale < parameters.maxScale &&
        parameters.targetGpuMs > previous.targetGpuMs &&
        this.#scale < parameters.maxScale
      ) {
        // A newly authored budget invalidates the old quality boundary. Take
        // one maximum-quality trial after fresh GPU feedback; its measured
        // cost still decides acceptance or rollback.
        this.#headroomProbe = { scale: this.#scale, gpuMs: undefined, state: 'probing' };
      }
      this.#status =
        parameters?.minScale === parameters?.maxScale
          ? 'fixed'
          : timingAvailable
            ? 'warming'
            : 'unavailable';
    }
    return parameters === undefined
      ? undefined
      : deriveRenderExtent({
          outputWidth: width,
          outputHeight: height,
          requestedScale: this.#scale,
          generation,
          ...(parameters.minScale === parameters.maxScale
            ? {}
            : { minScale: parameters.minScale, maxScale: parameters.maxScale }),
        });
  }

  get needsSample(): boolean {
    return (
      this.#parameters !== undefined &&
      this.#status !== 'fixed' &&
      this.#status !== 'unavailable' &&
      !this.#pending
    );
  }

  get submittedExtent(): RenderExtent | undefined {
    return this.#extent;
  }

  commit(extent: RenderExtent | undefined, rasterRows: number): void {
    const parameters = this.#parameters;
    if (
      parameters !== undefined &&
      parameters.minScale < parameters.maxScale &&
      this.#status !== 'unavailable' &&
      this.#rasterRows !== undefined &&
      rasterRows < this.#rasterRows &&
      this.#scale < parameters.maxScale
    ) {
      // Fewer submitted raster rows are a workload-change hint, not a cost
      // estimate. Remeasure authored maximum quality once; GPU feedback owns
      // its acceptance or rollback, including non-monotonic sparse views.
      this.#revision++;
      this.#samples = 0;
      this.#budgetOverruns = 0;
      this.#gpuMs = undefined;
      this.#windowMinimumMs = undefined;
      this.#windowMaximumMs = 0;
      this.#windowSecondMaximumMs = 0;
      this.#status = 'warming';
      this.#headroomProbe = { scale: this.#scale, gpuMs: undefined, state: 'probing' };
    }
    this.#rasterRows = rasterRows;
    this.#extent = extent;
  }

  /** Call only after a successful submit. At most one readback can affect feedback. */
  observe(sample: Promise<number | undefined>): void {
    if (!this.needsSample) return;
    const revision = this.#revision;
    this.#pending = true;
    void sample
      .catch(() => undefined)
      .then((milliseconds) => {
        this.#pending = false;
        if (revision !== this.#revision) return;
        const parameters = this.#parameters;
        if (parameters === undefined) return;
        if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds <= 0) {
          // A failed/partial sample is not headroom. Retry on a later submitted frame.
          this.#samples = 0;
          this.#budgetOverruns = 0;
          this.#gpuMs = undefined;
          this.#windowMinimumMs = undefined;
          this.#windowMaximumMs = 0;
          this.#windowSecondMaximumMs = 0;
          this.#status = 'warming';
          return;
        }
        this.#status = 'adaptive';
        this.#gpuMs =
          this.#gpuMs === undefined ? milliseconds : this.#gpuMs * 0.75 + milliseconds * 0.25;
        this.#windowMinimumMs = Math.min(this.#windowMinimumMs ?? milliseconds, milliseconds);
        if (milliseconds >= this.#windowMaximumMs) {
          this.#windowSecondMaximumMs = this.#windowMaximumMs;
          this.#windowMaximumMs = milliseconds;
        } else {
          this.#windowSecondMaximumMs = Math.max(this.#windowSecondMaximumMs, milliseconds);
        }
        if (milliseconds > parameters.targetGpuMs * 1.05) this.#budgetOverruns++;
        if (++this.#samples < 8) return;
        const minimumMs = this.#windowMinimumMs;
        // Repeated expensive frames must not disappear when a window ends
        // cheaply. A trimmed midrange ignores one isolated high outlier and
        // symmetric near-budget noise, without retaining sample arrays.
        const decisionMs = Math.max(
          this.#gpuMs,
          (minimumMs + this.#windowSecondMaximumMs) / 2,
          // A range midpoint can understate a skewed cost cycle. Five actual
          // budget misses in eight samples cannot be treated as fitting noise.
          this.#budgetOverruns > 4 ? this.#windowSecondMaximumMs : 0,
        );
        this.#windowMinimumMs = undefined;
        this.#windowMaximumMs = 0;
        this.#windowSecondMaximumMs = 0;
        this.#samples = 0;
        this.#budgetOverruns = 0;
        const ratio = decisionMs / parameters.targetGpuMs;
        const probe = this.#headroomProbe;
        if (probe?.state === 'probing' && this.#scale === probe.scale) {
          this.#headroomProbe = { ...probe, gpuMs: minimumMs };
          this.#scale = parameters.maxScale;
          this.#gpuMs = undefined;
          return;
        }
        // GPU cost need not be smooth in pixel area. If a quality probe crosses
        // a costly boundary, keep the measured feasible scale until its workload
        // actually becomes cheaper, rather than repeating the same failed probe.
        if (probe?.state === 'probing' && this.#scale > probe.scale && ratio > 1.05) {
          this.#scale = probe.scale;
          this.#headroomProbe = { ...probe, gpuMs: undefined, state: 'blocked' };
          this.#gpuMs = undefined;
          return;
        }
        // One fitting window is not settled headroom if the probe's minimum
        // is still growing materially. Recheck it before raising quality again.
        if (
          probe?.state === 'probing' &&
          this.#scale > probe.scale &&
          probe.gpuMs !== undefined &&
          minimumMs > probe.gpuMs * 1.15
        ) {
          this.#headroomProbe = { ...probe, gpuMs: minimumMs };
          return;
        }
        if (probe?.state === 'blocked') {
          if (probe.gpuMs !== undefined && this.#gpuMs < probe.gpuMs * 0.85) {
            this.#headroomProbe = undefined;
          } else {
            // A resize tail can inflate the feasible EMA. Lower its baseline
            // as unchanged-scale work settles; settling alone is not recovery.
            this.#headroomProbe = {
              ...probe,
              gpuMs: Math.min(probe.gpuMs ?? minimumMs, this.#gpuMs),
            };
            if (this.#scale >= probe.scale && ratio < 0.85) return;
          }
        }
        if (ratio >= 0.85 && ratio <= 1.05) {
          // A probe can fit its first window and overload after caches settle.
          // Retain the preceding feasible scale until another quality increase.
          return;
        }
        const desired = this.#scale * Math.sqrt(0.95 / ratio);
        const step = ratio > 1.05 ? -1 / 16 : 1 / 32;
        const limited =
          step < 0 ? Math.max(desired, this.#scale + step) : Math.min(desired, this.#scale + step);
        // Smaller targets are cheaper without a workload change. Retain the
        // failed upper boundary even if overloaded rollback samples reduce further.
        const maxScale =
          this.#headroomProbe?.state === 'blocked'
            ? Math.min(parameters.maxScale, this.#headroomProbe.scale)
            : parameters.maxScale;
        const scale = Math.max(
          parameters.minScale,
          Math.min(maxScale, Math.round(limited * 32) / 32),
        );
        if (scale !== this.#scale) {
          if (this.#headroomProbe?.state === 'blocked')
            // Savings at a new extent cannot prove a workload change. Its first
            // completed window establishes a baseline before recovery can unlock.
            this.#headroomProbe = {
              ...this.#headroomProbe,
              // The old feasible extent has itself overloaded. Returning to it
              // would repeat that observed overload, even without another probe.
              scale: step < 0 ? scale : this.#headroomProbe.scale,
              gpuMs: undefined,
            };
          else
            this.#headroomProbe =
              step > 0 ? { scale: this.#scale, gpuMs: minimumMs, state: 'probing' } : undefined;
          this.#scale = scale;
          this.#gpuMs = undefined;
        }
      });
  }

  reset(): void {
    this.#revision++;
    this.#key = '';
    this.#owner = undefined;
    this.#parameters = undefined;
    this.#samples = 0;
    this.#budgetOverruns = 0;
    this.#gpuMs = undefined;
    this.#windowMinimumMs = undefined;
    this.#windowMaximumMs = 0;
    this.#windowSecondMaximumMs = 0;
    this.#headroomProbe = undefined;
    this.#extent = undefined;
    this.#rasterRows = undefined;
  }

  inspect(): DynamicResolutionInspection | undefined {
    return this.#parameters === undefined
      ? undefined
      : Object.freeze({
          status: this.#status,
          targetGpuMs: this.#parameters.targetGpuMs,
          gpuMs: this.#gpuMs,
          extent: this.#extent,
        });
  }
}
