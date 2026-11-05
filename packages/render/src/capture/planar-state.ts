import type { CameraSnapshot } from '../render-contract';
import type { RenderTarget } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';

/** One planar mirror capture: the display camera, its target and the frame it was selected in. */
export interface PlanarCapture {
  readonly camera: CameraSnapshot;
  readonly target: RenderTarget;
  readonly physical: RenderTargetPhysical;
  readonly frame: number;
}

/** One display-owned capture, with texture and matrix promoted by the same receipt. */
export class PlanarCaptureState {
  private completed: PlanarCapture | undefined;
  private pending: PlanarCapture | undefined;
  private selected: PlanarCapture | undefined;
  /** What the view's recording did with the selection; RenderCommit settles it. */
  private recorded: { submitted: boolean; completion: Promise<unknown> | undefined } | undefined;
  dispose(): void {
    this.completed = this.pending = this.selected = this.recorded = undefined;
  }

  prepare(
    camera: CameraSnapshot | undefined,
    physical: RenderTargetPhysical | undefined,
    frame: number,
  ) {
    if (
      camera?.target === undefined ||
      camera.planarReflection === undefined ||
      physical === undefined
    ) {
      this.dispose();
      return undefined;
    }
    this.recorded = undefined;
    // RenderTargetHost owns the sole physical output. Per-display target identity
    // is explicit in PlanarReflection; cadence never creates a second texture.
    const previous = this.completed;
    const pending = this.pending?.physical === physical ? this.pending : undefined;
    const due =
      pending === undefined &&
      (previous === undefined ||
        previous.physical !== physical ||
        previous.target !== camera.target ||
        previous.camera.planarReflection?.requestVersion !==
          camera.planarReflection.requestVersion ||
        previous.camera.planarReflection?.generateMipmaps !==
          camera.planarReflection.generateMipmaps ||
        frame - previous.frame >= camera.planarReflection.updateIntervalFrames);
    // The next submission is ordered after the pending capture on the same
    // queue. Its texture already belongs to that camera, even before the CPU
    // completion notification; never pair it with the preceding matrix.
    this.selected = pending ?? previous;
    if (!due) return undefined;
    const candidate = { camera, target: camera.target, physical, frame };
    this.selected = candidate;
    return candidate;
  }

  current() {
    return this.selected;
  }

  /** Record time: the view's recording ended; `submitted` whether its work reached the queue. */
  stage(submitted: boolean, completion: Promise<unknown> | undefined): void {
    this.recorded = { submitted, completion };
  }

  /**
   * RenderCommit: promote the selection only when the frame was accepted and
   * the view recorded it; any other frame, including one whose recording
   * never ran or threw before submit, rolls the selection back.
   */
  settle(accepted: boolean): void {
    const recorded = this.recorded;
    this.recorded = undefined;
    this.submit(accepted && recorded?.submitted === true, recorded?.completion);
  }

  private submit(submitted: boolean, completion: Promise<unknown> | undefined): void {
    const candidate = this.selected;
    if (candidate === undefined || candidate === this.completed || candidate === this.pending)
      return;
    if (!submitted || completion === undefined) {
      this.selected = this.pending ?? this.completed;
      return;
    }
    this.pending = candidate;
    void completion.then(
      () => {
        if (this.pending !== candidate) return;
        this.completed = candidate;
        this.pending = undefined;
      },
      () => {
        if (this.pending !== candidate) return;
        if (this.completed?.physical === candidate.physical) this.completed = undefined;
        this.pending = undefined;
        this.selected = this.completed;
      },
    );
  }
}
