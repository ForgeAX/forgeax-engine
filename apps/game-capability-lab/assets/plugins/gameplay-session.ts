import { Transform } from '@forgeax/engine-scene';
import { RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import { PointLight } from '@forgeax/engine-render';
import { type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { GameHost } from '@forgeax/engine-app';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import type { Context } from '@forgeax/engine-plugin';
import { installGameplayInput } from './gameplay-input';
import { installGameplayLifecycle } from './gameplay-lifecycle';
import { installGameplayAudio } from './gameplay-audio';
import { installAudioEvidence } from './audio-evidence';
import { installGameplayState, type GameplayStateHandle } from './gameplay-state';
import { installDebugAxes, type DebugAxesHandle } from './debug-axes';
import { createWorldScoreText, type WorldScoreTextHandle } from './world-score-text';
import { createGameplayVfx, type GameplayVfx } from './gameplay-vfx';
import { installMultiWorldOverlay, type MultiWorldOverlay } from './multi-world-overlay';
import { targetProfilePoints } from './target-profile-loop';
import { scoringPoints } from './scoring-target';
import { createScorePopup } from './score-popup';
import { createProjectilePresentation, type ProjectilePresentation } from './projectile-presentation';
import { createGameplayReset } from './gameplay-reset';
import { installGameplayChangeDetection, type GameplayChangeDetectionHandle } from './change-detection';
import { Projectile, ResetPose } from './components/gameplay';
import { createAttackPresentation, type AttackPresentationHandle } from './systems/attack-presentation';
import {
  GAME_DEFAULT_MATERIAL_ELAPSED_ORIGIN,
  installDefaultGameplayConfig,
  installGameplayCommandCounters,
  recordGameplayCommand,
} from './resources/gameplay';
import { installGameplayInputMap } from './resources/input';
import { PLAYER_Y } from './scene-runtime';
import { type GameplayTargetFeatures } from './gameplay-targets';
import { createCameraController, type CameraController } from './camera-controller';
import { installAudioSettingsSystem } from './systems/audio-settings';
import { installTargetStatusSystem } from './target-status';
import { createHitStreak, type HitStreakHandle } from './hit-streak';
import { createCounterattack, PLAYER_MAX_HEALTH, type CounterattackHandle } from './counterattack';
import { createHealthPickups, type HealthPickupHandle } from './health-pickup';
import { createRepairCache, type RepairCacheHandle } from './repair-cache';
import { createEnergyCoreExtraction, type EnergyCoreExtractionHandle } from './energy-core-extraction';
import { createRewardChoice, type RewardChoiceHandle } from './reward-choice';
import { createBarrierRoute, type BarrierRouteHandle } from './barrier-route';
import { createSentinelRangedThreat, type SentinelRangedThreat } from './sentinel-ranged-threat';
import {
  readSentinelEncounterReadiness,
  type SentinelEncounterReadiness,
} from './sentinel-authorship';
import { installLightingModeProjection, type LightingModeHandle } from './lighting-mode';

export type GameplaySession = {
  readonly cameraController: CameraController;
  readonly lightingMode: LightingModeHandle;
  readonly projectilePresentation: ProjectilePresentation;
  readonly vfxHitLoop: GameplayVfx;
  readonly gameplayVfx: GameplayVfx;
  readonly attackPresentation: AttackPresentationHandle | undefined;
  readonly multiWorldOverlay: MultiWorldOverlay | undefined;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly changeDetection: GameplayChangeDetectionHandle;
  readonly triggerScore: () => { readonly points: number | null };
  readonly spawnPopup: (text: string, worldX: number, worldY: number, worldZ: number) => void;
  readonly readInput: ReturnType<typeof installGameplayInputMap>;
  readonly projectileEntities: () => EntityHandle[];
  readonly physics: PhysicsWorld | undefined;
  readonly debugAxes: DebugAxesHandle;
  readonly gameplayAudio: Awaited<ReturnType<typeof installGameplayAudio>> | undefined;
  readonly resetGameplay: () => void;
  readonly gameplayState: GameplayStateHandle;
  readonly hitStreak: HitStreakHandle | undefined;
  readonly counterattack: CounterattackHandle | undefined;
  readonly healthPickup: HealthPickupHandle | undefined;
  readonly repairCache: RepairCacheHandle | undefined;
  readonly extraction: EnergyCoreExtractionHandle | undefined;
  readonly rewardChoice: RewardChoiceHandle | undefined;
  readonly barrierRoute: BarrierRouteHandle | undefined;
  readonly sentinel: SentinelRangedThreat | undefined;
  readonly sentinelReadiness: () => SentinelEncounterReadiness;
  readonly consumeProjectile: (entity: EntityHandle) => void;
};

/** Build the one gameplay session that systems consume; no feature state stays in bootstrap. */
export async function createGameplaySession(
  context: Context,
  world: World,
  host: GameHost | undefined,
  canvas: HTMLCanvasElement,
  targets: GameplayTargetFeatures,
): Promise<GameplaySession> {
  world.insertResource(GAME_DEFAULT_MATERIAL_ELAPSED_ORIGIN, 0);
  const cameraController = await createCameraController({
    context,
    world,
    canvas,
    host,
    loaded: targets.loaded,
    player: targets.player,
    initX: targets.initX,
    initZ: targets.initZ,
  });
  const { camera, topQuaternion, hud, settingsState, depthOfField, chromaticAberration, getMode, setMode } = cameraController;
  const lightingMode = installLightingModeProjection({ world, camera, loaded: targets.loaded, hud });
  const vfxTarget = targets.primaryTarget();
  const gameplayVfx = await createGameplayVfx({
    context,
    world,
    ...(host?.assets ? { assets: host.assets } : {}),
    ...(vfxTarget === undefined ? {} : { target: vfxTarget }),
    ...(targets.sentinel.available ? { sentinel: targets.sentinel.identity.sentinel } : {}),
    camera,
  });
  const vfxHitLoop = gameplayVfx;
  context.effect(() => () => gameplayVfx.dispose(), 'game-default/vfx');
  const localApp = host !== undefined && 'renderer' in host.app ? host.app : undefined;
  const multiWorldOverlay = localApp === undefined ? undefined : installMultiWorldOverlay(context, localApp);
  const worldScoreText = await createWorldScoreText(world, host?.assets);
  context.effect(() => () => worldScoreText?.dispose(), 'game-default/world-score-text');
  const changeDetection = installGameplayChangeDetection({ world, targetQuery: targets.targetQuery, hud });
  const hitStreak = createHitStreak(world, targets.player, hud);
  const healthPickup = targets.player === undefined || targets.healthPickups.length === 0
    ? undefined
    : createHealthPickups(world, targets.player, targets.healthPickups);
  context.effect(() => () => healthPickup?.dispose(), 'game-default/health-pickup');
  const repairCache = healthPickup === undefined || targets.repairCache === undefined
    ? undefined
    : createRepairCache(world, targets.repairCache, healthPickup);
  const extraction = targets.player === undefined || targets.extraction === undefined
    ? undefined
    : createEnergyCoreExtraction(world, targets.player, targets.extraction);
  context.effect(() => () => extraction?.dispose(), 'game-default/extraction');
  const barrierRoute = targets.barrierRoute === undefined
    ? undefined
    : createBarrierRoute(world, targets.barrierRoute);
  context.effect(() => () => barrierRoute?.dispose(), 'game-default/barrier-route');
  const counterattack = targets.player === undefined
    ? undefined
    : createCounterattack(world, targets.player, () => extraction?.snapshot().collected ?? 0);
  const rewardChoice = targets.player === undefined || targets.rewardChoice === undefined
    ? undefined
    : createRewardChoice(world, targets.player, targets.rewardChoice);
  if (extraction !== undefined) hud.setExtraction(extraction.snapshot());
  if (rewardChoice !== undefined) hud.setRewardChoice(rewardChoice.snapshot());
  installTargetStatusSystem({
    world,
    hud,
    primaryTarget: targets.primaryTarget,
    targetProfile: targets.targetProfile,
    targetRelay: targets.targetRelay,
  });
  const triggerScore = (): { readonly points: number | null } => {
    const target = targets.primaryTarget();
    if (target === undefined) return { points: null };
    const basePoints = scoringPoints(world, target);
    if (basePoints === undefined) return { points: null };
    const points = targetProfilePoints(targets.targetProfile, basePoints);
    changeDetection.recordHit(target, points);
    targets.damageTarget(target, points);
    const transform = world.get(target, Transform);
    if (transform.ok) worldScoreText?.show('+' + points, [transform.value.pos[0] ?? 0, (transform.value.pos[1] ?? 0) + 1.7, transform.value.pos[2] ?? 0]);
    return { points };
  };

  world.spawn(
    { component: Transform, data: { pos: [3, 5, 1] } },
    { component: PointLight, data: { color: [1, 0.72, 0.42], intensity: 40, range: 22 } },
  );
  const spawnPopup = createScorePopup({ world, camera, canvas, hud, worldScoreText });
  const readInput = installGameplayInputMap(world);
  if (targets.player !== undefined) {
    installGameplayInput({
      world,
      player: targets.player,
      camera,
      canvas,
      hud,
      readInput,
      getMode,
      getPlayerPosition: () => {
        const transform = world.get(targets.player!, Transform);
        return { x: transform.ok ? (transform.value.pos[0] ?? 0) : 0, z: transform.ok ? (transform.value.pos[2] ?? 0) : 0 };
      },
    });
  }

  const projectilePresentation = await createProjectilePresentation({
    world,
    host,
    player: targets.player,
    primaryTarget: targets.primaryTarget,
    targetEntities: targets.targetEntities,
    meshHandleSwap: targets.meshHandleSwap,
    fbxMeshSwap: targets.fbxMeshSwap,
    gltfMeshSwap: targets.gltfMeshSwap,
    jpegTextureSwap: targets.jpegTextureSwap,
    chromaticAberration,
  });
  context.effect(() => () => {
    const content = projectilePresentation.customProjectile?.meshContent;
    if (content !== undefined && world.hasComponent(content, RuntimeMeshVertices)) {
      world.despawn(content).unwrap();
    }
  }, 'game-default/custom-projectile-content');
  installDefaultGameplayConfig(world, {
    playerY: PLAYER_Y,
    topQuaternion,
    bulletRadius: projectilePresentation.bulletRadius,
    bulletHalfHeight: projectilePresentation.bulletHalfHeight,
  });

  const projectileQuery = world.query({ with: [Projectile, Transform] }).unwrap();
  const projectileEntities = (): EntityHandle[] => [
    ...new Set([...projectileQuery].map((row) => row.entity)),
  ];
  const attackPresentation = targets.player === undefined
    ? undefined
    : createAttackPresentation({ world, root: targets.player, vfx: gameplayVfx, projectileEntities });
  installGameplayCommandCounters(world);
  const consumeProjectile = (entity: EntityHandle): void => {
    if (!world.get(entity, Projectile).ok) return;
    attackPresentation?.stopProjectile(entity);
    gameplayVfx.stopFlight(entity);
    projectilePresentation.spriteAtlasLoop?.untrack(entity);
    world.despawn(entity).unwrap();
    recordGameplayCommand(world, 'despawned');
  };
  for (const entity of targets.targetEntities()) {
    const transform = world.get(entity, Transform);
    if (!transform.ok) continue;
    world.addComponent(entity, {
      component: ResetPose,
      data: {
        posX: transform.value.pos[0] ?? 0, posY: transform.value.pos[1] ?? 0, posZ: transform.value.pos[2] ?? 0,
        quatX: transform.value.quat[0] ?? 0, quatY: transform.value.quat[1] ?? 0, quatZ: transform.value.quat[2] ?? 0, quatW: transform.value.quat[3] ?? 1,
        scaleX: transform.value.scale[0] ?? 1, scaleY: transform.value.scale[1] ?? 1, scaleZ: transform.value.scale[2] ?? 1,
      },
    });
  }
  const physics = world.hasResource('PhysicsWorld') ? world.getResource<PhysicsWorld>('PhysicsWorld') : undefined;
  const sentinelReadiness = (): SentinelEncounterReadiness => readSentinelEncounterReadiness(
    targets.sentinel,
    physics,
  );
  const sentinel = targets.player === undefined || !targets.sentinel.available
    ? undefined
    : createSentinelRangedThreat({
        world,
        entity: targets.sentinel.identity.sentinel,
        player: targets.player,
        extraction,
        readiness: sentinelReadiness,
        presentation: projectilePresentation,
        projectileEntities,
        consumeProjectile,
        vfx: gameplayVfx,
        onSpawn: () => recordGameplayCommand(world, 'spawned'),
      });
  const debugAxes = installDebugAxes({
    context,
    world,
    camera,
    targetQuery: targets.targetQuery,
    debugDraw: localApp?.debugDraw,
  });
  const gameplayAudio = targets.player === undefined ? undefined : await installGameplayAudio(world, targets.player, host?.assets);
  installAudioEvidence({ context, world, gameplayAudio });
  installAudioSettingsSystem(world, settingsState, gameplayAudio);
  const resetGameplay = createGameplayReset({
    world,
    debugAxes,
    projectileEntities,
    targetEntities: targets.targetEntities,
    spriteAtlasLoop: projectilePresentation.spriteAtlasLoop,
    materialsForCurrentMesh: projectilePresentation.materialsForCurrentMesh,
    physics,
    player: targets.player,
    camera,
    initX: targets.initX,
    initZ: targets.initZ,
    playerY: PLAYER_Y,
    targetDisabling: targets.targetDisabling,
    visibilityLoop: targets.visibilityLoop,
    targetHealth: targets.targetHealth,
    hitStreak,
    counterattack,
    healthPickup,
    repairCache,
    extraction,
    rewardChoice,
    barrierRoute,
    sentinel,
    changeDetection,
    depthOfField,
    chromaticAberration,
    worldScoreText,
    videoTexturePanel: targets.videoTexturePanel,
    customProjectile: projectilePresentation.customProjectile,
    meshHandleSwap: targets.meshHandleSwap,
    fbxMeshSwap: targets.fbxMeshSwap,
    gltfMeshSwap: targets.gltfMeshSwap,
    jpegTextureSwap: targets.jpegTextureSwap,
    targetProfile: targets.targetProfile,
    fbxSkinnedTarget: targets.fbxSkinnedTarget,
    targetRelay: targets.targetRelay,
    settingsState,
    setMode,
    lightingMode,
    multiWorldOverlay,
    gameplayAudio,
    materialElapsedOriginKey: GAME_DEFAULT_MATERIAL_ELAPSED_ORIGIN,
    animatedMaterial: targets.animatedMaterial,
    vfxHitLoop,
    gameplayVfx,
    attackPresentation,
    setProjectileVisual: projectilePresentation.setProjectileVisual,
    resetMission: () => {
      cameraController.hud.resetTransientFeedback();
      cameraController.hud.setHealth(PLAYER_MAX_HEALTH, PLAYER_MAX_HEALTH);
      cameraController.hud.setTargetProfileActive(false, 0);
      cameraController.hud.setTargetRelay(targets.targetRelay.snapshot());
      if (extraction !== undefined) cameraController.hud.setExtraction(extraction.snapshot());
      if (rewardChoice !== undefined) cameraController.hud.setRewardChoice(rewardChoice.snapshot());
      cameraController.hud.setLightingMode('Day');
      cameraController.hud.setAssetLabStatus('Asset Lab reset · authored RedBox baseline', 'restored');
    },
  });
  const gameplayState = installGameplayState({
    context,
    world,
    reset: resetGameplay,
    onTerminal: () => { attackPresentation?.stop(); gameplayVfx.stopHostile(); sentinel?.cleanupHostileProjectiles(); },
    onPhaseChange: cameraController.hud.setPhase,
  });
  installGameplayLifecycle({ world, readInput, requestReset: gameplayState.requestReset });

  return {
    cameraController,
    lightingMode,
    projectilePresentation,
    vfxHitLoop,
    gameplayVfx,
    attackPresentation,
    multiWorldOverlay,
    worldScoreText,
    changeDetection,
    triggerScore,
    spawnPopup,
    readInput,
    projectileEntities,
    physics,
    debugAxes,
    gameplayAudio,
    resetGameplay,
    gameplayState,
    hitStreak,
    counterattack,
    healthPickup,
    repairCache,
    extraction,
    rewardChoice,
    barrierRoute,
    sentinel,
    sentinelReadiness,
    consumeProjectile,
  };
}
