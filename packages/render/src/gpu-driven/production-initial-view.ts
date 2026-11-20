import { err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene } from '../gpu-scene';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { SubmissionPlan } from './batch-topology';
import { GpuDrivenView, type GpuDrivenViewCreationStep, type ViewStorageTarget } from './view-gpu';
import type { GpuViewInputPreparation } from './view-input-bindings';

interface InitialProductionView {
  readonly borrowed: boolean;
  phase: 'preparing' | 'stored' | 'accepted' | 'consumed' | 'closed';
  view: GpuDrivenView | undefined;
  failure: RhiError | undefined;
  settlement: Promise<Result<void, RhiError>> | undefined;
  pending: Promise<void> | undefined;
}
export interface ProductionViewStorage {
  readonly view: GpuDrivenView;
  isCurrent(): boolean;
  /** Exact local adoption; the returned rollback is valid until ordinary consumption. */
  accept(): Result<() => void, RhiError>;
  release(): void;
}
export interface ProductionViewPreparation
  extends Generator<GpuDrivenViewCreationStep, Result<ProductionViewStorage, RhiError>> {
  /** This construction's responsibility, independent of the owner's current slot. */
  settleRetirement(): Promise<Result<void, RhiError>>;
}

interface InitialViewHost {
  readonly alive: boolean;
  readonly idle: boolean;
  readonly view: GpuDrivenView | undefined;
  adopt(view: GpuDrivenView): void;
  discard(view: GpuDrivenView | undefined): void;
  prepareConsumers(
    scene: GpuScene,
    target: ViewStorageTarget,
  ): Result<GpuViewInputPreparation, RhiError>;
}

export function initialViewRetirementError(cause: unknown): RhiError {
  return cause instanceof RhiError
    ? cause
    : Object.assign(
        new RhiError({
          code: 'internal-error',
          expected: 'confirmed original initial View retirement',
          hint: 'retain the exact initial View and its native failure until cleanup is confirmed',
        }),
        { cause },
      );
}

