import type { ShadowViewInvalidationReason } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { DirectionalCsmConfig, ExtractedLights } from '../render-system-extract';
import type {
  PersistentShadowCasterProjection,
  ShadowPublicationSource,
} from '../scene/render-scene';
import type { DirectionalShadowCache } from './frame-snapshot';

export type DirectionalCascadeCadenceLights = Pick<
  ExtractedLights,
  'cascadeCount' | 'lightViewProj'
> & {
  readonly directionalCsmConfig?: Pick<DirectionalCsmConfig, 'staggerCascades'> | undefined;
};

export interface DirectionalCascadeCadenceState {
  readonly lightViewProj: readonly Float32Array[];
  readonly stale: readonly boolean[];
  /** Advances only when the caller promotes a successfully submitted candidate. */
  readonly frame: number;
}

/** Cascade zero plus at most one far cascade is due on a content-miss frame. */
export function directionalCascadeDue(cascade: number, frame: number): boolean {
  if (cascade <= 0) return true;
  const period = 2 ** cascade;
  return frame % period === period / 2;
}

function sameMatrix(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Only a current receiver/scene witness can replace local ECS read leases. */
export function currentDirectionalShadowPublication(
  worlds: readonly RenderResourceScope[],
  casters: PersistentShadowCasterProjection | undefined,
  previous: DirectionalShadowCache | null,
): ShadowPublicationSource | undefined {
  const source = casters?.content.publicationSource;
  const oldSource = previous?.casterContent?.publicationSource;
  if (
    source === undefined ||
    worlds.length !== 1 ||
    worlds[0] !== source.resources ||
    !Number.isSafeInteger(source.revision) ||
    source.revision <= 0 ||
    source.resources.revision !== source.revision ||
    (oldSource?.resources === source.resources && oldSource.revision > source.revision)
  ) {
    return undefined;
  }
  try {
    return source.isCurrent() ? source : undefined;
  } catch {
    return undefined;
  }
}

/** Source/asset replacement cannot be traded for bounded dynamic-caster lag. */
export function directionalShadowSourceChanged(
  previous: Pick<
    DirectionalShadowCache,
    'worlds' | 'worldStateTokens' | 'assetCatalogEpoch' | 'meshContent' | 'casterContent'
  >,
  next: Pick<
    DirectionalShadowCache,
    'worlds' | 'worldStateTokens' | 'assetCatalogEpoch' | 'meshContent' | 'casterContent'
  >,
): boolean {
  return (
    previous.assetCatalogEpoch !== next.assetCatalogEpoch ||
    previous.meshContent !== next.meshContent ||
    previous.casterContent?.owner !== next.casterContent?.owner ||
    previous.casterContent?.dispatchRevision !== next.casterContent?.dispatchRevision ||
    previous.casterContent?.publicationSource?.resources !==
      next.casterContent?.publicationSource?.resources ||
    previous.worlds.length !== next.worlds.length ||
    previous.worldStateTokens.length !== next.worldStateTokens.length ||
    previous.worlds.some((world, index) => world !== next.worlds[index]) ||
    previous.worldStateTokens.some((token, index) => {
      const current = next.worldStateTokens[index];
      return (
        current === undefined ||
        token.worldIdentity !== current.worldIdentity ||
        token.version.structureEpoch !== current.version.structureEpoch
      );
    })
  );
}

/**
 * CPU-only candidate. Retain a layer only with its exact raster projection;
 * hard cache invalidations refresh all layers. This does not relax missing
 * read-lease evidence or replace the typed graph's retained-target protection.
 */
export function prepareDirectionalCascadeCadence(
  lights: DirectionalCascadeCadenceLights,
  previous: DirectionalCascadeCadenceState | undefined,
  mapMiss: ShadowViewInvalidationReason | undefined,
): {
  readonly cascadeMiss: readonly (ShadowViewInvalidationReason | undefined)[] | undefined;
  readonly next: DirectionalCascadeCadenceState | null;
} {
  const current = lights.lightViewProj;
  const count = lights.cascadeCount ?? 0;
  if (
    lights.directionalCsmConfig?.staggerCascades !== true ||
    current === undefined ||
    count <= 1 ||
    current.length < count ||
    mapMiss === 'uncached'
  ) {
    return { cascadeMiss: undefined, next: null };
  }
  const frame = previous === undefined ? 0 : previous.frame + 1;
  const retained =
    previous !== undefined &&
    previous.lightViewProj.length === current.length &&
    previous.stale.length === count;
  const hardMiss =
    mapMiss !== undefined && mapMiss !== 'content-changed' && mapMiss !== 'view-changed';
  const cascadeMiss: (ShadowViewInvalidationReason | undefined)[] = [];
  const stale: boolean[] = [];
  for (let cascade = 0; cascade < count; cascade += 1) {
    if (!retained || hardMiss) {
      cascadeMiss.push(mapMiss ?? 'first-publication');
      stale.push(false);
    } else if (!sameMatrix(previous.lightViewProj[cascade], current[cascade])) {
      cascadeMiss.push(mapMiss ?? 'view-changed');
      stale.push(false);
    } else if (mapMiss === undefined) {
      cascadeMiss.push(previous.stale[cascade] ? 'content-changed' : undefined);
      stale.push(false);
    } else {
      const keep = !directionalCascadeDue(cascade, frame);
      cascadeMiss.push(keep ? undefined : mapMiss);
      stale.push(keep);
    }
  }
  return {
    cascadeMiss,
    next: {
      lightViewProj: current.map((matrix) => new Float32Array(matrix)),
      stale,
      frame,
    },
  };
}
