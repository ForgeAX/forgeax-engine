import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene } from '../gpu-scene';
import type { GpuInputReadFrame } from '../gpu-scene-inputs';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';
import { assembleFilteredGroups, type PreparedBatch } from './production-raster-prepare';
import { GpuTaskResidency } from './task-residency';
import type { EncodedViewTopology } from './view-topology';
import { encodedViewTopology } from './view-topology';

export interface FilteredTaskContext {
  readonly scene: GpuScene;
  readonly device: RhiDevice;
}

/** One Filtered row's physical header/member custody; never a native Ready proof. */
export class FilteredTaskHeaders {
  readonly inputs;
  private readonly custody: GpuTaskResidency;
  private direct = false;
  private encoded: EncodedViewTopology | undefined;
  private failure: AggregateError | undefined;

  constructor(
    private readonly scene: GpuScene,
    private readonly device: RhiDevice,
    private readonly topology: readonly GpuDrivenBatch[],
  ) {
    this.inputs = scene.inputs;
    this.custody = new GpuTaskResidency(device);
  }

  matches(context: FilteredTaskContext, topology: readonly GpuDrivenBatch[]): boolean {
    if (this.failure !== undefined) throw this.failure;
    if (
      !this.direct ||
      this.scene !== context.scene ||
      this.inputs !== context.scene.inputs ||
      this.device !== context.device ||
      !context.scene.live
    )
      return false;
    this.custody.assertLive(this.inputs);
    return (
      topology.length === this.topology.length &&
      topology.every((batch, index) => batch === this.topology[index])
    );
  }

  prepare(
    source: SubmissionPlan,
    batches: readonly PreparedBatch[],
    previous?: FilteredTaskHeaders,
  ): void {
    const guard = this.inputs.captureGuard();
    const revision = this.scene.syncRevision;
    let read: GpuInputReadFrame | undefined;
    let failure: unknown;
    try {
      this.custody.assertLive(this.inputs);
      const plan = assembleFilteredGroups(source, batches, this.topology).plan;
      read = this.inputs.capture();
      const encoded = encodedViewTopology(
        plan,
        this.scene,
        read,
        previous?.inputs === this.inputs ? previous.encoded : undefined,
      );
      read.seal().unwrap();
      this.custody.prepareHeaders(plan, this.inputs, encoded, encoded.rows, encoded.headers);
      this.direct = encoded.direct;
      this.encoded = encoded;
    } catch (cause) {
      failure = cause;
    }
    if (read !== undefined)
      try {
        this.custody.releaseRead(this.inputs, read);
      } catch (cause) {
        failure =
          failure === undefined
            ? cause
            : new AggregateError(
                [failure, cause],
                'Filtered header preparation and retirement failed',
              );
      }
    if (failure !== undefined) {
      if (!(failure instanceof RhiError))
        this.failure = new AggregateError(
          [failure],
          'Filtered header acquisition effects are unconfirmed',
        );
      throw failure;
    }
    this.custody.assertLive(this.inputs);
    if (
      !this.scene.live ||
      this.scene.inputs !== this.inputs ||
      !guard() ||
      this.scene.syncRevision !== revision
    )
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the same live Scene and Inputs after all temporary header reads retire',
        hint: 'discard this Filtered header preparation and retry with current source facts',
      });
  }

  dispose(): void {
    let retirement: unknown;
    try {
      this.custody.dispose();
    } catch (cause) {
      retirement = cause;
    }
    if (this.failure !== undefined) {
      if (retirement !== undefined) this.failure.errors.push(retirement);
      throw this.failure;
    }
    if (retirement !== undefined) throw retirement;
  }
}
