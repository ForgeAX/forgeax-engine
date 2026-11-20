import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type { GpuScene } from '../gpu-scene';
import type { RenderResidencyGroup } from './batch-residency';
import {
  type BatchTopology,
  matchesResidentGroupPlan,
  type ResidentGroupPlan,
  type SubmissionPlan,
} from './batch-topology';
import { hasCapturedTaskMembership } from './fixed-task-plan';
import type {
  HeldResidentBatchRows,
  ProvisionalBatchContribution,
  ResidentBatchPreparationInput,
  ResidentBatchSetInput,
} from './production-raster-rows';

type Failure = RhiError | GpuDrivenPreparationError;
export type ResidentBatchReadContext = Pick<
  ResidentBatchPreparationInput,
  'scene' | 'executions' | 'meshes'
>;
export interface ResidentRowPreparationInput {
  readonly topology: BatchTopology;
  readonly group: RenderResidencyGroup;
  /** Fresh current producer facts, never a parked ordinary frame. */
  readonly read: () => ResidentBatchReadContext;
  /** The initial source/attempt guard; it must not refresh the requested definition. */
  readonly isCurrent: () => boolean;
}
export interface ResidentRowPreparationStatus {
  readonly phase: 'discover' | 'prepare' | 'held' | 'released' | 'failed';
  readonly visitedBatches: number;
  readonly selectedBatches: number;
  readonly preparedContributions: number;
}
export interface ResidentRowPreparation {
  step(maxWork: number): Result<ResidentRowPreparationStatus, Failure>;
  /** A new read domain revalidates all original version proofs before replacing the hold. */
  validate(): Result<Omit<HeldResidentBatchRows, 'release'>, Failure>;
  inspect(): ResidentRowPreparationStatus;
  release(): void;
}
export interface ResidentRowPreparationOwner {
  alive(): boolean;
  available(): boolean;
  prepare(input: ResidentBatchPreparationInput): Result<ProvisionalBatchContribution, Failure>;
  accept(input: ResidentBatchSetInput): Result<HeldResidentBatchRows, Failure>;
  finished(task: ResidentRowPreparation): void;
}
interface Scope {
  readonly topology: BatchTopology;
  readonly group: RenderResidencyGroup;
  readonly plan: SubmissionPlan;
  readonly groupPlan: ResidentGroupPlan;
  readonly scene: GpuScene;
  readonly read: () => ResidentBatchReadContext;
  readonly guard: () => boolean;
}

/** A bounded GPU-row task. Held Scene versions are only one part of Render readiness. */
export function createResidentRowPreparation(
  owner: ResidentRowPreparationOwner,
  input: ResidentRowPreparationInput,
): Result<ResidentRowPreparation, Failure> {
  if (!owner.alive() || !input.topology.hasResidencyGroup(input.group)) return err(stale());
  const read = input.read.bind(input);
  const guard = input.isCurrent.bind(input);
  if (guard() !== true || !owner.alive()) return err(stale());
  const current = read();
  const plan = current.scene.residentExecution ?? current.scene.plan;
  if (!hasCapturedTaskMembership(plan)) return err(stale());
  const groupPlan = input.topology.captureResidencyGroupPlan(input.group, plan);
  if (groupPlan === undefined) return err(stale());
  const task = new RowPreparation(owner, {
    topology: input.topology,
    group: input.group,
    plan,
    groupPlan,
    scene: current.scene.scene,
    read,
    guard,
  });
  return task.current().ok ? ok(task) : err(stale());
}

class RowPreparation implements ResidentRowPreparation {
  private phase: ResidentRowPreparationStatus['phase'] = 'discover';
  private visited = 0;
  private prepared = 0;
  private readonly indices: number[] = [];
  private readonly contributions: ProvisionalBatchContribution[] = [];
  private held: HeldResidentBatchRows | undefined;
  private failure: Failure | undefined;
  private retirementFailure: unknown;
  private stepping = false;

  constructor(
    private readonly owner: ResidentRowPreparationOwner,
    private scope: Scope | undefined,
  ) {}

  current(): Result<ResidentBatchReadContext, Failure> {
    const scope = this.scope;
    if (scope === undefined || !this.guarded(scope)) return err(stale());
    const context = scope.read();
    if (!this.currentInput(scope, context)) return err(stale());
    return ok(context);
  }

  private scoped(scope: Scope): boolean {
    return (
      this.scope === scope &&
      this.phase !== 'released' &&
      this.phase !== 'failed' &&
      this.owner.alive() &&
      scope.topology.hasResidencyGroup(scope.group)
    );
  }

  private guarded(scope: Scope): boolean {
    return this.scoped(scope) && scope.guard() === true && this.scoped(scope);
  }

  private currentInput(scope: Scope, context: ResidentBatchReadContext): boolean {
    const cursor = scope.scene.contentCursor;
    if (!this.guarded(scope)) return false;
    const same =
      context.scene.scene === scope.scene &&
      matchesResidentGroupPlan(
        scope.groupPlan,
        scope.plan,
        context.scene.residentExecution ?? context.scene.plan,
      );
    return same && this.scoped(scope) && scope.scene.live && scope.scene.contentCursor === cursor;
  }

