import { err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene } from '../gpu-scene';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import {
  InitialViewPreparationOwner,
  type ProductionViewPreparation,
  type ProductionViewStorage,
} from './production-initial-view';
import { shadowViewIdentityKey } from './shadow-view-identity';
import type { ShadowViewIdentity } from './shadow-views';
import type {
  GpuDrivenView,
  GpuDrivenViewCreationInput,
  GpuDrivenViewCreationStep,
  ViewStorageTarget,
} from './view-gpu';
import type { GpuViewInputPreparation } from './view-input-bindings';

interface PhysicalShadowView {
  readonly scene: GpuScene;
  readonly identity: ShadowViewIdentity;
  view: GpuDrivenView | undefined;
  readonly construction: InitialViewPreparationOwner;
}
/** Physical children of the original pool; execution/depth records remain in the pool. */
export class ShadowViewConstructions {
  private alive = true;
  private readonly entries = new Map<string, PhysicalShadowView>();
  constructor(
    private readonly device: RhiDevice,
    private readonly factory: PipelineBuilderShaderModuleFactory,
  ) {}
  private owner(
    scene: GpuScene,
    identity: ShadowViewIdentity,
    existing: GpuDrivenView | undefined,
    options: Pick<GpuDrivenViewCreationInput, 'labelPrefix' | 'readback' | 'shadowCameraCull'>,
    consumers: (target: ViewStorageTarget) => Result<GpuViewInputPreparation, RhiError>,
  ) {
    const key = shadowViewIdentityKey(identity);
    const previous = this.entries.get(key);
    if (previous !== undefined) return previous.construction;
    const entries = this.entries,
      self = this;
    const entry: PhysicalShadowView = {
      scene,
      identity,
      view: existing,
      construction: new InitialViewPreparationOwner(
        this.device,
        this.factory,
        {
          get alive() {
            return self.alive && entries.get(key) === entry && scene.live;
          },
          get idle() {
            return self.alive && entries.get(key) === entry;
          },
          get view() {
            return entry.view;
          },
          adopt(view) {
            entry.view = view;
          },
          discard(view) {
            if (entry.view === view) entry.view = undefined;
          },
          prepareConsumers: (_scene, target) => consumers(target),
        },
        options,
      ),
    };
    entries.set(key, entry);
    return entry.construction;
  }
  prepare(
    scene: GpuScene,
    identity: ShadowViewIdentity,
    existing: GpuDrivenView | undefined,
    options: Pick<GpuDrivenViewCreationInput, 'labelPrefix' | 'readback' | 'shadowCameraCull'>,
    consumers: (target: ViewStorageTarget) => Result<GpuViewInputPreparation, RhiError>,
    plan: import('./batch-topology').SubmissionPlan,
    current: () => boolean,
  ): ProductionViewPreparation {
    let work: ProductionViewPreparation | undefined;
    let replaced: InitialViewPreparationOwner | undefined;
    const steps = this.prepareRole(
      scene,
      identity,
      existing,
      options,
      consumers,
      plan,
      current,
      (issued) => {
        work = issued;
      },
      (owner) => {
        replaced = owner;
      },
    );
    return Object.assign(steps, {
      settleRetirement: async () => {
        const results = await Promise.allSettled([
          work?.settleRetirement(),
          replaced?.settleInitialViewRetirement(),
        ]);
        const failures: unknown[] = [];
        for (const result of results) {
          if (result.status === 'rejected') failures.push(result.reason);
          else if (result.value !== undefined && !result.value.ok)
            failures.push(result.value.error);
        }
        return failures.length === 0
          ? ok(undefined)
          : err(
              Object.assign(
                new RhiError({
                  code: 'internal-error',
                  expected: 'confirmed shadow physical role retirement',
                  hint: 'retain unconfirmed original child owners',
                }),
                { cause: new AggregateError(failures) },
              ),
            );
      },
    });
  }
  private *prepareRole(
    scene: GpuScene,
    identity: ShadowViewIdentity,
    existing: GpuDrivenView | undefined,
    options: Pick<GpuDrivenViewCreationInput, 'labelPrefix' | 'readback' | 'shadowCameraCull'>,
    consumers: (target: ViewStorageTarget) => Result<GpuViewInputPreparation, RhiError>,
    plan: import('./batch-topology').SubmissionPlan,
    current: () => boolean,
    issued: (work: ProductionViewPreparation) => void,
    replacing: (owner: InitialViewPreparationOwner) => void,
  ): Generator<GpuDrivenViewCreationStep, Result<ProductionViewStorage, RhiError>> {
    const invalid = () =>
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'current exact physical shadow owner',
          hint: 'retry after the original shadow role settles',
        }),
      );
    if (!this.alive || !current()) return invalid();
    const key = shadowViewIdentityKey(identity),
      previous = this.entries.get(key);
    if (
      previous !== undefined &&
      (previous.scene !== scene ||
        (existing !== undefined &&
          previous.view !== existing &&
          previous.construction.view !== existing))
    ) {
      replacing(previous.construction);
      if (existing !== undefined && previous.view === existing)
        previous.construction.consume(existing);
      previous.construction.dispose();
      yield previous.construction.settleInitialViewRetirement().then((result) => {
        result.unwrap();
      });
      if (!this.alive || !current() || this.entries.get(key) !== previous) return invalid();
      this.entries.delete(key);
    }
    if (!this.alive || !current()) return invalid();
    const work = this.owner(scene, identity, existing, options, consumers).prepare(
      plan,
      scene,
      current,
      { surfaceRows: false, lateMirror: false },
    );
    issued(work);
    return yield* work;
  }
  consume(identity: ShadowViewIdentity): GpuDrivenView | undefined {
    const entry = this.entries.get(shadowViewIdentityKey(identity));
    if (entry?.view !== undefined) entry.construction.consume(entry.view);
    return entry?.view;
  }
  forget(identity: ShadowViewIdentity, view: GpuDrivenView): void {
    const key = shadowViewIdentityKey(identity),
      entry = this.entries.get(key);
    if (entry?.view === view) this.entries.delete(key);
  }
  views(scene?: GpuScene, preparing = true) {
    const result: {
      view: GpuDrivenView;
      identity: ShadowViewIdentity;
      isCurrent: () => boolean;
    }[] = [];
    for (const [key, entry] of this.entries) {
      const view = entry.view ?? (preparing ? entry.construction.view : undefined);
      if ((scene !== undefined && entry.scene !== scene) || view === undefined) continue;
      result.push({
        view,
        identity: entry.identity,
        isCurrent: () =>
          this.alive &&
          this.entries.get(key) === entry &&
          (entry.view ?? entry.construction.view) === view,
      });
    }
    return result;
  }
  dispose(): void {
    this.alive = false;
    const failures: unknown[] = [];
    for (const entry of this.entries.values()) {
      try {
        entry.construction.dispose();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Shadow construction disposal failed');
    this.entries.clear();
  }
}