/** The original Production's initial native generation and exact partial-child custody. */
export class InitialViewPreparationOwner {
  private role: InitialProductionView | undefined;
  constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
    private readonly host: InitialViewHost,
    private readonly options: Pick<
      import('./view-gpu').GpuDrivenViewCreationInput,
      'labelPrefix' | 'readback' | 'shadowCameraCull'
    > = {},
  ) {}
  get view(): GpuDrivenView | undefined {
    return this.role?.view;
  }
  consume(view: GpuDrivenView): void {
    const role = this.role;
    if (role?.phase !== 'accepted' || role.view !== view) return;
    role.phase = 'consumed';
    role.view = undefined;
    this.role = undefined;
  }
  dispose(): void {
    if (this.role !== undefined) this.closeInitialViewPreparation(this.role);
  }
  prepare(
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
    layout: Parameters<GpuDrivenView['prepareInitialStorage']>[3],
    capture?: (view: GpuDrivenView) => void,
  ): ProductionViewPreparation {
    let role: InitialProductionView | undefined;
    const work = this.initialViewStorage(plan, scene, current, layout, capture, (issued) => {
      role = issued;
    });
    return Object.freeze(
      Object.assign(work, {
        settleRetirement: () => this.settleInitialRoleRetirement(role),
      }),
    );
  }

  private *initialViewStorage(
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
    layout: Parameters<GpuDrivenView['prepareInitialStorage']>[3],
    capture: ((view: GpuDrivenView) => void) | undefined,
    issuedRole: (role: InitialProductionView) => void,
  ): Generator<GpuDrivenViewCreationStep, Result<ProductionViewStorage, RhiError>> {
    const invalid = () =>
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'one live idle Production and its exact View preparation',
          hint: 'prepare the current View without selecting the prospective Source',
        }),
      );
    if (!this.host.idle) return invalid();
    // A subsequent construction shares an accepted View through its original Production.
    // Its predecessor can no longer roll that shared generation back.
    if (this.host.view !== undefined) this.consume(this.host.view);
    if (this.role !== undefined) return invalid();
    const existing = this.host.view;
    const role: InitialProductionView = {
      borrowed: existing !== undefined,
      phase: 'preparing',
      view: undefined,
      failure: undefined,
      settlement: undefined,
      pending: undefined,
    };
    this.role = role;
    issuedRole(role);
    let issued = false;
    const live = () => {
      const owned = () => this.host.idle && this.role === role && this.host.view === existing;
      return owned() && scene.live && current() && owned() && scene.live;
    };
    try {
      const created =
        existing === undefined ? yield* this.createInitialView(role, live) : ok(existing);
      if (!created.ok) return created;
      role.view = created.value;
      if (!live()) return invalid();
      capture?.(created.value);
      if (!live()) return invalid();
      const stored = yield* role.borrowed
        ? created.value.prepareStorageCapacity(plan, scene, live, layout, (target) =>
            this.host.prepareConsumers(scene, target),
          )
        : created.value.prepareInitialStorage(plan, scene, live, layout);
      if (!stored.ok) return stored;
      if (!live()) return invalid();
      role.phase = 'stored';
      const visible = created.value.visibleBuffer;
      const storageCurrent = () =>
        this.host.alive &&
        this.role === role &&
        visible !== undefined &&
        created.value.visibleBuffer === visible &&
        ((role.phase === 'stored' && this.host.view === existing) ||
          (role.phase === 'accepted' && this.host.view === created.value));
      const value: ProductionViewStorage = Object.freeze({
        view: created.value,
        isCurrent: storageCurrent,
        accept: () => {
          if (role.phase !== 'stored' || !live() || !storageCurrent()) return invalid();
          if (!role.borrowed) this.host.adopt(created.value);
          role.phase = 'accepted';
          return ok(() => this.closeInitialViewPreparation(role));
        },
        release: () => {
          if (role.phase === 'preparing' || role.phase === 'stored')
            this.closeInitialViewPreparation(role);
        },
      });
      issued = true;
      return ok(value);
    } finally {
      if (!issued) this.closeInitialViewPreparation(role);
    }
  }

  private *createInitialView(
    role: InitialProductionView,
    current: () => boolean,
  ): Generator<GpuDrivenViewCreationStep, Result<GpuDrivenView, RhiError>> {
    const work = GpuDrivenView.prepareCreation(
      { device: this.device, shaderModuleFactory: this.shaderModuleFactory, ...this.options },
      current,
    );
    try {
      for (;;) {
        const next = work.next();
        if (next.done) {
          role.pending = undefined;
          return next.value;
        }
        role.pending = next.value instanceof Promise ? next.value : undefined;
        yield next.value;
      }
    } finally {
      work.return(err(initialViewRetirementError('initial View construction closed')));
    }
  }

  /** The original Production keeps partial child responsibility through asynchronous retirement. */
  settleInitialViewRetirement(): Promise<Result<void, RhiError>> {
    return this.settleInitialRoleRetirement(this.role);
  }

  private settleInitialRoleRetirement(
    role: InitialProductionView | undefined,
  ): Promise<Result<void, RhiError>> {
    if (role === undefined) return Promise.resolve(ok(undefined));
    if (role.phase === 'consumed') return Promise.resolve(ok(undefined));
    if (role.settlement !== undefined) return role.settlement;
    return Promise.resolve(
      err(role.failure ?? initialViewRetirementError('initial View remains owned')),
    );
  }

  private closeInitialViewPreparation(role: InitialProductionView): void {
    if (role.phase === 'consumed') return;
    if (role.phase === 'closed') {
      if (role.failure !== undefined) throw role.failure;
      return;
    }
    role.phase = 'closed';
    const view = role.view;
    if (!role.borrowed) this.host.discard(view);
    try {
      if (!role.borrowed) view?.dispose();
    } catch (cause) {
      role.failure = initialViewRetirementError(cause);
    }
    const finish = (result: Result<void, RhiError>): Result<void, RhiError> => {
      if (!result.ok)
        role.failure =
          role.failure === undefined
            ? result.error
            : initialViewRetirementError(
                new AggregateError([role.failure, result.error], 'Initial View retirement failed'),
              );
      if (role.failure !== undefined) return err(role.failure);
      role.view = undefined;
      if (this.role === role) this.role = undefined;
      return ok(undefined);
    };
    try {
      // Native creation may synchronously dispose this owner before next()
      // records the returned completion. Read pending after that resume exits.
      role.settlement = Promise.resolve()
        .then(() => role.pending)
        .then(() => view?.settleRetirement() ?? ok(undefined))
        .then(finish, (cause) => finish(err(initialViewRetirementError(cause))));
    } catch (cause) {
      role.failure = initialViewRetirementError(cause);
      role.settlement = Promise.resolve(err(role.failure));
    }
    if (role.failure !== undefined) throw role.failure;
  }
}
