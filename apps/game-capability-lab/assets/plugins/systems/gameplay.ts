import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import type { Handle } from '@forgeax/engine-runtime';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import type { HudHandle, ViewMode } from '../hud';
import type { GameplayAudio } from '../gameplay-audio';
import type { GameplayChangeDetectionHandle } from '../change-detection';
import type { ChromaticAberrationHandle } from '../chromatic-aberration';
import type { CustomProjectileMesh } from '../custom-projectile-mesh';
import type { FbxMeshSwap } from '../fbx-mesh-swap';
import type { FbxSkinnedTarget } from '../fbx-skinned-target';
import type { GltfMeshSwap } from '../gltf-mesh-swap';
import type { JpegTextureSwap } from '../jpeg-texture-swap';
import type { MeshHandleSwap } from '../mesh-handle-swap';
import type { SpriteAtlasLoop } from '../sprite-atlas-loop';
import type { TargetProfileLoop, TargetProfileSnapshot } from '../target-profile-loop';
import type { VideoTexturePanel } from '../video-texture-panel';
import type { GameplayVfx } from '../gameplay-vfx';
import type { WorldScoreTextHandle } from '../world-score-text';
import type { ScoringTargetQuery } from '../scoring-target';
import type { MatHandle } from '../scene-runtime';
import type { ProjectileVisual } from '../components/gameplay';
import type { AssetLabActionResult } from '../asset-lab-actions';
import type { LightingModeHandle } from '../lighting-mode';
import type { HitStreakHandle } from '../hit-streak';
import { installHitStreakSystem } from '../hit-streak';
import { installInputActionsSystem } from './input-actions';
import { installCameraInputSystem } from './camera-input';
import { installPlayerMovementSystem } from './player-movement';
import { installChargeShotSystem } from './charge-shot';
import { installProjectileSimulationSystem } from './projectile-simulation';
import type { AttackPresentationHandle } from './attack-presentation';
import { admitTargetImpact, installTargetFeedbackSystem, type TargetFeedbackSystemContext } from './target-feedback';
import { installCameraFollowSystem } from './camera-follow';
import type { TargetRelayHandle } from '../target-relay';
import {
  deriveCounterattackPressure,
  PLAYER_MAX_HEALTH,
  type CounterattackHandle,
} from '../counterattack';
import type { HealthPickupHandle } from '../health-pickup';
import type { RepairCacheHandle } from '../repair-cache';
import type { EnergyCoreExtractionHandle } from '../energy-core-extraction';
import type { RewardChoiceHandle } from '../reward-choice';
import type { BarrierRouteHandle } from '../barrier-route';
import type { SentinelRangedThreat } from '../sentinel-ranged-threat';
import { installProjectileImpactSystem } from '../projectile-impact';

export type GameplaySystemsContext = {
  readonly world: World;
  readonly root: EntityHandle;
  readonly camera: EntityHandle;
  readonly readInput: () => InputSnapshot;
  readonly getMode: () => ViewMode;
  readonly hud: HudHandle;
  readonly gameplayAudio: GameplayAudio | undefined;
  readonly customProjectile: CustomProjectileMesh | undefined;
  readonly getProjectileVisual: () => ProjectileVisual;
  readonly setProjectileVisual: (visual: ProjectileVisual) => void;
  readonly meshHandleSwap: MeshHandleSwap | undefined;
  readonly fbxMeshSwap: FbxMeshSwap | undefined;
  readonly gltfMeshSwap: GltfMeshSwap | undefined;
  readonly jpegTextureSwap: JpegTextureSwap | undefined;
  readonly videoTexturePanel: VideoTexturePanel | undefined;
  readonly fbxSkinnedTarget: FbxSkinnedTarget | undefined;
  readonly targetProfile: TargetProfileLoop | undefined;
  readonly targetRelay: TargetRelayHandle;
  readonly requestVictory: () => void;
  readonly requestDefeat: () => void;
  readonly counterattack: CounterattackHandle | undefined;
  readonly healthPickup: HealthPickupHandle | undefined;
  readonly repairCache: RepairCacheHandle | undefined;
  readonly extraction: EnergyCoreExtractionHandle | undefined;
  readonly rewardChoice: RewardChoiceHandle | undefined;
  readonly barrierRoute: BarrierRouteHandle | undefined;
  readonly sentinel: SentinelRangedThreat | undefined;
  readonly readScore: () => number;
  readonly toggleProfile: () => TargetProfileSnapshot;
  readonly onAssetLabResult?: (result: AssetLabActionResult) => void;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly vfxHitLoop: GameplayVfx;
  readonly attackPresentation: AttackPresentationHandle;
  readonly toggleCustomProjectileMesh: (state: CustomProjectileMesh) => void;
  readonly resetMeshHandleSwap: (state: MeshHandleSwap | undefined) => void;
  readonly resetFbxMeshSwap: (state: FbxMeshSwap | undefined) => void;
  readonly resetGltfMeshSwap: (state: GltfMeshSwap | undefined) => void;
  readonly resetJpegTextureSwap: (state: JpegTextureSwap | undefined) => void;
  readonly toggleJpegTextureSwap: (state: JpegTextureSwap) => void;
  readonly targetQuery: ScoringTargetQuery;
  readonly projectileEntities: () => readonly EntityHandle[];
  readonly recordCommand: (kind: 'spawned' | 'despawned') => void;
  readonly consumeProjectile: (entity: EntityHandle) => void;
  readonly damageTarget: (entity: EntityHandle, points: number) => void;
  readonly spawnPopup: (text: string, x: number, y: number, z: number) => void;
  readonly triggerFlash: (entity?: EntityHandle) => void;
  readonly materialsForCurrentMesh: (entity: EntityHandle, flashing: boolean) => readonly MatHandle[];
  readonly changeDetection: GameplayChangeDetectionHandle;
  readonly chromaticAberration: ChromaticAberrationHandle;
  readonly physics: PhysicsWorld | undefined;
  readonly projectileMesh: Handle<'MeshAsset', 'shared'>;
  readonly projectileMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly handleQuad: Handle<'MeshAsset', 'shared'>;
  readonly setPerspectiveFov: (fov: number) => void;
  readonly applyPanCamera: () => void;
  readonly hitStreak: HitStreakHandle | undefined;
  readonly lightingMode: LightingModeHandle;
};

