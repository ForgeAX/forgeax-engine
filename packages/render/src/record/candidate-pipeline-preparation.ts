import type { World } from '@forgeax/engine-ecs';
import { describeMeshDraw } from '@forgeax/engine-geometry';
import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { materialRasterSourceFacts } from '../assembly/material/assembly';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { DynamicGeometryError } from '../dynamic-geometry';
import { buildGpuDrivenDraws } from '../extract/gpu-driven';
import { eligibleGpuDrivenDraws } from '../gpu-driven/batch-topology';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { MaterialResource } from '../material-resource';
import type { MeshPipelinePreparation } from '../publication/contract';
import type { RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import type { CandidateViewDemand } from './candidate-view-demand';
import type { InstalledFrameGraph, ValidatedRenderable } from './frame-snapshot';
import type { PipelineRequestRuntime } from './geometry-pipeline-requests';
import type { _InternalRenderPipelineContext } from './render-context';
import { scenePassRequests } from './scene-pass-work';
import {
  prepareHiddenShadowMaterialPipelines,
  prepareShadowMaterialPipelines,
} from './shadow-pass';
import { prepareTypedScenePipelineDemand } from './typed-scene-pipeline-demand';

type MaterialPipelineRequest = Parameters<
  NonNullable<PipelineRequestRuntime['getMaterialShaderPipeline']>
>;
type CandidateMaterialPipelineRequest = [...MaterialPipelineRequest, pipelinePreparation?: boolean];

/** Candidate requests share ordinary keys; lookup-only requests never build. */
export function candidateMaterialPipelineRequests(
  pipeline: (
    args: CandidateMaterialPipelineRequest,
    lookupOnly?: boolean,
  ) => ReturnType<NonNullable<PipelineRequestRuntime['getMaterialShaderPipeline']>>,
  entry: (
    args: CandidateMaterialPipelineRequest,
    lookupOnly?: boolean,
  ) => ReturnType<NonNullable<PipelineRequestRuntime['getMaterialShaderPipelineEntry']>>,
) {
  const request = (args: MaterialPipelineRequest): CandidateMaterialPipelineRequest => {
    const owned: CandidateMaterialPipelineRequest = args;
    owned[24] = true;
    return owned;
  };
  return {
    prepareMaterialShaderPipeline: (...args: MaterialPipelineRequest) => pipeline(request(args)),
    prepareMaterialShaderPipelineEntry: (...args: MaterialPipelineRequest) => entry(request(args)),
    lookupMaterialShaderPipeline: (...args: MaterialPipelineRequest) =>
      pipeline(request(args), true),
    lookupMaterialShaderPipelineEntry: (...args: MaterialPipelineRequest) =>
      entry(request(args), true),
  };
}

export interface CandidatePipelineInput {
  readonly preparation: MeshPipelinePreparation;
  readonly world?: World;
  readonly mesh: MeshGpuHandles;
  readonly asset: MeshAsset;
  readonly isCurrent: () => boolean;
}

export interface PreparedCandidatePipelines {
  isCurrent(): boolean;
  release(): void;
}

export type CandidatePipelineDemandReader = (
  input: CandidatePipelineInput,
  materials: MaterialFrame,
) =>
  | (CandidateViewDemand & {
      readonly lookup: {
        readonly pipeline: NonNullable<
          _InternalRenderPipelineContext['runtime']['getMaterialShaderPipeline']
        >;
        readonly entry: NonNullable<
          _InternalRenderPipelineContext['runtime']['getMaterialShaderPipelineEntry']
        >;
      };
    })
  | undefined;

export interface CandidatePipelinePreparationInspection {
  readonly warmAttempts: number;
  readonly warmReady: number;
  readonly warmQueued: number;
  readonly unavailableDemand: number;
  readonly unsupportedGraph: number;
}

type Prepared = Result<PreparedCandidatePipelines, DynamicGeometryError>;

type Request = {
  readonly input: CandidatePipelineInput;
  readonly resources: ReadonlyMap<number, MaterialResource>;
  readonly materials: MaterialFrame;
  projection?: {
    readonly graph: InstalledFrameGraph;
    readonly clustered: boolean;
    readonly reflectionFallback: boolean;
    readonly shadowViews: boolean;
    readonly entry: ValidatedRenderable;
    readonly artifacts: ReturnType<typeof collectGpuDrivenMaterialArtifacts>;
  };
  finish(result: Prepared): void;
  release(): void;
  onClose?: () => void;
};

/** A closed public receipt retains neither its source callback nor its physical owner. */
function candidatePipelineTicket(current: () => boolean, retire: () => void) {
  const state: { current?: () => boolean; retire?: () => void } = { current, retire };
  const close = () => {
    delete state.current;
    delete state.retire;
  };
  return {
    close,
    ticket: {
      isCurrent: () => state.current?.() === true,
      release: () => {
        const release = state.retire;
        close();
        release?.();
      },
    },
  };
}

function unavailable(actual: unknown): DynamicGeometryError {
  return new DynamicGeometryError(
    'dynamic-geometry-gpu-not-ready',
    'candidate pipelines complete for the current actual raster demand',
    'prepare again after the renderer has a current view, or after the reported dependency changes',
    { actual },
  );
}

/** Pending candidates own no scene rows, draw calls, histories, or second PSO cache. */
export class CandidatePipelinePreparationOwner {
  private readonly requests = new Set<Request>();
  private readonly releases = new Set<() => void>();
  private disposed = false;
  private demandMaterials = new MaterialFrame(undefined);
  private warmAttempts = 0;
  private warmReady = 0;
  private warmQueued = 0;
  private unavailableDemand = 0;
  private unsupportedGraph = 0;

  inspect(): CandidatePipelinePreparationInspection {
    return {
      warmAttempts: this.warmAttempts,
      warmReady: this.warmReady,
      warmQueued: this.warmQueued,
      unavailableDemand: this.unavailableDemand,
      unsupportedGraph: this.unsupportedGraph,
    };
  }

  /** Preparation demand builds real graph lanes without accepting any scene draw. */
  get materials(): MaterialFrame {
    return this.demandMaterials;
  }

  constructor(
    private readonly currentGraph: () => InstalledFrameGraph | null | undefined,
    private readonly readDemand?: CandidatePipelineDemandReader,
  ) {}
  prepare(input: CandidatePipelineInput, signal?: AbortSignal): Promise<Prepared> {
    if (this.disposed || signal?.aborted || !input.isCurrent())
      return Promise.resolve(err(unavailable('cancelled or retired candidate')));
    if (this.currentGraph() == null)
      return Promise.resolve(err(unavailable('no current view graph')));
    const resources = new Map<number, MaterialResource>();
    let materials = new MaterialFrame(undefined);
    const demand = new Set<MaterialResource>();
    try {
      for (const row of input.preparation.materials) {
        const resource = new MaterialResource(row.value);
        resources.set(row.id, resource);
        materials = materials.with(resource);
      }
      const snapshot = input.preparation.template.snapshot;
      for (const submesh of input.mesh.submeshes) {
        const resource = resources.get(
          snapshot.materials[submesh.materialSlot] ?? snapshot.material,
        );
        if (resource !== undefined) demand.add(resource);
      }
    } catch (cause) {
      return Promise.resolve(err(unavailable(cause)));
    }
    return new Promise((resolve) => {
      const release = () => {
        if (!this.releases.delete(release)) return;
        const pending = this.requests.delete(request);
        delete request.projection;
        request.onClose?.();
        delete request.onClose;
        signal?.removeEventListener('abort', cancel);
        clearTimeout(timeout);
        for (const resource of demand)
          this.demandMaterials = this.demandMaterials.without(resource);
        if (pending) resolve(err(unavailable('candidate preparation cancelled')));
      };
      const finish = (result: Prepared) => {
        if (!this.requests.delete(request)) return;
        clearTimeout(timeout);
        if (!result.ok) release();
        resolve(result);
      };
      const request: Request = { input, resources, materials, finish, release };
      const cancel = release;
      // A missing draw/camera or failed native compilation cannot hold source admission forever.
      const timeout = setTimeout(
        () => finish(err(unavailable('candidate raster preparation timed out'))),
        30_000,
      );
      this.requests.add(request);
      this.releases.add(release);
      for (const resource of demand) this.demandMaterials = this.demandMaterials.with(resource);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const graph = this.currentGraph();
        this.warmAttempts++;
        if (graph !== undefined && graph !== null && this.warm(request, graph, true)) {
          this.warmReady++;
          request.finish(ok(this.prepared(request, graph, true)));
        } else this.warmQueued++;
      } catch (cause) {
        request.finish(err(unavailable(cause)));
      }
    });
  }
  process(context: _InternalRenderPipelineContext, shadowViews: boolean): void {
    const graph = this.currentGraph();
    if (graph == null || this.requests.size === 0) return;
    for (const request of this.requests) {
      const { input } = request;
      if (!input.isCurrent()) {
        request.finish(err(unavailable('candidate material, mesh or device changed')));
        continue;
      }
      try {
        if (
          input.world !== undefined &&
          context.resourceScopes?.identity !== input.world.identity
        ) {
          request.finish(err(unavailable('candidate World is absent from the current view')));
          continue;
        }
        const clustered = context.standardLighting?.kind === 'clustered';
        const reflectionFallback = context.reflectionFallbackDemand === true;
        const projection = this.project(request, graph, {
          clustered,
          reflectionFallback,
          shadowViews,
          runtime: context.runtime,
        });
        request.projection = projection;
        const { entry, artifacts } = projection;
        if (artifacts.sourcePreparationPending === true) {
          delete request.projection;
          continue;
        }
        const { materials } = request;
        const state = { ...context.frameState, pipelinePreparationPending: false };
        delete state.pipelinePreparationPendingReason;
        // Accepted-scene emptiness cannot omit a newly prepared candidate's lighting program.
        delete state.standardSceneSurfaceAdmission;
        const candidateContext: _InternalRenderPipelineContext = {
          ...context,
          frameState: state,
          materialFrame: materials,
          validatedOrdered: [entry],
          pipelinePreparationEntries: [entry],
          // This material frame owns the candidate, not the current visible scene.
          shadowValidatedOrdered: [],
          gpuDrivenShadowPreparationArtifacts: artifacts.shadowMaterialArtifacts,
        };
        let matched = false;
        const prepare = () => {
          for (const prepareScene of graph.scenePipelinePreparations ?? [])
            if (
              prepareScene.kind !== 'utility' &&
              prepareScene(candidateContext, artifacts.materialArtifacts)
            )
              matched = true;
          if (matched)
            for (const prepareScene of graph.scenePipelinePreparations ?? [])
              if (prepareScene.kind === 'utility')
                prepareScene(candidateContext, artifacts.materialArtifacts);
          if (matched && shadowViews)
            prepareShadowMaterialPipelines(candidateContext, true, () => false);
        };
        if (context.runtime.withPipelinePreparationErrors === undefined) prepare();
        else context.runtime.withPipelinePreparationErrors(prepare);
        if (!matched) {
          request.finish(err(unavailable('current graph has no raster lane for this candidate')));
          continue;
        }
        if (!state.pipelinePreparationPending) {
          const recheckDemand = this.warm(request, graph);
          if (
            this.disposed ||
            !this.releases.has(request.release) ||
            !input.isCurrent() ||
            graph !== this.currentGraph()
          ) {
            request.finish(
              err(unavailable('candidate or original view changed during native preparation')),
            );
            continue;
          }
          request.finish(ok(this.prepared(request, graph, recheckDemand)));
        }
      } catch (cause) {
        request.finish(err(unavailable(cause)));
      }
    }
  }

  private project(
    request: Request,
    graph: InstalledFrameGraph,
    facts: {
      clustered: boolean;
      reflectionFallback: boolean;
      shadowViews: boolean;
      runtime: Pick<PipelineRequestRuntime, 'getMaterialShaderArtifact' | 'shaderRegistry'>;
    },
  ): NonNullable<Request['projection']> {
    const { input } = request;
    const { clustered, reflectionFallback, shadowViews, runtime } = facts;
    const { preparation } = input;
    const { resources, materials } = request;
    const shaderRegistry = runtime.shaderRegistry;
    const resolve = runtime.getMaterialShaderArtifact;
    const resourceFor = (id: number): MaterialResource => {
      const resource = resources.get(id);
      if (resource === undefined) throw new Error(`candidate material ${id} is absent`);
      return resource;
    };
    const {
      material,
      materials: materialIds,
      materialOverrides,
      ...snapshot
    } = preparation.template.snapshot;
    const base: RenderableSnapshot = {
      ...snapshot,
      material: resourceFor(material),
      materials: materialIds.map(resourceFor),
      ...(materialOverrides === undefined
        ? {}
        : {
            materialOverrides: materialOverrides.map((id) =>
              id === 0 ? undefined : resourceFor(id),
            ),
          }),
      entityKey: preparation.entity,
      transform: preparation.transform,
      authorVisible: false,
      pipelinePreparation: preparation.template.dispatch,
    };
    const source = {
      ...base,
      gpuDrivenDraws: buildGpuDrivenDraws({
        mesh: describeMeshDraw(input.asset),
        materials: base.materials.map((resource) => resource.snapshot),
        fallbackMaterial: base.material.snapshot,
        deformation: base.skinBinding === undefined ? 'rigid' : 'skin',
        ...(resolve === undefined
          ? {}
          : {
              getMaterialShaderArtifact: (id, options) =>
                shaderRegistry?.isSourceBackedMaterialArtifact(id) === true
                  ? materialRasterSourceFacts(shaderRegistry, id, options)
                  : resolve(id, options),
            }),
      }),
    };
    const entry: ValidatedRenderable = {
      source,
      mesh: input.mesh,
      renderableIndex: 0,
      meshSlot: 0,
      renderState: source.material.snapshot.renderState,
      stencilReference: undefined,
    };
    const dispatch = preparation.template.dispatch.map((pass) => ({
      ...pass,
      entityIndex: 0,
      renderableIndex: 0,
    }));
    const artifacts = collectGpuDrivenMaterialArtifacts({
      batches: eligibleGpuDrivenDraws(source),
      programs: new GpuDrivenMaterialProgramProjection().project(dispatch, materials),
      probeBlend: source.probeBlendRecord !== undefined,
      resolve,
      canAwaitSource: (id) => shaderRegistry?.isMaterialArtifactPreparationPending(id) === true,
      clustered,
      reflectionFallback,
      demand: shadowViews ? 'forward-and-shadow' : 'forward',
    });
    return {
      graph,
      clustered,
      reflectionFallback,
      shadowViews,
      entry,
      artifacts,
    };
  }

  /** A miss has no backend side effects and remains in the ordinary Record queue. */
  private warm(request: Request, graph: InstalledFrameGraph, observe = false): boolean {
    if (
      this.disposed ||
      !this.releases.has(request.release) ||
      !request.input.isCurrent() ||
      graph !== this.currentGraph()
    )
      return false;
    const passes = graph.scenePipelinePreparations;
    if (
      passes === undefined ||
      passes.length === 0 ||
      passes.some((pass) => pass.kind !== 'utility' && pass.demand === undefined) ||
      scenePassRequests(graph.graph).some((pass) => pass.capture || pass.camera !== undefined)
    ) {
      if (observe) this.unsupportedGraph++;
      return false;
    }
    const view = this.readDemand?.(request.input, request.materials);
    if (view === undefined) {
      if (observe) this.unavailableDemand++;
      return false;
    }
    // Hidden GPU preparation currently owns only its common no-clipping variant.
    // A clipped indirect view still needs its normal raster producer.
    if (view.geometry.clipping !== undefined && view.gpuDrivenGeometryLane !== 'direct')
      return false;
    return (
      this.lookupDemand(request, graph, view) &&
      view.sourceCurrent() &&
      request.input.isCurrent() &&
      graph === this.currentGraph()
    );
  }
  private lookupDemand(
    request: Request,
    graph: InstalledFrameGraph,
    view: NonNullable<ReturnType<CandidatePipelineDemandReader>>,
  ): boolean {
    const passes = graph.scenePipelinePreparations ?? [];
    const original = view.geometry.runtime;
    const lookup: PipelineRequestRuntime = {
      device: original.device,
      errorRegistry: original.errorRegistry,
      metrics: original.metrics,
      ...(original.shaderRegistry === undefined ? {} : { shaderRegistry: original.shaderRegistry }),
      ...(original.getMaterialArtifact === undefined
        ? {}
        : { getMaterialArtifact: original.getMaterialArtifact }),
      ...(original.getMaterialShaderArtifact === undefined
        ? {}
        : { getMaterialShaderArtifact: original.getMaterialShaderArtifact }),
      getMaterialShaderPipeline: view.lookup.pipeline,
      prepareMaterialShaderPipeline: view.lookup.pipeline,
      getMaterialShaderPipelineEntry: view.lookup.entry,
      prepareMaterialShaderPipelineEntry: view.lookup.entry,
    };
    const projection = this.project(request, graph, {
      clustered: view.geometry.lightingKind === 'clustered',
      reflectionFallback: view.reflectionFallbackDemand,
      shadowViews: view.hasShadowViews,
      runtime: lookup,
    });
    if (projection.artifacts.sourcePreparationPending === true) return false;
    const frameState: {
      pipelinePreparationPending?: boolean;
      pipelinePreparationPendingReason?: import('../render-contract').FramePresentationPendingReason;
    } = {};
    const context = {
      ...view.geometry,
      runtime: lookup,
      frameState,
      selectionCamera: view.selectionCamera,
      materialFrame: request.materials,
      pipelinePreparationEntries: [projection.entry],
      tonemapActive: view.tonemapActive,
      gpuDrivenGeometryLane: view.gpuDrivenGeometryLane,
      hasLocalLights: view.hasLocalLights,
      ssao: view.ssao,
      reflectionFallbackDemand: view.reflectionFallbackDemand,
      probeBlend: view.probeBlend,
    };
    let matched = false;
    for (const pass of passes) {
      if (pass.kind === 'utility') continue;
      if (pass.demand === undefined) return false;
      if (
        prepareTypedScenePipelineDemand(
          context,
          projection.artifacts.materialArtifacts,
          pass.demand,
        )
      )
        matched = true;
    }
    if (matched && view.hasShadowViews)
      prepareHiddenShadowMaterialPipelines(
        {
          runtime: lookup,
          frameState,
          materialFrame: request.materials,
          pipelinePreparationEntries: context.pipelinePreparationEntries,
          ...(view.gpuDrivenGeometryLane === undefined
            ? {}
            : { gpuDrivenGeometryLane: view.gpuDrivenGeometryLane }),
        },
        view.shadowReflections,
      );
    return matched && !frameState.pipelinePreparationPending;
  }

  private prepared(
    request: Request,
    graph: InstalledFrameGraph,
    recheckDemand = false,
  ): PreparedCandidatePipelines {
    const { input, release } = request;
    delete request.projection;
    // A replaced graph is never current again. Hold it weakly: its passes
    // capture their frame's GPU-driven projections and native plans.
    const preparedGraph = new WeakRef(graph);
    const prepared = candidatePipelineTicket(() => {
      const current = preparedGraph.deref();
      if (
        this.disposed ||
        !this.releases.has(release) ||
        current === undefined ||
        current !== this.currentGraph()
      )
        return false;
      try {
        const ready = recheckDemand ? this.warm(request, current) : input.isCurrent();
        return (
          ready && !this.disposed && this.releases.has(release) && current === this.currentGraph()
        );
      } catch {
        // A changed or incomplete demand retires this receipt; it is never ready by exception.
        return false;
      }
    }, release);
    request.onClose = prepared.close;
    return prepared.ticket;
  }

  dispose(): void {
    this.disposed = true;
    for (const release of this.releases) release();
  }
}
