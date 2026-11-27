import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import { type MeshChange, type MeshChanges, ShadowMeshReads } from '../device/mesh-changes';
import type { ShadowViewInvalidationReason } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderableSnapshot } from '../render-system-extract';
import { sparseRowsOf } from '../scene/frame-list';
import {
  type ShadowMaterialContent,
  sameShadowMaterialFrames,
} from '../scene/material-shadow-content';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import { terrainDrawSection } from '../terrain/source';
import type { ViewLights } from '../world/render-lights';
import {
  captureDirectionalMatrices,
  currentDirectionalShadowPublication,
  directionalShadowSourceChanged,
} from './directional-cascade-cadence';
import type {
  DirectionalShadowCache,
  DirectionalShadowWorldState,
  RenderFrameState,
} from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';
import { getRenderFeatureGraphState } from './typed-frame-graph';

export interface ShadowMeshInput {
  readonly reads: ShadowMeshReads;
  readonly epoch: number;
  readonly change: MeshChange;
}

export function shadowMeshInputCurrent(input: ShadowMeshInput): boolean {
  return input.reads.fixed && input.reads.changes.epoch === input.epoch;
}

/** One result of the real shadow query; quiet frames borrow its leases as a root. */
export function shadowMeshReadsForQuery(
  cached: DirectionalShadowCache | null,
  sourceScope: RenderResourceScope,
  casters: PersistentShadowCasterProjection,
  changes: MeshChanges,
  directMeshDomain?: object | null,
): ShadowMeshInput {
  const old = cached?.meshReads;
  if (
    old?.fixed &&
    old.changes === changes &&
    directMeshDomain !== null &&
    old.directMeshDomain === directMeshDomain &&
    cached?.casterContent?.owner === casters.content.owner &&
    cached.casterContent.dispatchRevision === casters.content.dispatchRevision &&
    cached.casterContent.publicationSource?.resources ===
      casters.content.publicationSource?.resources &&
    cached.sourceScope === sourceScope
  ) {
    const change = changes.query(cached.meshEpoch, old.generation, old.tokens);
    if (change !== 'invalidated') return { reads: old.retain(), epoch: changes.epoch, change };
  }
  return {
    reads: new ShadowMeshReads(changes, directMeshDomain),
    epoch: changes.epoch,
    change: 'invalidated',
  };
}

export interface DirectionalShadowCacheDecision {
  /** Why the retained directional layers cannot be reused; undefined on reuse. */
  readonly miss: ShadowViewInvalidationReason | undefined;
  readonly next: DirectionalShadowCache | null;
}

function readWorldState(lease: RenderReadLease): DirectionalShadowWorldState {
  return {
    worldIdentity: lease.worldIdentity,
    version: lease.captureVersion(),
  };
}

function sameWorldState(
  cached: DirectionalShadowCache,
  sourceScope: RenderResourceScope,
  lease: RenderReadLease | undefined,
): boolean {
  const state = cached.worldStateToken;
  if (
    lease === undefined ||
    state === undefined ||
    cached.sourceScope !== sourceScope ||
    state.worldIdentity !== lease.worldIdentity
  )
    return false;
  try {
    const changes = lease.readChanges(state.version);
    return (
      changes.version.structureEpoch === state.version.structureEpoch &&
      changes.world.changedComponentIds.length === 0
    );
  } catch {
    return false;
  }
}

// Joint poses can change without a renderable mutation. Borrow the fixed scene's
// membership, or inspect this frame's actual sources where no owner can prove it.
function hasDeformingCaster(casters: PersistentShadowCasterProjection): boolean {
  const deforming = casters.hasDeformingCaster;
  if (deforming !== undefined) return deforming;
  for (const source of sparseRowsOf(casters.renderables, 'skin'))
    if (source.skinBinding !== undefined) return true;
  return false;
}

/**
 * The same proof the GPU-driven shadow views use: unchanged persistent caster
 * content keeps the atlas even when the ECS changed elsewhere, such as a
 * camera Transform.
 */
