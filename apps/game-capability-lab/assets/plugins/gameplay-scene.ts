import type { SceneBinding } from '../capability-matrix.plugin';
import type { GameHost } from '@forgeax/engine-app';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { AnimatedMaterialTarget } from './animated-target-material';
import { createAnimatedMaterialTarget } from './animated-target-material';
import { createScoringTargetQuery, ScoringTarget, type ScoringTargetQuery } from './scoring-target';
import { AttackPresentation, ChargeShot, HitFlash, FreeCameraMotion, GameplayInput, PlayerMotion, ProjectilePolicy, TargetPresentation } from './components/gameplay';
import {
  attachScenePhysics, expandLoadedScene, loadedFromScene, loadScene, PLAYER_Y, setupPlayerRoot,
  spawnFallbackScene, spawnGroundCollider, type LoadedScene,
} from './scene-runtime';
import type { AuthoredHealthPickupIdentity } from './health-pickup';
import type { AuthoredRepairCacheIdentity } from './repair-cache';
import type { AuthoredExtractionIdentity } from './energy-core-extraction';
import type { AuthoredRewardChoiceIdentity, RewardKind } from './reward-choice';
import type { AuthoredBarrierRouteIdentity } from './barrier-route';
import { resolveAuthoredSentinelIdentity, type SentinelIdentityResolution } from './sentinel-authorship';

export type GameplaySceneAssembly = {
  readonly loaded: LoadedScene | null;
  readonly player: EntityHandle | undefined;
  readonly healthPickups: readonly AuthoredHealthPickupIdentity[];
  readonly repairCache: AuthoredRepairCacheIdentity | undefined;
  readonly extraction: AuthoredExtractionIdentity | undefined;
  readonly rewardChoice: AuthoredRewardChoiceIdentity | undefined;
  readonly barrierRoute: AuthoredBarrierRouteIdentity | undefined;
  readonly sentinel: SentinelIdentityResolution;
  readonly initX: number;
  readonly initZ: number;
  readonly animatedMaterial: AnimatedMaterialTarget | undefined;
  readonly targetQuery: ScoringTargetQuery;
};

