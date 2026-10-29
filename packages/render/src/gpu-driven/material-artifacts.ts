import type { TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { isTriangleTopology } from '@forgeax/engine-types';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { transformRenderState } from '../material-render-state';
import type { MaterialResource } from '../material-resource';
import { SKIN_UNCOVERED_GBUFFER_ENTRY } from '../pbr-pipeline';
import { captureDispatchOverlays, type DispatchOverlays } from '../record/dispatch-overlays';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import { isMediumMaterial } from '../record/material-pass-selection';
import type { RenderSystemInternals } from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { FramePresentationPendingReason } from '../render-contract';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type { DispatchList, MaterialSnapshot } from '../render-system-extract';
import { GenerationalWeakMap } from '../scene/generational-weak-map';
import type { AcceptedMaterial, MaterialDispatchPass } from '../scene/material-dispatch';
import { MaterialFrame } from '../scene/material-dispatch';
import { capturedPreparedMaterialArtifactKey, type PreparedGpuDrivenDraw } from './prepared-draw';
import { lodCoverageMayFade } from './production-raster-lod';
import {
  requestMaterialAbiRasterPipeline,
  standardSurfaceDiscardMask,
} from './production-raster-material';

type MaterialPrograms = {
  readonly materialHandle: number;
  readonly forward: readonly MaterialDispatchPass[];
  readonly shadow: readonly MaterialDispatchPass[];
};

import {
  type BatchArtifactResolver,
  type BatchExecution,
  type BatchPass,
  prepareBatchExecution,
} from './batch-execution';
import {
  eligibleGpuDrivenDraws,
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
} from './batch-topology';

const NO_EXECUTION: BatchExecution = Object.freeze({ route: 'none' });

export interface BatchExecutions {
  readonly forward: BatchExecution;
  readonly shadow: BatchExecution;
}

interface MaterialProgramSelection {
  logicalMaterialShaderId: string;
  sceneIndexProgramKey: string | undefined;
  materialShaderId: string;
}

/** Select the direct/scene program pair published for this concrete pass. */
export function gpuDrivenMaterialProgramSelection(
  material: MaterialSnapshot,
  prepared: PreparedGpuDrivenDraw,
  pass: 'forward' | 'shadow',
  shadowEntry: { readonly materialShaderId?: string | undefined } | undefined,
  out: MaterialProgramSelection,
) {
  const logicalMaterialShaderId = material.materialShaderId ?? prepared.identity.material;
  const sceneIndexProgramKeys = material.materialSceneIndexProgramKeys;
  const shadowMaterialShaderId = pass === 'shadow' ? shadowEntry?.materialShaderId : undefined;
  const directMaterialShaderId =
    pass === 'shadow' ? shadowMaterialShaderId : logicalMaterialShaderId;
  let sceneIndexProgramKey: string | undefined;
  for (const passName in sceneIndexProgramKeys) {
    const program = sceneIndexProgramKeys[passName];
    if (
      program?.pass === pass &&
      directMaterialShaderId !== undefined &&
      material.materialProgramKeys?.[passName] === directMaterialShaderId
    ) {
      sceneIndexProgramKey = program.specializationKey;
      break;
    }
  }
  if (sceneIndexProgramKeys !== undefined && sceneIndexProgramKey === undefined) return undefined;
  const materialShaderId =
    pass === 'shadow'
      ? (sceneIndexProgramKey ?? shadowEntry?.materialShaderId ?? logicalMaterialShaderId)
      : (sceneIndexProgramKey ?? logicalMaterialShaderId);
  out.logicalMaterialShaderId = logicalMaterialShaderId;
  out.sceneIndexProgramKey = sceneIndexProgramKey;
  out.materialShaderId = materialShaderId;
  return out;
}

export interface GpuDrivenMaterialProgramIndex {
  readonly dispatch: DispatchList;
  readonly materials: MaterialFrame;
  get(
    material: MaterialResource,
  ): (MaterialPrograms & { readonly snapshot: MaterialSnapshot }) | undefined;
  readonly overlays: DispatchOverlays;
}

// Accepted versions are replaced as materials change; see GenerationalWeakMap.
const sharedProgramSelections = new GenerationalWeakMap<
  AcceptedMaterial,
  MaterialPrograms & { readonly snapshot: MaterialSnapshot }
>();

/** The program index reads fixed shared material roots, without expanding dispatch members. */
export class GpuDrivenMaterialProgramProjection {
  private current: GpuDrivenMaterialProgramIndex | undefined;
  project(dispatch: DispatchList, materials: MaterialFrame): GpuDrivenMaterialProgramIndex {
    if (this.current?.dispatch === dispatch && this.current.materials === materials)
      return this.current;
    let overlays: DispatchOverlays | undefined;
    this.current = {
      dispatch,
      materials,
      get(material) {
        const accepted = materials.get(material);
        if (accepted === undefined) return undefined;
        let programs = sharedProgramSelections.get(accepted);
        if (programs !== undefined) return programs;
        const forward: MaterialDispatchPass[] = [];
        const shadow: MaterialDispatchPass[] = [];
        programs = {
          snapshot: accepted.snapshot,
          materialHandle: accepted.snapshot.materialHandle ?? -1,
          forward,
          shadow,
        };
        for (const pass of accepted.passes) {
          if (pass.materialShaderId === undefined) continue;
          if (pass.tags.LightMode === 'ShadowCaster') shadow.push(pass);
          // Medium work owns its nearest/color passes independently of the
          // ordinary Forward selector, including an authored untagged color Pass.
          else if (pass.tags.LightMode === 'Forward' || isMediumMaterial(accepted.snapshot))
            forward.push(pass);
        }
        Object.freeze(forward);
        Object.freeze(shadow);
        sharedProgramSelections.set(accepted, programs);
        return programs;
      },
      get overlays() {
        overlays ??= captureDispatchOverlays(dispatch);
        return overlays;
      },
    };
    return this.current;
  }
  clear(): void {
    this.current = undefined;
  }
}

interface MaterialArtifactRead {
  readonly shader: string;
  readonly request: Parameters<BatchArtifactResolver>[1];
  readonly artifact: MaterialShaderArtifact | undefined;
}

interface RetainedBatchExecution {
  readonly snapshot: MaterialSnapshot;
  readonly passes: readonly MaterialDispatchPass[];
  readonly geometry: GpuDrivenBatchBinding['geometry'];
  readonly reads: readonly MaterialArtifactRead[];
  readonly execution: BatchExecution;
}

/**
 * Renderer-lifetime execution joins. An execution is a pure function of its
 * accepted snapshot, selected Pass entries, geometry and resolved artifacts, so
 * pose-only frames reuse it while every artifact it read still resolves
 * identically. Accepted wrappers are re-projected per frame; their snapshot and
 * Pass entries keep identity across parameter-free frames.
 */
export class GpuDrivenMaterialExecutionRetention {
  private readonly entries = {
    forward: new WeakMap<GpuDrivenBatchBinding, RetainedBatchExecution>(),
    shadow: new WeakMap<GpuDrivenBatchBinding, RetainedBatchExecution>(),
  };
  reused = 0;
  prepared = 0;
  /** Last collected frame; an identical join keeps its identity for downstream caches. */
  last: CollectedMaterialArtifacts | undefined;
  /**
   * Inputs of the last complete join. A collection is a pure function of its
   * batch roster, accepted programs, frame flags and the artifacts its distinct
   * reads resolved, so identical inputs return the last join without visiting a batch.
   */
  lastInputs:
    | {
        readonly batches: object;
        readonly programs: object | undefined;
        readonly flags: number;
        readonly reads: readonly MaterialArtifactRead[];
        readonly collected: CollectedMaterialArtifacts;
      }
    | undefined;
  get(
    kind: 'forward' | 'shadow',
    binding: GpuDrivenBatchBinding,
    programs: MaterialPrograms & { readonly snapshot: MaterialSnapshot },
    resolve: BatchArtifactResolver,
  ): BatchExecution | undefined {
    const entry = this.entries[kind].get(binding);
    const passes = programs[kind];
    if (
      entry === undefined ||
      entry.snapshot !== programs.snapshot ||
      entry.geometry !== binding.geometry ||
      entry.passes.length !== passes.length
    )
      return undefined;
    for (let index = 0; index < passes.length; index++)
      if (entry.passes[index] !== passes[index]) return undefined;
    for (const read of entry.reads)
      if (resolve(read.shader, read.request) !== read.artifact) return undefined;
    this.reused++;
    return entry.execution;
  }
  set(kind: 'forward' | 'shadow', binding: GpuDrivenBatchBinding, entry: RetainedBatchExecution) {
    this.prepared++;
    this.entries[kind].set(binding, entry);
  }
}

/** Each renderer's artifact resolver owns one retention; recovery installs a new resolver. */
const resolverRetention = new WeakMap<object, GpuDrivenMaterialExecutionRetention>();

/** Resolve shared geometry/material/Pass executions without inspecting batch members. */
export function collectGpuDrivenMaterialArtifacts({
  batches,
  resolve,
  clustered,
  reflectionFallback,
  probeBlend,
  shadowViews,
  programs,
  retention = resolve === undefined ? undefined : resolverRetention.get(resolve),
}: {
  readonly batches: Iterable<Pick<GpuDrivenBatch, 'binding'>>;
  readonly resolve: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly clustered: boolean;
  readonly reflectionFallback: boolean;
  readonly probeBlend: boolean;
  readonly shadowViews: boolean;
  readonly programs: GpuDrivenMaterialProgramIndex | undefined;
  readonly retention?: GpuDrivenMaterialExecutionRetention;
}): CollectedMaterialArtifacts {
  if (retention === undefined && resolve !== undefined) {
    retention = new GpuDrivenMaterialExecutionRetention();
    resolverRetention.set(resolve, retention);
  }
  const flags =
    (clustered ? 1 : 0) |
    (reflectionFallback ? 2 : 0) |
    (probeBlend ? 4 : 0) |
    (shadowViews ? 8 : 0);
  const retainedInputs = retention?.lastInputs;
  // With the same accepted programs, flags and artifact resolutions, every
  // binding of the last join keeps its execution; only new bindings join.
  const retainedJoin =
    retention !== undefined &&
    retainedInputs !== undefined &&
    retainedInputs.collected === retention.last &&
    retainedInputs.programs === programs &&
    retainedInputs.flags === flags &&
    retainedInputs.reads.every((read) => resolve?.(read.shader, read.request) === read.artifact)
      ? retainedInputs
      : undefined;
  if (retainedJoin?.batches === batches) return retainedJoin.collected;
  const distinctReads: MaterialArtifactRead[] = [...(retainedJoin?.reads ?? [])];
  const materialArtifacts = new Map<string, MaterialShaderArtifact>();
  const shadowMaterialArtifacts = new Map<string, MaterialShaderArtifact>();
  const batchExecutions = new Map<GpuDrivenBatchBinding, BatchExecutions>();
  const selectedArtifacts = new Map<string, Map<string, MaterialShaderArtifact | undefined>>();
  let firstSkinArtifact: MaterialShaderArtifact | undefined;
  for (const read of distinctReads) {
    let variants = selectedArtifacts.get(read.shader);
    if (variants === undefined) {
      variants = new Map();
      selectedArtifacts.set(read.shader, variants);
    }
    const { pass, deformation, vertexColorAvailable } = read.request;
    variants.set(`${pass}/${deformation}/${vertexColorAvailable}`, read.artifact);
  }
  const selectArtifact: BatchArtifactResolver = (shader, request) => {
    let variants = selectedArtifacts.get(shader);
    if (variants === undefined) {
      variants = new Map();
      selectedArtifacts.set(shader, variants);
    }
    // This resolver's address is always scene-index; the other request fields vary.
    const key = `${request.pass}/${request.deformation}/${request.vertexColorAvailable}`;
    if (!variants.has(key)) {
      const resolved = {
        ...request,
        ...(request.pass === 'forward' ? { clustered, probeBlend, reflectionFallback } : {}),
      };
      const artifact = resolve?.(shader, resolved);
      variants.set(key, artifact);
      distinctReads.push({ shader, request: resolved, artifact });
    }
    return variants.get(key);
  };
  const select = (
    material: MaterialSnapshot,
    entry: MaterialDispatchPass | undefined,
    kind: 'forward' | 'shadow',
  ): BatchPass | undefined => {
    if (entry?.materialShaderId === undefined) return undefined;
    const shaderId = entry.materialShaderId;
    let sceneIndexProgramKey: string | undefined;
    for (const name in material.materialSceneIndexProgramKeys) {
      const program = material.materialSceneIndexProgramKeys[name];
      if (program?.pass === kind && material.materialProgramKeys?.[name] === shaderId) {
        sceneIndexProgramKey = program.specializationKey;
        break;
      }
    }
    return {
      kind,
      shaderId,
      ...(sceneIndexProgramKey === undefined ? {} : { sceneIndexProgramKey }),
      ...(entry.renderState === undefined ? {} : { renderState: entry.renderState }),
      queue: entry.queue,
      ...(entry.vertexEntry === undefined ? {} : { vertexEntry: entry.vertexEntry }),
      ...(entry.fragmentEntry === undefined ? {} : { fragmentEntry: entry.fragmentEntry }),
    };
  };
  for (const batch of batches) {
    const binding = batch.binding;
    if (binding === undefined)
      throw new GpuDrivenPreparationError('missing-material-receipt', {
        reason: 'material-receipt-missing',
        owner: 'material',
        expected: 'a geometry and material binding from the scene owner',
      });
    const accepted = programs?.get(binding.material);
    if (accepted === undefined)
      throw new GpuDrivenPreparationError('missing-material-receipt', {
        reason: 'material-receipt-missing',
        owner: 'material',
        expected: 'a fixed material version from the scene owner',
      });
    const prepare = (kind: 'forward' | 'shadow'): BatchExecution => {
      if (kind === 'shadow' && !isTriangleTopology(binding.geometry.draw.topology))
        return NO_EXECUTION;
      const reused = retention?.get(kind, binding, accepted, selectArtifact);
      if (reused !== undefined) return reused;
      if (retention === undefined) return join(kind, selectArtifact);
      const reads: MaterialArtifactRead[] = [];
      const execution = join(kind, (shader, request) => {
        const artifact = selectArtifact(shader, request);
        reads.push({ shader, request, artifact });
        return artifact;
      });
      retention.set(kind, binding, {
        snapshot: accepted.snapshot,
        passes: accepted[kind],
        geometry: binding.geometry,
        reads,
        execution,
      });
      return execution;
    };
    const join = (
      kind: 'forward' | 'shadow',
      selectArtifact: BatchArtifactResolver,
    ): BatchExecution => {
      const passes = accepted[kind];
      const pass = select(accepted.snapshot, passes[0], kind);
      if (passes.length > 1 && pass !== undefined)
        return { route: 'direct', material: accepted.snapshot, pass };
      if (
        pass !== undefined &&
        accepted.snapshot.materialSceneIndexProgramKeys !== undefined &&
        pass.sceneIndexProgramKey === undefined
      )
        return { route: 'direct', material: accepted.snapshot, pass };
      const execution = prepareBatchExecution(
        binding.geometry,
        accepted.snapshot,
        pass,
        selectArtifact,
      );
      if (!execution.ok) {
        if (execution.error.detail.recovery !== 'route-cpu-lane' || pass === undefined)
          throw execution.error;
        return { route: 'direct', material: accepted.snapshot, pass, reason: execution.error };
      }
      // A morph batch needs a vertex stage that reads the GPU Scene morph rows.
      if (
        binding.morph === true &&
        execution.value.route === 'gpu' &&
        !readsSceneMorphInputs(execution.value.artifact)
      )
        return { route: 'direct', material: accepted.snapshot, pass: execution.value.pass };
      return execution.value;
    };
    const reused = retainedJoin?.collected.batchExecutions.get(binding);
    const forward = reused?.forward ?? prepare('forward');
    const shadow: BatchExecution =
      reused?.shadow ?? (shadowViews ? prepare('shadow') : NO_EXECUTION);
    batchExecutions.set(binding, { forward, shadow });
    const forwardKey =
      forward.route === 'gpu' ? capturedPreparedMaterialArtifactKey(forward.prepared) : undefined;
    if (forward.route === 'gpu' && forwardKey !== undefined) {
      materialArtifacts.set(forwardKey, forward.artifact);
      // Admission already proved this pass consumes paired Skin vertex inputs.
      // Selecting its task layout does not rescan immutable program contracts.
      if (firstSkinArtifact === undefined && forward.prepared.identity.deformation === 'skin')
        firstSkinArtifact = forward.artifact;
    }
    if (shadow.route === 'gpu') {
      const key = capturedPreparedMaterialArtifactKey(shadow.prepared);
      if (key !== undefined) shadowMaterialArtifacts.set(key, shadow.artifact);
    }
  }
  const firstArtifact = materialArtifacts.values().next().value;
  const collected = {
    materialArtifacts,
    shadowMaterialArtifacts,
    firstArtifact,
    firstSkinArtifact,
    batchExecutions,
  };
  if (retention === undefined) return collected;
  const last = retention.last;
  let published: CollectedMaterialArtifacts = collected;
  if (
    last !== undefined &&
    sameOrderedEntries(last.batchExecutions, batchExecutions, sameBatchExecutions) &&
    sameOrderedEntries(last.materialArtifacts, materialArtifacts, Object.is) &&
    sameOrderedEntries(last.shadowMaterialArtifacts, shadowMaterialArtifacts, Object.is)
  )
    published = last;
  retention.last = published;
  retention.lastInputs = {
    batches,
    programs,
    flags,
    reads: distinctReads,
    collected: published,
  };
  return published;
}

export interface CollectedMaterialArtifacts {
  readonly materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact>;
  readonly shadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact>;
  readonly firstArtifact: MaterialShaderArtifact | undefined;
  readonly firstSkinArtifact: MaterialShaderArtifact | undefined;
  readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
}

function sameBatchExecutions(left: BatchExecutions, right: BatchExecutions): boolean {
  return left.forward === right.forward && left.shadow === right.shadow;
}

function sameOrderedEntries<K, V>(
  left: ReadonlyMap<K, V>,
  right: ReadonlyMap<K, V>,
  same: (left: V, right: V) => boolean,
): boolean {
  if (left.size !== right.size) return false;
  const other = right.entries();
  for (const [key, value] of left) {
    const next = other.next();
    if (next.done === true || next.value[0] !== key || !same(value, next.value[1])) return false;
  }
  return true;
}

/** Explicit candidate rows use the same geometry/material join as retained scene batches. */
export function* prepareHiddenMaterialExecutions(
  entry: ValidatedRenderable,
  materials: MaterialFrame | undefined,
  pass: 'forward' | 'shadow',
  resolve: RenderSystemInternals['getMaterialShaderArtifact'],
) {
  const draws = eligibleGpuDrivenDraws(entry.source);
  if (draws.length === 0) return;
  let fixed = materials;
  if (fixed === undefined) {
    fixed = new MaterialFrame(undefined);
    for (const draw of draws) fixed = fixed.with(draw.binding.material);
  }
  const programs = new GpuDrivenMaterialProgramProjection().project([], fixed);
  const collected = collectGpuDrivenMaterialArtifacts({
    batches: draws,
    resolve,
    programs,
    clustered: false,
    reflectionFallback: false,
    probeBlend: false,
    shadowViews: pass === 'shadow',
  });
  for (const draw of draws) {
    const execution = collected.batchExecutions.get(draw.binding)?.[pass];
    if (execution !== undefined) yield { draw, execution };
  }
}
/** Only explicitly requested hidden rows; admission and PSO specification are shared with real raster. */
export function prepareHiddenGpuDrivenPipelines(input: {
  readonly entries: readonly ValidatedRenderable[];
  readonly materials?: MaterialFrame | undefined;
  readonly resolve?: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  readonly factory: NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;
  readonly formats: readonly TextureFormat[];
  readonly sampleCount: 1 | 4;
  readonly shaderUvSetCount: number;
  readonly filter: RenderPipelineGpuDrivenFilter | undefined;
  readonly fragmentEntry: string | undefined;
  readonly coverageOnly: boolean;
  readonly visibleSurface: boolean;
  /** The recording view carries camera clipping planes; absent keeps them off. */
  readonly viewClipping?: boolean;
  /** The same admitted source draw belongs to this pass's indirect lane. */
  readonly onSelected?: (entry: ValidatedRenderable, sourceDrawIndex: number) => void;
  readonly onPending?: (reason: FramePresentationPendingReason) => void;
}): boolean {
  let ready = true;
  for (const entry of input.entries) {
    if (entry.source.authorVisible !== false) continue;
    for (const { draw, execution } of prepareHiddenMaterialExecutions(
      entry,
      input.materials,
      'forward',
      input.resolve,
    )) {
      if (execution.route !== 'gpu') continue;
      const { prepared, material, artifact } = execution;
      const medium = artifact.receipt?.surface?.model === 'single-layer-medium',
        filter = input.filter;
      if (
        (filter === 'single-layer-medium' && !medium) ||
        ((filter === 'opaque' ||
          filter === 'deferred-opaque' ||
          filter === 'forward-only-opaque') &&
          medium) ||
        (filter === 'deferred-opaque' && material.deferredPass !== true) ||
        (filter === 'forward-only-opaque' && material.deferredPass === true)
      )
        continue;
      input.onSelected?.(entry, draw.sourceDrawIndex);
      const fragment =
        input.fragmentEntry === 'fs_gbuffer' &&
        prepared.identity.deformation === 'skin' &&
        input.visibleSurface
          ? SKIN_UNCOVERED_GBUFFER_ENTRY
          : input.fragmentEntry;
      const selectedArtifact =
        fragment === undefined
          ? artifact
          : {
              ...artifact,
              fragmentEntry: fragment,
              ...(fragment === 'fs_temporal' ? { vertexEntry: 'vs_temporal' } : {}),
              ...(input.coverageOnly
                ? { variantSet: variantSetForCoveragePass(artifact.variantSet, true) ?? '' }
                : {}),
            };
      const request = requestMaterialAbiRasterPipeline(input.factory, {
        artifact: selectedArtifact,
        deformation: prepared.identity.deformation,
        format: input.formats[0] ?? 'rgba16float',
        sampleCount: input.sampleCount,
        layoutProjection: entry.mesh.layoutProjection,
        shaderUvSetCount: input.shaderUvSetCount,
        topology: draw.key.topology,
        stripIndexFormat:
          draw.key.drawKind === 'indexed' &&
          (draw.key.topology === 'triangle-strip' || draw.key.topology === 'line-strip')
            ? entry.mesh.indexFormat
            : undefined,
        renderState: transformRenderState(
          fragment === 'fs_temporal'
            ? geometryRenderStateForPass(material.renderState, 'temporal', input.coverageOnly)
            : material.renderState,
          entry.source.transform.world,
        ),
        additionalColorFormats: input.formats.slice(1),
        standardTextureMask: material.standardTextureMask,
        // Same facts as the raster class: source LOD capability and view clipping.
        standardSurfaceDiscards: standardSurfaceDiscardMask(
          lodCoverageMayFade({ prepared, ...(draw.lod === undefined ? {} : { lod: draw.lod }) }),
          input.viewClipping === true,
        ),
        forwardColorPass: fragment === undefined || fragment === STANDARD_OPAQUE_FRAGMENT_ENTRY,
      });
      if (request === null) {
        ready = false;
        input.onPending?.({
          code: 'scene-pipeline-preparation',
          worldId: entry.source.worldId,
          entity: entry.source.entityKey,
          pass: (fragment ?? input.filter ?? 'forward').slice(0, 256),
          shader: selectedArtifact.material.slice(0, 256),
        });
      }
    }
  }
  return ready;
}

/** Reflection fact: the selected scene-index vertex entry reads @group(3) @binding(8). */
function readsSceneMorphInputs(artifact: MaterialShaderArtifact): boolean {
  const entry =
    artifact.fragmentEntry === 'fs_temporal' ? 'vs_temporal' : artifact.receipt?.sceneIndexEntry;
  const reads = artifact.program.entryPoints?.find(
    (point) => point.stage === 'vertex' && point.name === entry,
  );
  return reads?.bindings.some((read) => read.group === 3 && read.binding === 8) === true;
}