function sameCasterContent(
  cached: DirectionalShadowCache,
  sourceScope: RenderResourceScope,
  lease: RenderReadLease | undefined,
  casters: PersistentShadowCasterProjection | undefined,
  publicationSource?: import('../scene/render-scene').ShadowPublicationSource,
): boolean {
  const previous = cached.casterContent;
  if (
    casters === undefined ||
    previous === undefined ||
    previous.owner !== casters.content.owner ||
    previous.sceneRevision !== casters.content.sceneRevision ||
    previous.dispatchRevision !== casters.content.dispatchRevision ||
    !sameShadowMaterialFrames(previous.materials, casters.content.materials) ||
    cached.sourceScope !== sourceScope
  )
    return false;
  if (publicationSource !== undefined) {
    if (previous.publicationSource?.resources !== publicationSource.resources) return false;
  } else if (lease === undefined || cached.worldStateToken?.worldIdentity !== lease.worldIdentity)
    return false;
  return !hasDeformingCaster(casters);
}

function sameTerrainShadowContent(
  previous: PersistentShadowCasterProjection['content'] | undefined,
  current: PersistentShadowCasterProjection['content'] | undefined,
): boolean {
  const before = previous?.viewDraws,
    now = current?.viewDraws;
  let i = 0,
    j = 0;
  for (;;) {
    let a: RenderableSnapshot | undefined, b: RenderableSnapshot | undefined;
    while (i < (before?.length ?? 0)) {
      a = before?.at(i++);
      if (a?.terrainSection !== undefined) break;
    }
    while (j < (now?.length ?? 0)) {
      b = now?.at(j++);
      if (b?.terrainSection !== undefined) break;
    }
    const section = a?.terrainSection,
      next = b?.terrainSection;
    if (a === undefined || b === undefined || section === undefined || next === undefined)
      return section === undefined && next === undefined;
    if (
      a.entityKey !== b.entityKey ||
      section.index !== next.index ||
      a.assetHandle !== b.assetHandle ||
      section.source.asset.columns !== next.source.asset.columns ||
      section.source.asset.rows !== next.source.asset.rows ||
      section.source.asset.spacing !== next.source.asset.spacing ||
      section.source.asset.subsectionVertices !== next.source.asset.subsectionVertices ||
      terrainDrawSection(section.source, section.index).heights !==
        terrainDrawSection(next.source, next.index).heights ||
      section.lod !== next.lod ||
      section.neighbors.length !== next.neighbors.length
    )
      return false;
    for (let edge = 0; edge < section.neighbors.length; edge++)
      if (section.neighbors[edge] !== next.neighbors[edge]) return false;
    // Terrain admits translation-only transforms.
    for (let axis = 12; axis <= 14; axis++)
      if (a.transform.world[axis] !== b.transform.world[axis]) return false;
  }
}

function sameDirectionalShadowQuality(
  previous: DirectionalShadowQuality,
  next: DirectionalShadowQuality,
): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'pcf-vogel' || previous.kind === 'pcf-soft') return true;
  if (previous.kind === 'pcf' && next.kind === 'pcf') return previous.kernel === next.kernel;
  if (previous.kind !== 'pcss' || next.kind !== 'pcss') return false;
  return (
    previous.preset === next.preset &&
    previous.angularRadiusRadians === next.angularRadiusRadians &&
    previous.maxPenumbraTexels === next.maxPenumbraTexels
  );
}

