import type { World } from '@forgeax/engine-ecs';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { sameInputViews } from '../gpu-driven/production-input-bindings';
import type { GpuViewInputPreparation } from '../gpu-driven/view-input-bindings';
import type { GpuScene, GpuSceneTableBindingTarget } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import type { MaterialTableBindingPreparation } from '../record/material-bg-assembly-cache';
import { prepareShadowMaterialTableBindings } from '../record/shadow-material-table-bindings';
import type { SceneComposition } from '../scene/scene-composition';
import { renderSubmission } from '../world/render-world';
import type { ViewRecorderState } from '../world/view-output-systems';
import { recordContext } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';

interface CameraInputHost {
  readonly world: World;
  readonly composition: SceneComposition;
  readonly primary: ViewSettlementOwner;
  recorders(): readonly ViewRecorderState[];
}

function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected:
      'one current idle Renderer input handoff with unchanged camera owners and device scopes',
    hint: 'release the candidate and retry after camera, source or device changes settle',
  });
}

function ownerFacts(owner: ViewSettlementOwner, scene: GpuScene) {
  const context = recordContext(owner.internals);
  const production = owner.gpuDriven;
  return {
    owner,
    production,
    context,
    meshCache: owner.frameState.meshBindGroupCache,
    materialCache: owner.frameState.materialBgAssemblyCache,
    pipeline: context.getPipelineState(),
    scope: context.deviceScope,
    device: owner.internals.device,
    graph: owner.frameState.compiledFrameGraph,
    graphGeneration: owner.frameState.compiledFrameGraphGeneration,
    views: production.inputBindingViews(scene),
  };
}

type OwnerFacts = ReturnType<typeof ownerFacts>;

/** Address growth carries the current bytes at publish; only native view ownership constrains it. */
function sameAddressOwner(facts: OwnerFacts, scene: GpuScene): boolean {
  const context = recordContext(facts.owner.internals);
  return (
    context === facts.context &&
    context.deviceScope === facts.scope &&
    facts.scope.isAlive() &&
    facts.owner.internals.device === facts.device &&
    facts.owner.gpuDriven === facts.production &&
    sameInputViews(facts.views, facts.production.inputBindingViews(scene))
  );
}

function sameOwner(facts: OwnerFacts, scene: GpuScene): boolean {
  return (
    sameAddressOwner(facts, scene) &&
    facts.context.getPipelineState() === facts.pipeline &&
    facts.owner.frameState.meshBindGroupCache === facts.meshCache &&
    facts.owner.frameState.materialBgAssemblyCache === facts.materialCache &&
    facts.owner.frameState.compiledFrameGraph === facts.graph &&
    facts.owner.frameState.compiledFrameGraphGeneration === facts.graphGeneration
  );
}

/** One transient handoff on CameraViews' existing owners; no persistent consumer registry. */
export class CameraInputBindings {
  private preparing = false;
  private cancellation = 0;
  private task: GpuViewInputPreparation | undefined;
  constructor(private host: CameraInputHost | undefined) {}

  /** Each View publishes monotone owner capacity before any Source Data is admitted. */
  *prepareAddressCapacity(
    scene: GpuScene,
    extent: number,
    current: () => boolean,
    capture?: (settle: () => Promise<Result<void, RhiError>>) => void,
  ): Generator<void> {
    const host = this.host,
      cancellation = this.cancellation;
    if (host === undefined || this.preparing || this.task !== undefined) throw stale();
    const records = [...host.recorders()];
    const facts = [
      ownerFacts(host.primary, scene),
      ...records.map((record) => ownerFacts(record.owner, scene)),
    ];
    const live = () => {
      if (
        this.host !== host ||
        this.cancellation !== cancellation ||
        !current() ||
        this.host !== host ||
        this.cancellation !== cancellation ||
        renderSubmission(host.world).open ||
        host.composition.gpuSceneResident !== scene
      )
        return false;
      const now = host.recorders();
      return (
        now.length === records.length &&
        now.every((record, index) => record === records[index] && !record.retired) &&
        facts.every((fact) => sameAddressOwner(fact, scene)) &&
        this.host === host &&
        this.cancellation === cancellation &&
        !renderSubmission(host.world).open &&
        host.composition.gpuSceneResident === scene
      );
    };
    const views = new Set(facts.flatMap((fact) => fact.views));
    capture?.(captureViewRetirement([...views]));
    for (const view of views) {
      if (!live()) throw stale();
      yield* view.prepareAddressCapacity(scene, extent, live);
    }
    if (!live() || [...views].some((view) => !view.coversAddressExtent(scene, extent)))
      throw stale();
  }

