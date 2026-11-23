import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetContentLease } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { SceneRosterObservation } from '@forgeax/engine-scene/internal';
import { err, type Result } from '@forgeax/engine-types';
import type { RenderResidencyGroup } from '../gpu-driven/batch-residency';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
} from '../publication/contract';
import { installPublicationPrograms } from '../publication/programs';
import type {
  ClosedLevelAssetHold,
  ClosedLevelAssetPublication,
  RenderPublicationReceiver,
} from '../publication/receiver';
import type { Renderer } from '../render-contract';
import type { PublishedLevelMeshInput } from '../scene/published-mesh-source';
import type { SceneComposition } from '../scene/scene-composition';
import { type StagedMeshSource, StagedMeshSourceError } from '../scene/staged-mesh-source';
import { PublishedLevelPreparation } from './published-level-preparation';
import type { SourceViewPreparation } from './source-view-preparation';

/** Internal routing to the actual Renderer assembly; no residency or readiness is stored here. */
export interface LevelSourceHost {
  beginStagedGroup(
    observation: SceneRosterObservation,
    content: AssetContentLease,
  ): Result<StagedMeshSource, StagedMeshSourceError>;
  current(): boolean;
  prepareViews(group: RenderResidencyGroup, current: () => boolean): SourceViewPreparation;
}
type LevelPublicationSource = Pick<
  RenderPublicationReceiver,
  'retainClosedLevelAsset' | 'referencesAcceptedAsset'
>;

export interface LevelSourceAccess {
  local(world: World): LevelSourceHost | undefined;
  preparePublished(input: PublishedLevelMeshInput): PublishedLevelPreparation;
  readonly publicationReceiver: LevelPublicationSource | undefined;
  installPrograms(programs: RenderPublication['programs']): void;
}
const assemblies = new WeakMap<Renderer, LevelSourceAccess>();
export function bindLevelSourceAccess(
  renderer: Renderer,
  access: LevelSourceAccess | undefined,
): Renderer {
  if (access !== undefined) assemblies.set(renderer, access);
  return renderer;
}
export function levelSourceHost(renderer: Renderer, world: World): LevelSourceHost | undefined {
  return assemblies.get(renderer)?.local(world);
}

export function retainPublishedLevelAsset(
  renderer: Renderer,
  identity: RenderPublicationIdentity,
  asset: ClosedLevelAssetPublication,
): Result<ClosedLevelAssetHold, RenderPublicationError> {
  return (
    assemblies.get(renderer)?.publicationReceiver?.retainClosedLevelAsset(identity, asset) ??
    err(
      new RenderPublicationError({
        reason: 'identity',
        subject: 'Renderer has no Level publication source',
      }),
    )
  );
}

export function installPublishedLevelPrograms(
  renderer: Renderer,
  programs: RenderPublication['programs'],
): void {
  const access = assemblies.get(renderer);
  if (access?.publicationReceiver === undefined)
    throw new StagedMeshSourceError({ reason: 'native-bridge-unavailable' });
  access.installPrograms(programs);
}

export function preparePublishedLevel(
  renderer: Renderer,
  input: PublishedLevelMeshInput,
): PublishedLevelPreparation {
  const access = assemblies.get(renderer);
  if (access === undefined)
    throw new StagedMeshSourceError({ reason: 'native-bridge-unavailable' });
  return access.preparePublished(input);
}

export function createLevelSourceAccess(host: {
  readonly assets: AssetRegistry;
  composition(): SceneComposition | undefined;
  available(world: World, lease: RenderReadLease): boolean;
  readonly publicationReceiver: LevelPublicationSource | undefined;
  prepareViews(group: RenderResidencyGroup, current: () => boolean): SourceViewPreparation;
}): LevelSourceAccess {
  const local = (world: World): LevelSourceHost | undefined => {
    const composition = host.composition();
    const lease = composition?.entry?.readLease;
    if (composition === undefined || lease === undefined || !host.available(world, lease))
      return undefined;
    const current = () => host.composition() === composition && host.available(world, lease);
    return {
      beginStagedGroup: (observation, content) =>
        composition.beginStagedGroup(observation, content, lease),
      current,
      prepareViews: (group, guard) => host.prepareViews(group, () => current() && guard()),
    };
  };
  return {
    local,
    publicationReceiver: host.publicationReceiver,
    installPrograms: (programs) => installPublicationPrograms(host.assets, programs),
    preparePublished(input) {
      const composition = host.composition();
      const receiver = host.publicationReceiver;
      if (composition === undefined || receiver === undefined)
        throw new StagedMeshSourceError({ reason: 'session' });
      const stage = composition.beginPublishedStagedGroup(input, (handle) =>
        receiver.referencesAcceptedAsset(handle),
      );
      return new PublishedLevelPreparation(stage, (source) =>
        host.prepareViews(source.group, () => input.isCurrent() && source.isCurrent()),
      );
    },
  };
}