  inspect(): ResidentRowPreparationStatus {
    return {
      phase: this.phase,
      visitedBatches: this.visited,
      selectedBatches: this.indices.length,
      preparedContributions: this.prepared,
    };
  }

  step(maxWork: number): Result<ResidentRowPreparationStatus, Failure> {
    if (!Number.isSafeInteger(maxWork) || maxWork < 1)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'a positive work grant',
          hint: 'advance one admitted contribution at a time under the shared maintenance budget',
        }),
      );
    if (this.retirementFailure !== undefined) throw this.retirementFailure;
    if (this.failure !== undefined) return err(this.failure);
    if (this.phase === 'released' || this.stepping) return err(stale());
    if (this.phase === 'held') return ok(this.inspect());
    this.stepping = true;
    try {
      for (let work = 0; work < maxWork; work++) {
        if (!this.owner.available()) break;
        const context = this.current();
        if (!context.ok) return this.fail(context.error);
        if (!this.owner.available()) break;
        const result = this.advance(context.value);
        if (!result.ok) return this.fail(result.error);
        if (this.inspect().phase === 'held') break;
      }
      return ok(this.inspect());
    } finally {
      this.stepping = false;
    }
  }

  private advance(context: ResidentBatchReadContext): Result<void, Failure> {
    const scope = this.scope;
    if (scope === undefined) return err(stale());
    if (this.phase === 'discover') {
      if (this.visited < scope.plan.batches.length) {
        const batch = scope.plan.batches.at(this.visited);
        if (batch?.key.residencyGroup === scope.group.id) this.indices.push(this.visited);
        this.visited++;
      } else this.phase = 'prepare';
      return ok(undefined);
    }
    if (this.prepared < this.indices.length * 2) {
      const index = this.indices[Math.floor(this.prepared / 2)];
      if (index === undefined) return err(stale());
      const result = this.owner.prepare({
        ...context,
        plan: scope.plan,
        groupPlan: scope.groupPlan,
        index,
        pass: this.prepared % 2 === 0 ? 'forward' : 'shadow',
        isCurrent: () => this.currentInput(scope, context),
      });
      if (!result.ok) return result;
      if (this.scope !== scope) return err(stale());
      this.contributions.push(result.value);
      this.prepared++;
      return ok(undefined);
    }
    const accepted = this.accept(context);
    return accepted.ok ? ok(undefined) : accepted;
  }

  private accept(context: ResidentBatchReadContext): Result<HeldResidentBatchRows, Failure> {
    const scope = this.scope;
    if (scope === undefined) return err(stale());
    const accepted = this.owner.accept({
      ...context,
      plan: scope.plan,
      groupPlan: scope.groupPlan,
      contributions: this.contributions,
      isCurrent: () => this.currentInput(scope, context),
    });
    if (!accepted.ok) return accepted;
    if (this.scope !== scope || !this.owner.alive()) {
      accepted.value.release();
      return err(stale());
    }
    const previous = this.held;
    this.held = accepted.value;
    const cursor = scope.scene.contentCursor;
    try {
      previous?.release();
    } catch (cause) {
      this.phase = 'failed';
      this.retirementFailure = cause;
      throw cause;
    }
    if (
      this.held !== accepted.value ||
      !this.currentInput(scope, context) ||
      scope.scene.contentCursor !== cursor
    )
      return err(stale());
    this.phase = 'held';
    return accepted;
  }

  validate(): Result<Omit<HeldResidentBatchRows, 'release'>, Failure> {
    if (this.retirementFailure !== undefined) throw this.retirementFailure;
    if (this.failure !== undefined) return err(this.failure);
    if (this.phase !== 'held' || this.stepping || !this.owner.available()) return err(stale());
    this.stepping = true;
    try {
      const context = this.current();
      if (!context.ok) return this.fail(context.error);
      const result = this.accept(context.value);
      if (!result.ok) return this.fail(result.error);
      return ok(
        Object.freeze({
          forward: result.value.forward,
          shadow: result.value.shadow,
          isCurrent: result.value.isCurrent,
        }),
      );
    } finally {
      this.stepping = false;
    }
  }

  private fail(error: Failure): Result<never, Failure> {
    this.failure = error;
    this.release();
    this.phase = 'failed';
    return err(error);
  }

  release(): void {
    this.phase = 'released';
    try {
      this.held?.release();
    } catch (cause) {
      this.phase = 'failed';
      this.retirementFailure ??= cause;
      throw cause;
    }
    this.held = undefined;
    this.indices.length = 0;
    this.contributions.length = 0;
    this.scope = undefined;
    if (this.retirementFailure !== undefined) {
      this.phase = 'failed';
      throw this.retirementFailure;
    }
    this.owner.finished(this);
  }
}

function stale(): GpuDrivenPreparationError {
  return new GpuDrivenPreparationError('stale-generation', {
    reason: 'generation-stale',
    owner: 'generation',
    expected: 'the same live group, fixed source and native resident membership',
  });
}