  prepare(
    scene: GpuScene,
    input: GpuSceneInputPreparation,
    tables?: GpuSceneTableBindingTarget,
  ): Result<GpuViewInputPreparation, RhiError> {
    const host = this.host;
    if (host === undefined || this.preparing || this.task !== undefined) return err(stale());
    const cancellation = this.cancellation;
    this.preparing = true;
    try {
      const result = prepareCameraInputs(
        host,
        scene,
        input,
        () => this.host === host && this.cancellation === cancellation,
        (task) => {
          if (this.task === task) this.task = undefined;
        },
        tables,
      );
      if (result.ok) this.task = result.value;
      return result;
    } finally {
      this.preparing = false;
    }
  }

  /** Borrow this original Camera maintenance lifetime; reset/disposal invalidate it. */
  captureCurrent(): () => boolean {
    const host = this.host,
      cancellation = this.cancellation;
    return () => host !== undefined && this.host === host && this.cancellation === cancellation;
  }

  cancel(): void {
    this.cancellation++;
    this.task?.release();
  }
  dispose(): void {
    this.host = undefined;
    this.cancel();
  }
}

function captureViewRetirement(views: OwnerFacts['views']): () => Promise<Result<void, RhiError>> {
  return async () => {
    const failures: unknown[] = [];
    for (const view of views) {
      const result = await view.settleRetirement();
      if (!result.ok) failures.push(result.error);
    }
    return failures.length === 0
      ? ok(undefined)
      : err(
          Object.assign(
            new RhiError({
              code: 'internal-error',
              expected: 'all captured Camera View retirements complete',
              hint: 'retain the Source cleanup cohort and original failures',
            }),
            {
              cause: new AggregateError(failures, 'Camera View address retirement failed'),
            },
          ),
        );
  };
}

/** Keep temporary coverage traversal outside the returned handoff's lexical scope. */
function inputAddressCoverage(
  scene: GpuScene,
  tables: GpuSceneTableBindingTarget | undefined,
  facts: readonly OwnerFacts[],
): boolean {
  const extent =
    tables === undefined ? scene.rowAddressExtent : scene.preparedAddressExtent(tables.preparation);
  return (
    extent !== undefined &&
    facts.every((fact) => fact.views.every((view) => view.coversAddressExtent(scene, extent)))
  );
}

