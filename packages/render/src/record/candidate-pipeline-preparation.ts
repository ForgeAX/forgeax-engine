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
  release(): void;
}

type Prepared = Result<PreparedCandidatePipelines, DynamicGeometryError>;
type Request = {
  readonly input: CandidatePipelineInput;
  readonly resources: ReadonlyMap<number, MaterialResource>;
  readonly materials: MaterialFrame;
  projection?: {
    readonly graph: InstalledFrameGraph;
    readonly worldId: number;
    readonly clustered: boolean;
    readonly reflectionFallback: boolean;
    readonly shadowViews: boolean;
    readonly entry: ValidatedRenderable;
    readonly artifacts: ReturnType<typeof collectGpuDrivenMaterialArtifacts>;
  };
  finish(result: Prepared): void;
  release(): void;
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
  private readonly releases = new Set<() => void>();
  private disposed = false;
  private demandMaterials = new MaterialFrame(undefined);

  /** Preparation demand builds real graph lanes without accepting any scene draw. */
  get materials(): MaterialFrame {
    return this.demandMaterials;
  }

  constructor(private readonly currentGraph: () => InstalledFrameGraph | null | undefined) {}

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
          const { resources, materials } = request;
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
              deformation: base.skinBinding === undefined ? 'rigid' : 'skin',
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
            artifacts,
          };
        }
        const { entry, artifacts } = projection;
        const { materials } = request;
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
              isCurrent: () =>
                !this.disposed &&
                this.releases.has(request.release) &&
                request.projection?.graph === this.currentGraph() &&
                input.isCurrent(),
              release: request.release,
            }),
          );
      } catch (cause) {
        request.finish(err(unavailable(cause)));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const release of this.releases) release();
  }
}
