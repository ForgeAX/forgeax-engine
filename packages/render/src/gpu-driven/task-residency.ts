import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { GpuInputReadFrame, GpuSceneInputs, GpuTaskHeader } from '../gpu-scene-inputs';
import type { FrameList } from '../scene/frame-list';
import { MemberCandidates } from './batch-members';
import type { GpuDrivenBatch, GpuDrivenCandidate, SubmissionPlan } from './batch-topology';
import { hasFixedTaskHeaders } from './fixed-task-plan';

interface HeldMembers {
  readonly inputs: GpuSceneInputs;
  readonly key: object;
  readonly releases: readonly (() => void)[];
}

/** Physical task leases, independently of the owner's current execution. */
export class GpuTaskResidency {
  private active: HeldMembers | undefined;
  private resident: HeldMembers | undefined;
  private readonly unconfirmed: HeldMembers[] = [];
  private failure: AggregateError | undefined;
  private disposed = false;

  constructor(private readonly device: RhiDevice) {}

  assertLive(inputs: GpuSceneInputs): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.disposed) throw invalid('a live View member owner');
    if (!inputs.isLiveOn(this.device))
      throw invalid('a live input incarnation on this View device');
  }

  prepareResident(plan: SubmissionPlan, inputs: GpuSceneInputs): void {
    this.assertLive(inputs);
    if (!hasFixedTaskHeaders(plan)) throw invalid('an owned fixed resident task plan');
    if (this.resident?.inputs === inputs && this.resident.key === plan) return;
    const roots: MemberCandidates[] = [];
    for (const batch of plan.batches) {
      if (!MemberCandidates.is(batch.candidates)) throw invalid('owned resident member roots');
      roots.push(batch.candidates);
    }
    this.replace('resident', inputs, plan, roots);
  }

  adoptActive(
    inputs: GpuSceneInputs,
    topology: object,
    rows: readonly GpuDrivenBatch[],
    headers: readonly GpuTaskHeader[],
  ): void {
    this.assertLive(inputs);
    if (rows.length !== headers.length) throw invalid('one captured header per active task');
    this.replace('active', inputs, topology, [], rows, headers);
  }

  prepareHeaders(
    plan: SubmissionPlan,
    inputs: GpuSceneInputs,
    topology: object,
    rows: readonly GpuDrivenBatch[],
    headers: readonly GpuTaskHeader[],
  ): void {
    this.assertLive(inputs);
    if (
      !hasFixedTaskHeaders(plan) ||
      rows.length !== plan.batches.length ||
      headers.length !== rows.length
    )
      throw invalid('one captured header per owned fixed resident task');
    let index = 0;
    for (const batch of plan.batches) {
      if (batch !== rows[index++] || !MemberCandidates.is(batch.candidates))
        throw invalid('the exact resident task roster');
    }
    this.replace('resident', inputs, topology, [], rows, headers);
  }

  releaseRead(inputs: GpuSceneInputs, frame: GpuInputReadFrame): void {
    try {
      frame.release();
    } catch (cause) {
      this.unconfirmed.push({ inputs, key: frame, releases: [() => frame.release()] });
      this.failure = new AggregateError(
        this.failure === undefined ? [cause] : [this.failure, cause],
        'View input read retirement failed',
      );
      throw this.failure;
    }
  }

  private replace(
    lane: 'active' | 'resident',
    inputs: GpuSceneInputs,
    key: object,
    members: readonly FrameList<GpuDrivenCandidate>[],
    rows: readonly GpuDrivenBatch[] = [],
    headers: readonly GpuTaskHeader[] = [],
  ): void {
    const previous = this[lane];
    if (previous?.inputs === inputs && previous.key === key) return;
    const releases: (() => void)[] = [];
    const next: HeldMembers = { inputs, key, releases };
    try {
      for (const root of members)
        if (MemberCandidates.is(root)) releases.push(inputs.holdMembers(root));
      for (const [index, header] of headers.entries()) {
        const batch = rows[index];
        if (batch === undefined) throw invalid('an exact active task for its header');
        releases.push(inputs.holdHeader(header, batch));
      }
    } catch (cause) {
      const cleanup = releaseAll([next]);
      if (cleanup.failures.length > 0) {
        this.unconfirmed.push(...cleanup.unconfirmed);
        this.failure = new AggregateError(
          [cause, ...cleanup.failures],
          'View member acquisition failed',
          {
            cause,
          },
        );
        throw this.failure;
      }
      throw cause;
    }
    this[lane] = next;
    const cleanup = releaseAll(previous === undefined ? [] : [previous]);
    if (cleanup.failures.length > 0) {
      this.unconfirmed.push(...cleanup.unconfirmed);
      this.failure = new AggregateError(cleanup.failures, 'View member retirement failed');
      throw this.failure;
    }
  }

  dispose(): void {
    this.disposed = true;
    const held = [...this.unconfirmed];
    if (this.active !== undefined) held.push(this.active);
    if (this.resident !== undefined) held.push(this.resident);
    this.active = undefined;
    this.resident = undefined;
    this.unconfirmed.length = 0;
    const cleanup = releaseAll(held);
    this.unconfirmed.push(...cleanup.unconfirmed);
    if (cleanup.failures.length > 0) {
      const previous = this.failure;
      this.failure = new AggregateError(
        previous === undefined ? cleanup.failures : [previous, ...cleanup.failures],
        'View member disposal failed',
      );
    }
    // A later idempotent callback cannot prove a previously failed release.
    if (this.failure !== undefined) throw this.failure;
  }
}

function releaseAll(held: readonly HeldMembers[]): {
  readonly failures: unknown[];
  readonly unconfirmed: HeldMembers[];
} {
  const failures: unknown[] = [];
  const unconfirmed: HeldMembers[] = [];
  for (const lease of held) {
    let failed = false;
    for (const release of lease.releases)
      try {
        release();
      } catch (cause) {
        failed = true;
        failures.push(cause);
      }
    if (failed) unconfirmed.push(lease);
  }
  return { failures, unconfirmed };
}

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'prepare exact resident task membership on its live View and GPU Scene owner',
  });
}