function prepareCameraInputs(
  host: CameraInputHost,
  scene: GpuScene,
  input: GpuSceneInputPreparation,
  current: () => boolean,
  finished: (task: GpuViewInputPreparation) => void,
  tables?: GpuSceneTableBindingTarget,
): Result<GpuViewInputPreparation, RhiError> {
  let tableTarget = tables;
  let owner: CameraInputHost | undefined = host;
  let source: GpuScene | undefined = scene;
  let candidate: GpuSceneInputPreparation | undefined = input;
  let ownerCurrent: typeof current | undefined = current;
  let done: typeof finished | undefined = finished;
  let entry = host.composition.entry;
  const records = [...host.recorders()];
  const facts = [ownerFacts(host.primary, scene)];
  for (const record of records) facts.push(ownerFacts(record.owner, scene));
  const tasks: GpuViewInputPreparation[] = [];
  let closed = false;
  let observing = false;
  const scopeCurrent = () => {
    if (
      closed ||
      ownerCurrent?.() !== true ||
      closed ||
      owner === undefined ||
      source === undefined ||
      !source.live
    )
      return false;
    if (
      renderSubmission(owner.world).open ||
      owner.composition.entry !== entry ||
      owner.composition.gpuSceneResident !== source
    )
      return false;
    const now = owner.recorders();
    return (
      !closed &&
      now.length === records.length &&
      now.every((record, index) => record === records[index] && !record.retired) &&
      facts.every((fact) => sameOwner(fact, source as GpuScene))
    );
  };
  const live = () =>
    scopeCurrent() &&
    candidate !== undefined &&
    source?.inputs.preparationIsCurrent(candidate) === true &&
    (tableTarget === undefined || source?.capacityTargetCurrent(tableTarget) === true) &&
    tasks.every((task) => task.isCurrent()) &&
    scopeCurrent() &&
    (tableTarget === undefined || source?.capacityTargetCurrent(tableTarget) === true);
  const release = () => {
    if (closed) return;
    closed = true;
    for (const task of tasks) task.release();
    tasks.length = 0;
    records.length = 0;
    facts.length = 0;
    owner = undefined;
    source = undefined;
    candidate = undefined;
    tableTarget = undefined;
    entry = undefined;
    ownerCurrent = undefined;
    const notify = done;
    done = undefined;
    notify?.(api);
  };
  const api: GpuViewInputPreparation = Object.freeze({
    isCurrent: () => {
      if (observing) return false;
      observing = true;
      try {
        return live();
      } finally {
        observing = false;
      }
    },
    publish: () => {
      if (observing) return err(stale());
      observing = true;
      let committedInput = false;
      try {
        if (!live() || candidate === undefined) return err(stale());
        if (
          tableTarget !== undefined &&
          source?.canPublishCapacityTarget(tableTarget, candidate) !== true
        )
          return err(stale());
        // Consumer publication consumes prebuilt bindings. Source preflight can
        // still run callbacks; any refusal after Inputs transfer faults the Scene.
        const committed = candidate.commitPrepared();
        if (!committed.ok) return committed;
        committedInput = true;
        if (tableTarget !== undefined) {
          const published = source?.publishCapacityTarget(tableTarget);
          if (published === undefined || !published.ok)
            return source?.failBindingPublication(published) ?? err(stale());
        }
        for (const task of tasks) {
          const published = task.publish();
          if (!published.ok) return source?.failBindingPublication(published.error) ?? published;
        }
        release();
        return ok(undefined);
      } catch (cause) {
        if (committedInput) return source?.failBindingPublication(cause) ?? err(stale());
        throw cause;
      } finally {
        observing = false;
      }
    },
    release,
  });
  let accepted = false;
  try {
    if (entry === undefined || !live()) return err(stale());
    if (!inputAddressCoverage(scene, tables, facts)) return err(stale());
    const prepared = new Set<OwnerFacts['production']>();
    for (const fact of facts) {
      if (!live()) return err(stale());
      if (fact.views.length === 0 || prepared.has(fact.production)) continue;
      let material: MaterialTableBindingPreparation | undefined;
      let transferred = false;
      try {
        const preparedMaterial =
          tableTarget === undefined || tableTarget.materialBuffer === scene.materialBuffer
            ? undefined
            : fact.materialCache.prepareTableBindings(
                fact.owner.internals,
                tableTarget,
                scopeCurrent,
              );
        if (preparedMaterial !== undefined && !preparedMaterial.ok) return preparedMaterial;
        material = preparedMaterial?.value;
        if (material !== undefined && tableTarget !== undefined)
          material = prepareShadowMaterialTableBindings(
            material,
            fact.device,
            fact.owner.frameState.shadowMaterialBindGroups,
            tableTarget,
            scopeCurrent,
          );
        const result = fact.production.prepareInputBindings(
          scene,
          input,
          scopeCurrent,
          tableTarget,
          material,
        );
        if (!result.ok) return result;
        tasks.push(result.value);
        transferred = true;
        prepared.add(fact.production);
      } finally {
        if (!transferred) {
          material?.release();
        }
      }
      if (!live()) return err(stale());
    }
    accepted = true;
    return ok(api);
  } finally {
    if (!accepted) release();
  }
}
