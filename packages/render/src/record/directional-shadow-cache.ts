import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import type { ShadowViewInvalidationReason } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { ExtractedLights, RenderableSnapshot } from '../render-system-extract';
import { renderableDrawKey } from '../scene/draw-key';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import {
  currentDirectionalShadowPublication,
  directionalShadowSourceChanged,
} from './directional-cascade-cadence';
import type {
  DirectionalShadowCache,
  DirectionalShadowWorldState,
  RenderFrameState,
  ValidatedRenderable,
} from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';
import { getRenderFeatureGraphState } from './typed-frame-graph';

interface DirectionalShadowCacheDecision {
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
  worlds: readonly RenderResourceScope[],
  leases: readonly RenderReadLease[] | undefined,
): boolean {
  if (leases === undefined || leases.length !== worlds.length) return false;
  if (cached.worlds.length !== worlds.length || cached.worldStateTokens.length !== leases.length) {
    return false;
  }
  for (let index = 0; index < worlds.length; index += 1) {
    const world = worlds[index];
    const lease = leases[index];
    if (world === undefined || lease === undefined || cached.worlds[index] !== world) return false;
    const cachedState = cached.worldStateTokens[index];
    if (cachedState === undefined) return false;
    if (cachedState.worldIdentity !== lease.worldIdentity) return false;
    let changes: ReturnType<RenderReadLease['readChanges']>;
    try {
      changes = lease.readChanges(cachedState.version);
    } catch {
      // Treat malformed or foreign version evidence as stale and rebuild the
      // atlas rather than reaching through RenderResourceScope for a second mutation clock.
      return false;
    }
    if (
      changes.version.structureEpoch !== cachedState.version.structureEpoch ||
      changes.world.changedComponentIds.length !== 0
    ) {
      return false;
    }
  }
  return true;
}

const deformingCasterMemo = new WeakMap<readonly RenderableSnapshot[], boolean>();

// Receiver-resolved skin poses read joint Transforms that no renderable
// snapshot carries, so the scene revision cannot prove their depth unchanged.
function hasDeformingCaster(renderables: readonly RenderableSnapshot[]): boolean {
  let deforming = deformingCasterMemo.get(renderables);
  if (deforming === undefined) {
    deforming = renderables.some(
      (source) =>
        source.skin !== undefined ||
        source.skinPose !== undefined ||
        source.skinJointEntities !== undefined,
    );
    deformingCasterMemo.set(renderables, deforming);
  }
  return deforming;
}

/**
 * The same proof the GPU-driven shadow views use: unchanged persistent caster
 * content keeps the atlas even when the ECS changed elsewhere, such as a
 * camera Transform.
 */
function sameCasterContent(
  cached: DirectionalShadowCache,
  worlds: readonly RenderResourceScope[],
  leases: readonly RenderReadLease[] | undefined,
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
    cached.worlds.length !== worlds.length
  ) {
    return false;
  }
  for (let index = 0; index < worlds.length; index += 1) {
    if (cached.worlds[index] !== worlds[index]) return false;
  }
  if (publicationSource !== undefined) {
    if (previous.publicationSource?.resources !== publicationSource.resources) return false;
    return !hasDeformingCaster(casters.renderables);
  }
  if (leases === undefined || leases.length !== worlds.length) return false;
  for (let index = 0; index < worlds.length; index += 1) {
    if (cached.worldStateTokens[index]?.worldIdentity !== leases[index]?.worldIdentity) {
      return false;
    }
  }
  return !hasDeformingCaster(casters.renderables);
}

function sameTerrainShadowContent(
  previous: PersistentShadowCasterProjection['content'] | undefined,
  current: PersistentShadowCasterProjection['content'] | undefined,
): boolean {
  const a = previous?.terrainSections ?? [],
    b = current?.terrainSections ?? [];
  if (a.length !== b.length) return false;
  return a.every((source, index) => {
    const next = b[index],
      section = source.terrainSection,
      nextSection = next?.terrainSection;
    return (
      next !== undefined &&
      section !== undefined &&
      nextSection !== undefined &&
      renderableDrawKey(source) === renderableDrawKey(next) &&
      source.assetHandle === next.assetHandle &&
      source.terrain?.asset === next.terrain?.asset &&
      section.lod === nextSection.lod &&
      section.neighbors.every((lod, edge) => lod === nextSection.neighbors[edge]) &&
      [12, 13, 14].every((axis) => source.transform.world[axis] === next.transform.world[axis])
    );
  });
}