/** Load the authored scene, attach gameplay ECS components, and expose only the assembly facts. */
export async function assembleGameplayScene(world: World, host: GameHost | undefined, binding?: SceneBinding): Promise<GameplaySceneAssembly> {
  let loaded: LoadedScene | null = binding ? loadedFromScene(world, binding) : null;
  if (loaded && host?.assets && binding) loaded = await expandLoadedScene(host.assets, binding.asset, loaded);
  if (!loaded) {
    try { loaded = host?.assets === undefined ? await loadScene({ world }) : await loadScene({ world, assets: host.assets }); }
    catch (error) { console.warn('[game] scene asset unavailable:', error); }
  }
  if (!loaded) spawnFallbackScene({ world });
  spawnGroundCollider({ world });

  let player: EntityHandle | undefined;
  let healthPickups: AuthoredHealthPickupIdentity[] = [];
  let repairCache: AuthoredRepairCacheIdentity | undefined;
  let extraction: AuthoredExtractionIdentity | undefined;
  let rewardChoice: AuthoredRewardChoiceIdentity | undefined;
  let barrierRoute: AuthoredBarrierRouteIdentity | undefined;
  let sentinel: SentinelIdentityResolution = { available: false, identity: null, unavailableReason: { code: 'authored-sentinel-missing', detail: 'SceneAsset is unavailable' } };
  let initX = 0;
  let initZ = 0;
  let animatedMaterial: AnimatedMaterialTarget | undefined;
  const targetQuery = createScoringTargetQuery(world);
  if (loaded) {
    sentinel = resolveAuthoredSentinelIdentity(loaded);
    const physics = attachScenePhysics({ world }, loaded);
    for (const [slot, prop] of physics.props.entries()) {
      world.addComponent(prop.e, {
        component: TargetPresentation,
        data: { authoredMaterials: [...prop.materials], clearcoat: prop.clearcoat === true ? 1 : 0 },
      });
      world.addComponent(prop.e, { component: HitFlash, data: {} });
      world.set(prop.e, ScoringTarget, { slot });
    }
    if (physics.animatedMaterial) animatedMaterial = createAnimatedMaterialTarget(world, physics.animatedMaterial);
    const playerNode = loaded.nodes.find((node) => (node.components.Name as { value?: string } | undefined)?.value === 'Player');
    if (playerNode) {
      const transform = (playerNode.components.Transform ?? {}) as { pos?: number[] };
      initX = transform.pos?.[0] ?? 0;
      initZ = transform.pos?.[2] ?? 0;
      player = loaded.mapping.get(playerNode.localId);
      if (player !== undefined) {
        setupPlayerRoot({ world }, player);
        world.addComponent(player, { component: PlayerMotion, data: { jumpY: PLAYER_Y, freeY: PLAYER_Y } });
        world.addComponent(player, { component: GameplayInput, data: {} });
        world.addComponent(player, { component: ChargeShot, data: {} });
        world.addComponent(player, { component: AttackPresentation, data: {} });
        world.addComponent(player, { component: FreeCameraMotion, data: {} });
        world.addComponent(player, { component: ProjectilePolicy, data: {} });
      }
    }
    const pickupNodes = (['HealthPickup', 'NestedRepairPickup'] as const).flatMap((name) => {
      const node = loaded?.nodes.find(
        (candidate) => (candidate.components.Name as { value?: string } | undefined)?.value === name,
      );
      if (node === undefined) return [];
      const entity = loaded.mapping.get(node.localId);
      return entity === undefined ? [] : [{ entity, localId: node.localId, initiallyActive: name === 'HealthPickup' }];
    });
    if (pickupNodes.length === 2) healthPickups = pickupNodes;
    const repairTargetNode = loaded.nodes.find(
      (node) => (node.components.Name as { value?: string } | undefined)?.value === 'NestedTarget',
    );
    const repairPickup = pickupNodes.find((pickup) => !pickup.initiallyActive);
    if (repairTargetNode !== undefined && repairPickup !== undefined) {
      const target = loaded.mapping.get(repairTargetNode.localId);
      if (target !== undefined) repairCache = {
        target,
        targetLocalId: repairTargetNode.localId,
        pickupLocalId: repairPickup.localId,
      };
    }
    const coreNodes = ['EnergyCoreAlpha', 'EnergyCoreBeta', 'EnergyCoreGamma']
      .map((name) => loaded?.nodes.find(
        (node) => (node.components.Name as { value?: string } | undefined)?.value === name,
      ))
      .filter((node): node is NonNullable<typeof node> => node !== undefined);
    const beaconNode = loaded.nodes.find(
      (node) => (node.components.Name as { value?: string } | undefined)?.value === 'ExtractionBeacon',
    );
    if (coreNodes.length === 3 && beaconNode !== undefined) {
      const cores = coreNodes.flatMap((node) => {
        const entity = loaded?.mapping.get(node.localId);
        return entity === undefined ? [] : [{ entity, localId: node.localId }];
      });
      const beacon = loaded.mapping.get(beaconNode.localId);
      if (cores.length === 3 && beacon !== undefined) extraction = {
        cores,
        beacon: { entity: beacon, localId: beaconNode.localId },
      };
    }
    const rewardNodes = ([
      ['ShieldPedestal', 'shield'],
      ['OverchargePedestal', 'overcharge'],
    ] as const).flatMap(([name, kind]) => {
      const node = loaded?.nodes.find(
        (candidate) => (candidate.components.Name as { value?: string } | undefined)?.value === name,
      );
      if (node === undefined) return [];
      const entity = loaded?.mapping.get(node.localId);
      return entity === undefined ? [] : [{ entity, localId: node.localId, kind: kind as RewardKind }];
    });
    if (rewardNodes.length === 2) rewardChoice = { pedestals: rewardNodes };
    const emitterNode = loaded.nodes.find(
      (node) => (node.components.Name as { value?: string } | undefined)?.value === 'BarrierEmitter',
    );
    const barrierNode = loaded.nodes.find(
      (node) => (node.components.Name as { value?: string } | undefined)?.value === 'EnergyBarrier',
    );
    if (emitterNode !== undefined && barrierNode !== undefined) {
      const emitter = loaded.mapping.get(emitterNode.localId);
      const barrier = loaded.mapping.get(barrierNode.localId);
      if (emitter !== undefined && barrier !== undefined) {
        barrierRoute = {
          emitter,
          emitterLocalId: emitterNode.localId,
          barrier,
          barrierLocalId: barrierNode.localId,
        };
      }
    }
  }
  return { loaded, player, healthPickups, repairCache, extraction, rewardChoice, barrierRoute, sentinel, initX, initZ, animatedMaterial, targetQuery };
}
