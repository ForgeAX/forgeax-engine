import type { World } from '@forgeax/engine-ecs';
import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
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
import type { InstalledFrameGraph, ValidatedRenderable } from './frame-snapshot';
import type { _InternalRenderPipelineContext } from './render-context';
import { prepareShadowMaterialPipelines } from './shadow-pass';

export interface CandidatePipelineInput {
  readonly preparation: MeshPipelinePreparation;
  readonly world?: World;
  readonly mesh: MeshGpuHandles;
  readonly asset: MeshAsset;
  readonly isCurrent: () => boolean;
}

export interface PreparedCandidatePipelines {
  isCurrent(): boolean;
}

type Prepared = Result<PreparedCandidatePipelines, DynamicGeometryError>;
type Request = {
  readonly input: CandidatePipelineInput;
  projection?: {
    readonly graph: InstalledFrameGraph;
    readonly worldId: number;
    readonly clustered: boolean;
    readonly reflectionFallback: boolean;
    readonly shadowViews: boolean;
    readonly entry: ValidatedRenderable;
    readonly materials: MaterialFrame;
    readonly artifacts: ReturnType<typeof collectGpuDrivenMaterialArtifacts>;
  };
  finish(result: Prepared): void;
};

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
  private disposed = false;

  constructor(private readonly currentGraph: () => InstalledFrameGraph | null | undefined) {}

  prepare(input: CandidatePipelineInput, signal?: AbortSignal): Promise<Prepared> {
    if (this.disposed || signal?.aborted || !input.isCurrent())
      return Promise.resolve(err(unavailable('cancelled or retired candidate')));
    if (this.currentGraph() == null)
      return Promise.resolve(err(unavailable('no current view graph')));
    return new Promise((resolve) => {
      const finish = (result: Prepared) => {
        if (!this.requests.delete(request)) return;
        signal?.removeEventListener('abort', cancel);
        clearTimeout(timeout);
        resolve(result);
      };
      const request: Request = { input, finish };
      const cancel = () => finish(err(unavailable('candidate preparation cancelled')));
      // A missing draw/camera or failed native compilation cannot hold source admission forever.
      const timeout = setTimeout(
        () => finish(err(unavailable('candidate raster preparation timed out'))),
        30_000,
      );
      this.requests.add(request);
      signal?.addEventListener('abort', cancel, { once: true });
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
        const worldId =
          input.world === undefined
            ? 0
            : (context.resourceScopes?.findIndex(
                (scope) => scope.identity === input.world?.identity,
              ) ?? -1);
        if (worldId < 0) {
          request.finish(err(unavailable('candidate World is absent from the current view')));
          continue;
        }
        const clustered =
          context.standardLighting?.kind === 'clustered' &&
          (context.standardLighting.prepared.local.length > 0 ||
            context.frameState.installedPipelineConfig?.ssao?.enabled === true);
        const reflectionFallback = context.frameState.reflectionFallbackDemand === true;
        let projection = request.projection;
        if (
          projection === undefined ||
          projection.graph !== graph ||
          projection.worldId !== worldId ||
          projection.clustered !== clustered ||
          projection.reflectionFallback !== reflectionFallback ||
          projection.shadowViews !== shadowViews
        ) {
          const { preparation } = input;
          const resources = new Map<number, MaterialResource>();
          let materials = new MaterialFrame(undefined);
          for (const row of preparation.materials) {
            const resource = new MaterialResource(row.value);
            resources.set(row.id, resource);
            materials = materials.with(resource);
          }
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
            worldId,
            transform: preparation.transform,
            authorVisible: false,
            pipelinePreparation: preparation.template.dispatch,
          };
          const source = {
            ...base,
            gpuDrivenDraws: buildGpuDrivenDraws({
              mesh: input.asset,
              materials: base.materials.map((resource) => resource.snapshot),
              fallbackMaterial: base.material.snapshot,
              deformation: base.skin === undefined ? 'rigid' : 'skin',
              ...(context.runtime.getMaterialShaderArtifact === undefined
                ? {}
                : { getMaterialShaderArtifact: context.runtime.getMaterialShaderArtifact }),
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
            resolve: context.runtime.getMaterialShaderArtifact,
            clustered,
            reflectionFallback,
            shadowViews,
          });
          projection = request.projection = {
            graph,
            worldId,
            clustered,
            reflectionFallback,
            shadowViews,
            entry,
            materials,
            artifacts,
          };
        }
        const { entry, artifacts, materials } = projection;
        const state = { ...context.frameState, pipelinePreparationPending: false };
        delete state.pipelinePreparationPendingReason;
        const candidateContext: _InternalRenderPipelineContext = {
          ...context,
          frameState: state,
          materialFrame: materials,
          pipelinePreparationEntries: [entry],
          gpuDrivenShadowPreparationArtifacts: artifacts.shadowMaterialArtifacts,
        };
        let matched = false;
        const prepare = () => {
          for (const prepareScene of graph.scenePipelinePreparations ?? [])
            if (prepareScene(candidateContext, artifacts.materialArtifacts)) matched = true;
          if (matched && shadowViews)
            prepareShadowMaterialPipelines(candidateContext, true, () => false);
        };
        if (context.runtime.withPipelinePreparationErrors === undefined) prepare();
        else context.runtime.withPipelinePreparationErrors(prepare);
        if (!matched) {
          request.finish(err(unavailable('current graph has no raster lane for this candidate')));
          continue;
        }
        if (!state.pipelinePreparationPending)
          request.finish(
            ok({
              isCurrent: () => !this.disposed && input.isCurrent(),
            }),
          );
      } catch (cause) {
        request.finish(err(unavailable(cause)));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) request.finish(err(unavailable('view retired')));
  }
}