/**
 * Register gameplay after bootstrap has assembled asset plugins. Movement,
 * charge, projectile, collision, and reward ownership run at FixedUpdate;
 * input presentation, camera, HUD, and rendering helpers stay at Update.
 */
export function installGameplaySystems(ctx: GameplaySystemsContext): void {
  installInputActionsSystem({
    world: ctx.world,
    readInput: ctx.readInput,
    gameplayAudio: ctx.gameplayAudio,
    customProjectile: ctx.customProjectile,
    setProjectileVisual: ctx.setProjectileVisual,
    meshHandleSwap: ctx.meshHandleSwap,
    fbxMeshSwap: ctx.fbxMeshSwap,
    gltfMeshSwap: ctx.gltfMeshSwap,
    jpegTextureSwap: ctx.jpegTextureSwap,
    videoTexturePanel: ctx.videoTexturePanel,
    fbxSkinnedTarget: ctx.fbxSkinnedTarget,
    targetProfile: ctx.targetProfile,
    readScore: ctx.readScore,
    toggleProfile: ctx.toggleProfile,
    ...(ctx.onAssetLabResult ? { onAssetLabResult: ctx.onAssetLabResult } : {}),
    spriteAtlasLoop: ctx.spriteAtlasLoop,
    worldScoreText: ctx.worldScoreText,
    toggleCustomProjectileMesh: ctx.toggleCustomProjectileMesh,
    lightingMode: ctx.lightingMode,
  });
  installCameraInputSystem({
    world: ctx.world,
    player: ctx.root,
    camera: ctx.camera,
    readInput: ctx.readInput,
    getMode: ctx.getMode,
    setPerspectiveFov: ctx.setPerspectiveFov,
  });
  installPlayerMovementSystem({
    world: ctx.world,
    root: ctx.root,
    readInput: ctx.readInput,
    getMode: ctx.getMode,
    physics: ctx.physics,
  });
  installChargeShotSystem({
    world: ctx.world,
    root: ctx.root,
    readInput: ctx.readInput,
    hud: ctx.hud,
  });
  if (ctx.hitStreak !== undefined) {
    installHitStreakSystem({ world: ctx.world, player: ctx.root, hud: ctx.hud });
  }
  installProjectileSimulationSystem({
    world: ctx.world,
    root: ctx.root,
    readInput: ctx.readInput,
    getMode: ctx.getMode,
    getProjectileVisual: ctx.getProjectileVisual,
    customProjectile: ctx.customProjectile,
    spriteAtlasLoop: ctx.spriteAtlasLoop,
    projectileMesh: ctx.projectileMesh,
    projectileMaterial: ctx.projectileMaterial,
    handleQuad: ctx.handleQuad,
    projectileEntities: ctx.projectileEntities,
    rewardChoice: ctx.rewardChoice,
    attackPresentation: ctx.attackPresentation,
    onSpawn: () => ctx.recordCommand('spawned'),
    consumeProjectile: ctx.consumeProjectile,
  });
  ctx.attackPresentation.installSystem();
  const targetFeedback: TargetFeedbackSystemContext = {
    world: ctx.world,
    targetQuery: ctx.targetQuery,
    targetProfile: ctx.targetProfile,
    targetRelay: ctx.targetRelay,
    onTargetImpact: (entity, impactScale) => {
      if (ctx.repairCache?.recordImpact(entity, impactScale) !== 'open') return;
      const position = ctx.repairCache.snapshot().position;
      ctx.hud.setAssetLabStatus('Nested repair cache open · collect the revealed pickup', 'active');
      ctx.spawnPopup('REPAIR CACHE OPEN', position[0], position[1] + 1.2, position[2]);
    },
    onProfileHit: () => {
      if (ctx.targetProfile?.precisionHits === 1) ctx.targetRelay.begin();
      ctx.hud.setTargetProfileActive(ctx.targetProfile?.active === 'profile', ctx.targetProfile?.precisionHits ?? 0);
      ctx.hud.setTargetRelay(ctx.targetRelay.snapshot());
    },
    onRelayHit: () => {
      const relay = ctx.targetRelay.snapshot();
      ctx.hud.setTargetRelay(relay);
      if (relay.status === 'complete' && ctx.extraction !== undefined) ctx.hud.setExtraction(ctx.extraction.snapshot());
    },
    spriteAtlasLoop: ctx.spriteAtlasLoop,
    onAtlasHit: () => ctx.onAssetLabResult?.({ text: 'PNG atlas projectile active · animated hit confirmed · 4 frames', state: 'active' }),
    worldScoreText: ctx.worldScoreText,
    onFontScore: () => ctx.onAssetLabResult?.({ text: 'TTF score text active · imported glyph metrics on scored hit', state: 'active' }),
    onVideoHit: () => {
      if (ctx.videoTexturePanel?.reactToHit() === true) {
        ctx.onAssetLabResult?.({ text: 'WebM target panel active · hit context replayed', state: 'active' });
      }
    },
    onFbxHit: (entity) => {
      if (ctx.fbxSkinnedTarget?.reactToHit(entity) === true) {
        ctx.onAssetLabResult?.({ text: 'FBX target companion active · animated hit confirmed', state: 'active' });
      }
    },
    changeDetection: ctx.changeDetection,
    damageTarget: ctx.damageTarget,
    spawnPopup: ctx.spawnPopup,
    gameplayAudio: ctx.gameplayAudio,
    vfxHitLoop: ctx.vfxHitLoop,
    triggerFlash: ctx.triggerFlash,
    materialsForCurrentMesh: ctx.materialsForCurrentMesh,
    chromaticAberration: ctx.chromaticAberration,
    hitStreak: ctx.hitStreak,
  };
  installTargetFeedbackSystem(targetFeedback);
  ctx.barrierRoute?.installSystem({
    physics: ctx.physics,
    isUnlocked: () => ctx.targetRelay.snapshot().status === 'complete',
    onImpact: (result, position) => {
      const text = result === 'open'
        ? 'BARRIER OPEN'
        : result === 'ordinary'
          ? 'BARRIER NEEDS CHARGE'
          : 'BARRIER ALREADY OPEN';
      ctx.spawnPopup(text, position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show(text, [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
      ctx.vfxHitLoop.trigger();
      ctx.chromaticAberration.setIntensity(result === 'open' ? 0.12 : 0.04);
    },
  });
  ctx.rewardChoice?.installSystem({
    physics: ctx.physics,
    isAvailable: () => ctx.extraction?.snapshot().active === true,
    onProgress: ctx.hud.setRewardChoice,
    onChange: (snapshot, event, position) => {
      if (event === 'selected' && snapshot.state === 'shield-ready') ctx.counterattack?.arm();
      ctx.hud.setRewardChoice(snapshot);
      const text = event === 'selected'
        ? snapshot.state === 'shield-ready' ? 'SHIELD READY' : 'OVERCHARGE READY'
        : event === 'shield-consumed'
          ? 'SHIELD BLOCK'
          : event === 'overcharge-consumed'
            ? 'OVERCHARGE FIRED'
            : snapshot.available ? 'REWARD LOCKED' : 'REWARDS NEED 3 CORES';
      ctx.spawnPopup(text, position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show(text, [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
      if (event !== 'refused') ctx.vfxHitLoop.trigger();
    },
  });
  ctx.counterattack?.installSystem({
    physics: ctx.physics,
    rewardChoice: ctx.rewardChoice,
    requestDefeat: ctx.requestDefeat,
    onHit: (attacker, remainingHealth, shielded) => {
      ctx.hud.setHealth(remainingHealth, PLAYER_MAX_HEALTH);
      const playerTransform = ctx.world.get(ctx.root, Transform);
      if (playerTransform.ok) {
        const x = playerTransform.value.pos[0] ?? 0;
        const y = playerTransform.value.pos[1] ?? 0;
        const z = playerTransform.value.pos[2] ?? 0;
        const text = shielded ? 'SHIELD BLOCK' : '-1 HEART';
        ctx.spawnPopup(text, x, y + 0.8, z);
        ctx.worldScoreText?.show(text, [x, y + 1.7, z]);
      }
      ctx.gameplayAudio?.triggerHit();
      ctx.vfxHitLoop.trigger();
      ctx.triggerFlash(attacker);
      ctx.chromaticAberration.setIntensity(0.08);
    },
  });
  ctx.healthPickup?.installSystem({
    physics: ctx.physics,
    onCollect: (health, max, position) => {
      ctx.hud.setHealth(health, max);
      ctx.spawnPopup('+1 HEART', position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show('+1 HEART', [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
      ctx.vfxHitLoop.trigger();
    },
  });
  ctx.extraction?.installSystem({
    physics: ctx.physics,
    isUnlocked: () => ctx.targetRelay.snapshot().status === 'complete',
    canExtract: () => ctx.rewardChoice?.snapshot().state === 'consumed',
    requestVictory: ctx.requestVictory,
    onProgress: ctx.hud.setExtraction,
    onCollect: (progress, position) => {
      const tier = deriveCounterattackPressure(progress.collected).tier;
      const text = `CORE ${progress.collected}/${progress.total} · THREAT ${tier}/3`;
      ctx.spawnPopup(text, position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show(text, [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
      ctx.vfxHitLoop.trigger();
    },
    onRefuse: (progress, position) => {
      ctx.spawnPopup(`NEED ${progress.total - progress.collected} CORES`, position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show(`NEED ${progress.total - progress.collected} CORES`, [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
    },
    onRewardRequired: (position) => {
      ctx.spawnPopup('CHOOSE A REWARD', position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show('CHOOSE A REWARD', [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
    },
    onActivate: (progress, position) => {
      const tier = deriveCounterattackPressure(progress.collected).tier;
      const text = `EXTRACTION READY · THREAT ${tier}/3`;
      ctx.spawnPopup(text, position[0], position[1] + 0.8, position[2]);
      ctx.worldScoreText?.show(text, [position[0], position[1] + 1.7, position[2]]);
      ctx.gameplayAudio?.triggerHit();
      ctx.vfxHitLoop.trigger();
    },
  });
  ctx.sentinel?.installSystem();
  installProjectileImpactSystem({
    world: ctx.world,
    player: ctx.root,
    projectileEntities: ctx.projectileEntities,
    barrierEntity: ctx.barrierRoute?.snapshot().emitterEntity as EntityHandle | undefined,
    barrierRoute: ctx.barrierRoute,
    counterattack: ctx.counterattack,
    admitTarget: (target, projectile, impactScale) => admitTargetImpact(
      targetFeedback,
      target,
      projectile,
      impactScale,
    ),
    onCoverImpact: (cover) => {
      const transform = ctx.world.get(cover, Transform);
      if (!transform.ok) return;
      const position = transform.value.pos;
      const x = position[0] ?? 0;
      const y = position[1] ?? 0;
      const z = position[2] ?? 0;
      ctx.spawnPopup('BLOCK', x, y + 0.8, z);
      ctx.worldScoreText?.show('BLOCK', [x, y + 1.7, z]);
      ctx.gameplayAudio?.triggerHit();
      ctx.vfxHitLoop.trigger();
    },
    consume: ctx.consumeProjectile,
    onOutcome: (source, outcome, shielded) => ctx.sentinel?.recordOutcome(source, outcome, shielded),
    onImpact: (source, _projectile, position, outcome, impactScale, presentationVariant) => {
      if (outcome === 'refused') return;
      if (source === ctx.sentinel?.entity) ctx.vfxHitLoop.emitImpact(position);
      if (source === ctx.root) ctx.attackPresentation.onImpact(position, presentationVariant !== 0, impactScale);
    },
    onTargetResolved: (target) => ctx.sentinel?.onTargetResolved(target),
    after: [
      'physicsCollisionSync',
      'game-projectile-simulation',
      ...(ctx.healthPickup === undefined ? [] : ['game-health-pickup-collection']),
      ...(ctx.extraction === undefined ? [] : ['game-energy-core-extraction']),
      ...(ctx.rewardChoice === undefined ? [] : ['game-reward-choice']),
      ...(ctx.barrierRoute === undefined ? [] : ['game-barrier-route']),
    ],
    before: ['game-target-feedback', 'game-counterattack'],
  });
  installCameraFollowSystem({
    world: ctx.world,
    player: ctx.root,
    camera: ctx.camera,
    getMode: ctx.getMode,
    applyPanCamera: ctx.applyPanCamera,
    worldScoreText: ctx.worldScoreText,
    videoTexturePanel: ctx.videoTexturePanel,
  });
}