function sameLightViewProj(
  cached: DirectionalShadowCache,
  current: readonly Float32Array[],
): boolean {
  if (cached.lightViewProj.length !== current.length) return false;
  for (let matrixIndex = 0; matrixIndex < current.length; matrixIndex += 1) {
    const previous = cached.lightViewProj[matrixIndex];
    const next = current[matrixIndex];
    if (previous === undefined || next === undefined || previous.length !== next.length) {
      return false;
    }
    for (let valueIndex = 0; valueIndex < next.length; valueIndex += 1) {
      if (previous[valueIndex] !== next[valueIndex]) return false;
    }
  }
  return true;
}

function sameDirectionalShadowQuality(
  previous: DirectionalShadowQuality,
  next: DirectionalShadowQuality,
): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'pcf-vogel') return true;
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
  worlds: readonly RenderResourceScope[],
  leases: readonly RenderReadLease[] | undefined,
  lights: ExtractedLights,
  shadowMapSize: number | undefined,
  validatedCasters: readonly ValidatedRenderable[],
  casters: PersistentShadowCasterProjection | undefined,
): DirectionalShadowCacheDecision {
  const cascadeCount = lights.cascadeCount;
  const lightViewProj = lights.lightViewProj;
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
    lights.directionalShadowQuality === undefined ||
    validatedCasters.length === 0
  ) {
    return { miss: 'uncached', next: null };
  }

  const cached = frameState.directionalShadowCache;
  const assetCatalogEpoch = internals.assets.catalogEpoch;
  const hasReadLeases = leases !== undefined && leases.length === worlds.length;
  const publicationSource =
    lights.directionalCsmConfig?.staggerCascades === true
      ? currentDirectionalShadowPublication(worlds, casters, cached)
      : undefined;
  if (!hasReadLeases && publicationSource === undefined) {
    // No current source witness: avoid preparing a token that cannot be retained.
    return { miss: 'uncached', next: null };
  }
  // Reuse validation's complete caster set, including off-camera and GPU-owned
  // rows. A resident mesh may be written in place, so retain its content epoch
  // by value; an unrelated upload has no bearing on this depth atlas.
  const meshContent =
    cached !== null &&
    cached.meshContent.length === validatedCasters.length &&
    validatedCasters.every(
      ({ mesh }, index) =>
        cached.meshContent[index]?.mesh === mesh &&
        cached.meshContent[index]?.contentEpoch === mesh.contentEpoch,
    )
      ? cached.meshContent
      : validatedCasters.map(({ mesh }) => ({ mesh, contentEpoch: mesh.contentEpoch }));
  const cadenceSource =
    lights.directionalCsmConfig?.staggerCascades === true &&
    (hasReadLeases || publicationSource !== undefined)
      ? {
          worlds,
          worldStateTokens: hasReadLeases ? leases.map(readWorldState) : [],
          assetCatalogEpoch,
          meshContent,
          casterContent: casters?.content,
        }
      : undefined;
  const sourceChanged =
    cached !== null &&
    cadenceSource !== undefined &&
    (directionalShadowSourceChanged(cached, cadenceSource) ||
      !sameTerrainShadowContent(cached.casterContent, casters?.content));
  const miss: ShadowViewInvalidationReason | undefined =
    cached === null
      ? 'first-publication'
      : cached.shadowMapSize !== shadowMapSize ||
          cached.cascadeCount !== cascadeCount ||
          !sameDirectionalShadowQuality(
            cached.directionalShadowQuality,
            lights.directionalShadowQuality,
          ) ||
          cached.pipelineHandle !== frameState.installedPipelineHandle ||
          cached.graphTopologyKey !== frameState.compiledFrameGraph.topologyKey
        ? 'configuration-changed'
        : sourceChanged
          ? 'source-changed'
          : cached.assetCatalogEpoch !== assetCatalogEpoch ||
              cached.meshContent !== meshContent ||
              !sameTerrainShadowContent(cached.casterContent, casters?.content) ||
              !(
                sameWorldState(cached, worlds, leases) ||
                sameCasterContent(cached, worlds, leases, casters, publicationSource)
              )
            ? 'content-changed'
            : !sameLightViewProj(cached, lightViewProj)
              ? 'view-changed'
              : undefined;
  if (miss === undefined) return { miss: undefined, next: null };

  const worldStateTokens = cadenceSource?.worldStateTokens ?? leases?.map(readWorldState) ?? [];

  return {
    miss,
    next: {
      worlds: worlds.slice(),
      worldStateTokens: worldStateTokens as DirectionalShadowWorldState[],
      assetCatalogEpoch,
      pipelineHandle: frameState.installedPipelineHandle,
      graphTopologyKey: frameState.compiledFrameGraph.topologyKey,
      shadowMapSize,
      cascadeCount,
      directionalShadowQuality: lights.directionalShadowQuality,
      lightViewProj: lightViewProj.map((matrix) => new Float32Array(matrix)),
      meshContent,
      casterContent: casters?.content,
    },
  };
}