export function prepareDirectionalShadowCache(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  sourceScope: RenderResourceScope,
  lease: RenderReadLease | undefined,
  lights: ViewLights,
  shadowMapSize: number | undefined,
  mesh: ShadowMeshInput | undefined,
  casters: PersistentShadowCasterProjection | undefined,
  shadowMaterials?: readonly ShadowMaterialContent[],
  lodSelection?: object,
): DirectionalShadowCacheDecision {
  const cascadeCount = lights.cascades?.cascadeCount;
  const lightViewProj = lights.cascades?.lightViewProj;
  // GPU feature buffers can change without an ECS mesh mutation. Until a
  // producer provides a stable content revision, never reuse their shadow atlas.
  if (
    getRenderFeatureGraphState(internals).plans.some(({ plan }) =>
      plan.passes.some((pass) => pass.kind === 'shadow-caster'),
    )
  ) {
    return { miss: 'feature-draws', next: null };
  }
  if (
    frameState.compiledFrameGraph === null ||
    shadowMapSize === undefined ||
    shadowMapSize <= 0 ||
    cascadeCount === undefined ||
    cascadeCount <= 0 ||
    lightViewProj === undefined ||
    lights.cascades?.directionalShadowQuality === undefined ||
    mesh === undefined ||
    !shadowMeshInputCurrent(mesh) ||
    mesh.reads.tokens.size === 0
  ) {
    return { miss: 'uncached', next: null };
  }

  const cached = frameState.directionalShadowCache;

  const hasReadLease = lease !== undefined;
  const publicationSource =
    lights.directionalCsmConfig?.staggerCascades === true
      ? currentDirectionalShadowPublication(sourceScope, casters, cached)
      : undefined;
  if (!hasReadLease && publicationSource === undefined) {
    // No current source witness: avoid preparing a token that cannot be retained.
    return { miss: 'uncached', next: null };
  }
  const meshReads = mesh.reads;
  const cadenceSource =
    lights.directionalCsmConfig?.staggerCascades === true &&
    (hasReadLease || publicationSource !== undefined)
      ? {
          sourceScope,
          worldStateToken: lease === undefined ? undefined : readWorldState(lease),
          shadowMaterials,
          meshReads,
          lodSelection,
          casterContent: casters?.content,
        }
      : undefined;
  const matrices = captureDirectionalMatrices(lightViewProj, cached?.lightViewProj);
  const graph = frameState.compiledFrameGraph;
  const target =
    graph.directionalShadowViewCount === 'current'
      ? frameState.shadowDepthLayers?.allocation('directional-shadow-depth')
      : graph.topologyKey;
  const sourceChanged =
    cached !== null &&
    cadenceSource !== undefined &&
    (mesh.change !== 'quiet' ||
      directionalShadowSourceChanged(cached, cadenceSource) ||
      !sameTerrainShadowContent(cached.casterContent, casters?.content));
  const miss: ShadowViewInvalidationReason | undefined =
    cached === null
      ? 'first-publication'
      : cached.shadowMapSize !== shadowMapSize ||
          cached.cascadeCount !== cascadeCount ||
          !sameDirectionalShadowQuality(
            cached.directionalShadowQuality,
            lights.cascades?.directionalShadowQuality,
          ) ||
          cached.pipelineHandle !== frameState.installedPipelineHandle ||
          target === undefined ||
          cached.depthTarget !== target
        ? 'configuration-changed'
        : sourceChanged
          ? 'source-changed'
          : !sameShadowMaterialFrames(
                cached.casterContent?.materials,
                casters?.content.materials,
              ) ||
              !(shadowMaterials === undefined
                ? cached.shadowMaterials === undefined
                : shadowMaterials.length === cached.shadowMaterials?.length &&
                  shadowMaterials.every((content, index) =>
                    content.same(cached.shadowMaterials?.[index]),
                  )) ||
              mesh.change !== 'quiet' ||
              cached.meshReads !== meshReads ||
              cached.lodSelection !== lodSelection ||
              (cadenceSource === undefined &&
                !sameTerrainShadowContent(cached.casterContent, casters?.content)) ||
              !(
                sameWorldState(cached, sourceScope, lease) ||
                sameCasterContent(cached, sourceScope, lease, casters, publicationSource)
              )
            ? 'content-changed'
            : matrices !== cached.lightViewProj
              ? 'view-changed'
              : undefined;
  if (miss === undefined)
    return {
      miss: undefined,
      // Unrelated publications advance only after this hit actually submits.
      next:
        cached !== null && cached.meshEpoch !== mesh.epoch
          ? { ...cached, meshEpoch: mesh.epoch }
          : null,
    };

  const worldStateToken =
    cadenceSource?.worldStateToken ?? (lease === undefined ? undefined : readWorldState(lease));

  return {
    miss,
    next: {
      sourceScope,
      worldStateToken,
      shadowMaterials,
      pipelineHandle: frameState.installedPipelineHandle,
      depthTarget: target,
      shadowMapSize,
      cascadeCount,
      directionalShadowQuality: lights.cascades?.directionalShadowQuality,
      lightViewProj: matrices,
      meshReads,
      meshEpoch: mesh.epoch,
      lodSelection,
      casterContent: casters?.content,
    },
  };
}
