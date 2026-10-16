import { Camera } from '@forgeax/engine-render';
import type { GameHost, GameProjectionValue } from '@forgeax/engine-app';
import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';
import { Transform } from '@forgeax/engine-scene';
import type { GameplayStateHandle } from './gameplay-state';
import { TargetHealth, type TargetHealthHandle } from './target-health';
import type { TargetDisablingHandle } from './target-disabling';
import type { VisibilityLoopHandle } from './visibility-loop';
import type { JpegTextureSwap } from './jpeg-texture-swap';
import { jpegTextureSnapshot, toggleJpegTextureSwap } from './jpeg-texture-swap';
import type { VideoTexturePanel } from './video-texture-panel';
import { spriteAtlasSnapshot, type SpriteAtlasLoop } from './sprite-atlas-loop';
import { targetProfileSnapshot, type TargetProfileLoop } from './target-profile-loop';
import type { MultiWorldOverlay } from './multi-world-overlay';
import type { WorldScoreTextHandle } from './world-score-text';
import type { FbxSkinnedTarget } from './fbx-skinned-target';
import type { GameplayVfx } from './gameplay-vfx';
import type { AttackPresentationHandle, AttackPresentationSnapshot } from './systems/attack-presentation';
import type { MeshHandleSwap } from './mesh-handle-swap';
import type { FbxMeshSwap } from './fbx-mesh-swap';
import type { GltfMeshSwap } from './gltf-mesh-swap';
import type { ViewMode } from './hud';
import type { HitStreakHandle } from './hit-streak';
import type { AssetLabActionResult } from './asset-lab-actions';
import type { TargetRelayHandle } from './target-relay';
import { deriveCounterattackPressure, type CounterattackHandle } from './counterattack';
import type { HealthPickupHandle } from './health-pickup';
import type { RepairCacheHandle } from './repair-cache';
import type { EnergyCoreExtractionHandle } from './energy-core-extraction';
import type { RewardChoiceHandle } from './reward-choice';
import type { BarrierRouteHandle } from './barrier-route';
import type {
  SentinelEncounterReadiness,
  SentinelIdentityResolution,
} from './sentinel-authorship';
import type { SentinelRangedThreat } from './sentinel-ranged-threat';
import { GAME_DEFAULT_COMMAND_COUNTERS, type GameplayCommandCounters } from './resources/gameplay';
import { Projectile, projectileAllegianceFromValue } from './components/gameplay';
import type { LightingModeHandle } from './lighting-mode';
import type { ResonanceForge } from './resonance-forge';
import { ANIMATED_TARGET_SHADER_ID } from './animated-target-material';
import { HIT_FLASH_SHADER_ID } from './hit-flash-material';

const COUNTERATTACK_BASELINE = deriveCounterattackPressure(0);

export type GameplayProjectionContext = {
  readonly context: Context;
  readonly host: GameHost;
  readonly world: World;
  readonly camera: EntityHandle;
  readonly getMode: () => ViewMode;
  readonly setMode: (mode: ViewMode) => void;
  readonly gameplayState: GameplayStateHandle;
  readonly targetHealth: TargetHealthHandle;
  readonly targetDisabling: TargetDisablingHandle;
  readonly visibilityLoop: VisibilityLoopHandle;
  readonly jpegTextureSwap: JpegTextureSwap | undefined;
  readonly videoTexturePanel: VideoTexturePanel | undefined;
  readonly targetProfile: TargetProfileLoop | undefined;
  readonly targetRelay: TargetRelayHandle;
  readonly applyTargetProfile: () => AssetLabActionResult;
  readonly applyFbxCompanion: () => AssetLabActionResult;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly multiWorldOverlay: MultiWorldOverlay | undefined;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly fbxSkinnedTarget: FbxSkinnedTarget | undefined;
  readonly vfxHitLoop: GameplayVfx;
  readonly attackPresentation: AttackPresentationHandle | undefined;
  readonly triggerFlash: () => void;
  readonly triggerScore: () => { readonly points: number | null };
  readonly resetMeshHandleSwap: (state: MeshHandleSwap | undefined) => void;
  readonly meshHandleSwap: MeshHandleSwap | undefined;
  readonly fbxMeshSwap: FbxMeshSwap | undefined;
  readonly gltfMeshSwap: GltfMeshSwap | undefined;
  readonly resetFbxMeshSwap: (state: FbxMeshSwap | undefined) => void;
  readonly resetGltfMeshSwap: (state: GltfMeshSwap | undefined) => void;
  readonly setProjectileVisual: (visual: 'mesh' | 'sprite' | 'sprite-lit') => void;
  readonly visibilitySnapshot: () => ReturnType<VisibilityLoopHandle['snapshot']>;
  readonly hitStreak: HitStreakHandle | undefined;
  readonly counterattack: CounterattackHandle | undefined;
  readonly healthPickup: HealthPickupHandle | undefined;
  readonly repairCache: RepairCacheHandle | undefined;
  readonly extraction: EnergyCoreExtractionHandle | undefined;
  readonly rewardChoice: RewardChoiceHandle | undefined;
  readonly barrierRoute: BarrierRouteHandle | undefined;
  readonly sentinelIdentity: SentinelIdentityResolution;
  readonly sentinelReadiness: () => SentinelEncounterReadiness;
  readonly sentinel: SentinelRangedThreat | undefined;
  readonly projectileEntities: () => readonly EntityHandle[];
  readonly lightingMode: LightingModeHandle;
  readonly resonanceForge: ResonanceForge;
};

const EMPTY_VIDEO_TEXTURE = { available: false, active: 'original', swaps: 0, hitReactions: 0, lastHitPlayhead: null, guid: null, name: null, kind: null, url: null } as const;
const EMPTY_MULTI_WORLD = { enabled: false, worldCount: 1, entityCount: 0, cameraOwner: 0, resourceOwner: 0 } as const;
const EMPTY_WORLD_SCORE_TEXT = { available: false, baked: false, active: false, text: '', age: 0, position: [0, 0, 0], fontSource: 'legacy-pack', fontGuid: null, fontSize: 0, color: [1, 1, 1, 1], toggles: 0 } as const;
const EMPTY_FBX_SKINNED_TARGET = { available: false, root: null, skinEntity: null, clipGuid: null, jointCount: 0, position: [0, 0, 0], scale: [1, 1, 1], worldMatrix: [], animationTime: 0, hitPulses: 0, companionActive: false, targetEntity: null } as const;
const EMPTY_ATTACK_PRESENTATION: AttackPresentationSnapshot = { available: false, charging: false, chargeProgress: 0, chargePower: 1, shotsFired: 0, trailStarts: 0, impactBursts: 0, misses: 0, overchargeShots: 0, overchargeImpacts: 0, activeTrails: 0, lastImpactScale: 1, lastVariant: 'normal' };

/** Keep the JSON boundary explicit while retaining typed snapshots internally. */
function asProjection<T>(value: T): GameProjectionValue {
  return value as unknown as GameProjectionValue;
}

/**
 * Register the optional Play inspection bridge. It owns only JSON-shaped
 * projections and actions; gameplay state remains in ECS/components/resources.
 */
export function installGameplayProjection(args: GameplayProjectionContext): void {
  const { host } = args;
  const projection = host.gameProjection;
  if (projection === undefined) return;

  const projectionDisposers = [
    projection.registerRead({
      id: 'game-default.snapshot',
      title: 'Read gameplay snapshot',
      description: 'Read phase, camera mode, shared player damage, charged barrier, authored pickup, extraction, reward lifecycle, and target counts.',
      read: (): GameProjectionValue => {
        const cameraData = args.world.get(args.camera, Camera);
        const sentinelIdentity = args.sentinelIdentity.available ? args.sentinelIdentity.identity : undefined;
        const sentinelReadiness = args.sentinelReadiness();
        const sentinelSnapshot = args.sentinel?.snapshot();
        const sentinelHealth = sentinelIdentity === undefined
          ? undefined
          : args.world.get(sentinelIdentity.sentinel, TargetHealth);
        const position = (entity: EntityHandle): readonly [number, number, number] => {
          const transform = args.world.get(entity, Transform);
          return transform.ok
            ? [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]
            : [0, 0, 0];
        };
        const projectileRows = args.projectileEntities().flatMap((entity) => {
          const projectile = args.world.get(entity, Projectile);
          return projectile.ok
            ? [{
                entity,
                source: projectile.value.source,
                allegiance: projectileAllegianceFromValue(projectile.value.allegiance),
                impactScale: projectile.value.impactScale,
              }]
            : [];
        });
        return asProjection({
          state: args.gameplayState.snapshot(),
          viewMode: args.getMode(),
          lighting: args.lightingMode.snapshot(),
          resonanceForge: args.resonanceForge.snapshot(),
          cameraProjection: cameraData.ok && cameraData.value.projection === 1 ? 'orthographic' : 'perspective',
          targetHealth: args.targetHealth.snapshot(),
          targetDisabling: args.targetDisabling.snapshot(),
          visibility: args.visibilitySnapshot(),
          jpegTexture: jpegTextureSnapshot(args.jpegTextureSwap),
          videoTexture: args.videoTexturePanel?.snapshot() ?? EMPTY_VIDEO_TEXTURE,
          targetProfile: targetProfileSnapshot(args.targetProfile),
          targetRelay: args.targetRelay.snapshot(),
          spriteAtlas: spriteAtlasSnapshot(args.spriteAtlasLoop),
          multiWorld: args.multiWorldOverlay?.snapshot() ?? EMPTY_MULTI_WORLD,
          worldScoreText: args.worldScoreText?.snapshot() ?? EMPTY_WORLD_SCORE_TEXT,
          fbxSkinnedTarget: args.fbxSkinnedTarget?.snapshot() ?? EMPTY_FBX_SKINNED_TARGET,
          vfxHit: args.vfxHitLoop.snapshot(),
          bossVfx: args.vfxHitLoop.bossSnapshot(),
          attackPresentation: args.attackPresentation?.snapshot() ?? EMPTY_ATTACK_PRESENTATION,
          hitStreak: args.hitStreak?.snapshot() ?? { hits: 0, elapsed: 0, multiplier: 1, state: 'ready' },
          counterattack: args.counterattack?.snapshot() ?? {
            playerHealth: 0, playerMaxHealth: 0, playerPosition: [0, 0, 0], hazardEntity: null,
            hazardActive: false, hazardMode: 'unavailable', hazardPosition: null,
            pressureTier: COUNTERATTACK_BASELINE.tier,
            patrolSpeed: COUNTERATTACK_BASELINE.patrolSpeed,
            chaseSpeed: COUNTERATTACK_BASELINE.chaseSpeed,
            pursuitRadius: COUNTERATTACK_BASELINE.pursuitRadius,
            cooldown: 0, acceptedHits: 0, lastShieldedHealth: null,
          },
          healthPickup: args.healthPickup?.snapshot() ?? {
            pickups: [],
          },
          repairCache: args.repairCache?.snapshot() ?? {
            targetLocalId: 0, targetEntity: 0, pickupLocalId: 0, opened: false,
            opens: 0, ordinaryHits: 0, alreadyOpenHits: 0,
            position: [0, 0, 0],
          },
          extraction: args.extraction?.snapshot() ?? {
            status: 'locked', collected: 0, total: 0, active: false, collectedMask: 0,
            wrongContacts: 0, refusedContacts: 0, victoryRequests: 0, deferredDespawns: 0,
            cores: [],
            beacon: {
              authoredLocalId: 0, entity: null, available: false, position: [0, 0, 0],
              sensor: false, physicsReady: false, activeVisual: false,
            },
          },
          rewardChoice: args.rewardChoice?.snapshot() ?? {
            state: 'none', available: false, unavailableRefusals: 0, nonPlayerRefusals: 0,
            lockedRefusals: 0, simultaneousContacts: 0, selections: 0,
            shieldConsumptions: 0, overchargeConsumptions: 0, pedestals: [],
          },
          barrierRoute: args.barrierRoute?.snapshot() ?? {
            emitterEntity: 0, emitterLocalId: 0, barrierEntity: 0, barrierLocalId: 0,
            active: false, activeVisual: false, damagingContact: false, physicsReady: false,
            damageCooldown: 0, acceptedDamageHits: 0,
            opens: 0, ordinaryHits: 0, alreadyOpenHits: 0,
          },
          sentinel: {
            available: sentinelReadiness.available,
            unavailableReason: sentinelReadiness.unavailableReason,
            authoredLocalId: 35,
            entity: sentinelIdentity?.sentinel ?? null,
            position: sentinelIdentity === undefined ? null : position(sentinelIdentity.sentinel),
            mode: sentinelSnapshot?.mode ?? 'dormant',
            ticks: sentinelSnapshot?.ticks ?? 0,
            frozenAim: sentinelSnapshot?.frozenAim ?? null,
            health: sentinelHealth?.ok === true ? sentinelHealth.value.current : 0,
            maxHealth: sentinelHealth?.ok === true ? sentinelHealth.value.max : 0,
            disabled: sentinelIdentity === undefined
              ? false
              : args.world.get(sentinelIdentity.sentinel, Disabled).ok,
            physicsReady: sentinelReadiness.sentinelBodyReady,
            shotsFired: sentinelSnapshot?.shotsFired ?? 0,
            coverBlocked: sentinelSnapshot?.coverBlocked ?? 0,
            playerHits: sentinelSnapshot?.playerHits ?? 0,
            shieldBlocks: sentinelSnapshot?.shieldBlocks ?? 0,
            refused: sentinelSnapshot?.refused ?? 0,
            covers: sentinelIdentity === undefined
              ? []
              : sentinelIdentity.covers.map((cover, index) => ({
                  entity: cover.entity,
                  authoredLocalId: cover.localId,
                  position: position(cover.entity),
                  physicsReady: sentinelReadiness.coverBodiesReady[index] ?? false,
                })),
          },
          projectiles: {
            active: projectileRows.length,
            playerActive: projectileRows.filter((row) => row.allegiance === 'player').length,
            hostileActive: projectileRows.filter((row) => row.allegiance === 'hostile').length,
            entries: projectileRows,
            ...args.world.getResource<GameplayCommandCounters>(GAME_DEFAULT_COMMAND_COUNTERS),
          },
        });
      },
    }),
    projection.registerRead({
      id: 'game-default.renderer-contract',
      title: 'Read renderer contract',
      description: 'Read bounded renderer inspection facts and the build-owned material shader ids.',
      read: (): GameProjectionValue => asProjection({
        health: host.renderer === undefined
          ? { state: 'unavailable' }
          : { state: host.renderer.inspect().state, surface: host.renderer.inspect().surface },
        materialShaderIdentifiers: [HIT_FLASH_SHADER_ID, ANIMATED_TARGET_SHADER_ID],
      }),
    }),
    projection.registerAction({
      id: 'game-default.reset',
      title: 'Request gameplay reset',
      description: 'Request the typed Reset state; cleanup runs through the normal lifecycle owner.',
      run: () => {
        args.gameplayState.requestReset();
        return asProjection({ requested: true });
      },
    }),
    projection.registerAction({
      id: 'game-default.invalid-state',
      title: 'Exercise invalid state recovery',
      description: 'Send an adjacent invalid state through the public state API and return its error code.',
      run: () => asProjection({ errorCode: args.gameplayState.requestInvalid() ?? null }),
    }),
    projection.registerAction({
      id: 'game-default.trigger-hit',
      title: 'Trigger hit feedback',
      description: 'Use the same hit-flash/material/audio feedback owner as a real projectile hit.',
      run: () => {
        args.triggerFlash();
        args.vfxHitLoop.trigger();
        args.fbxSkinnedTarget?.triggerHit();
        return asProjection({ triggered: true });
      },
    }),
    projection.registerAction({
      id: 'game-default.trigger-vfx-hit',
      title: 'Replay transient VFX hit',
      description: 'Replay the Pack v2 particle effect on the existing scored target through the CPU FixedUpdate simulation and late RenderFeature.',
      run: () => {
        args.vfxHitLoop.trigger();
        return asProjection(args.vfxHitLoop.snapshot());
      },
    }),
    projection.registerAction({
      id: 'game-default.trigger-vfx-charge',
      title: 'Play VFX charge mode',
      description: 'Switch the same ParticleEffectPlayer to the second Pack v2 effect with continuous-rate and box-spawn emitters.',
      run: () => {
        args.vfxHitLoop.triggerCharge();
        return asProjection(args.vfxHitLoop.snapshot());
      },
    }),
    projection.registerAction({
      id: 'game-default.trigger-score',
      title: 'Trigger score text',
      description: 'Run one real target-score outcome so the pooled world-space GlyphText can be inspected after a font-source switch.',
      run: () => asProjection(args.triggerScore()),
    }),
    projection.registerAction({
      id: 'game-default.toggle-visibility',
      title: 'Toggle target visibility',
      description: 'Toggle author Visibility on the scored target without changing physics, picking, or Disabled lifecycle.',
      run: () => {
        args.visibilityLoop.toggle();
        return asProjection(args.visibilitySnapshot());
      },
    }),
    projection.registerAction({
      id: 'game-default.toggle-jpeg-texture',
      title: 'Toggle JPEG target texture',
      description: 'Apply or restore the GUID-loaded JPEG albedo on the scored target without changing its mesh or gameplay owners.',
      run: () => {
        if (args.jpegTextureSwap === undefined) return asProjection(jpegTextureSnapshot(undefined));
        if (args.jpegTextureSwap.active === 'original') {
          args.resetMeshHandleSwap(args.meshHandleSwap);
          args.resetFbxMeshSwap(args.fbxMeshSwap);
          args.resetGltfMeshSwap(args.gltfMeshSwap);
        }
        toggleJpegTextureSwap(args.world, args.jpegTextureSwap);
        return asProjection(jpegTextureSnapshot(args.jpegTextureSwap));
      },
    }),
    projection.registerAction({
      id: 'game-default.toggle-video-texture',
      title: 'Toggle WebM target panel',
      description: 'Toggle the licensed WebM through VideoAsset, VideoPlayer, and the host VideoSourceProvider on the existing scored target.',
      run: () => {
        args.videoTexturePanel?.toggle();
        return asProjection(args.videoTexturePanel?.snapshot() ?? EMPTY_VIDEO_TEXTURE);
      },
    }),
    projection.registerAction({
      id: 'game-default.toggle-target-profile',
      title: 'Toggle target profile plugin',
      description: 'After Score 50, apply or restore the host-defined GUID target profile on the existing scored target.',
      run: () => asProjection(args.applyTargetProfile()),
    }),
    projection.registerAction({
      id: 'game-default.toggle-fbx-companion',
      title: 'Toggle FBX target companion',
      description: 'After the precision mission, replace the authored RedBox presentation with the imported humanoid scene and replay its run clip on the same scored target.',
      run: () => asProjection(args.applyFbxCompanion()),
    }),
    projection.registerAction({
      id: 'game-default.toggle-sprite-atlas',
      title: 'Toggle PNG sprite atlas',
      description: 'Toggle the GUID-loaded atlas animation on newly spawned projectiles while retaining the existing hit and physics loop.',
      run: () => {
        if (args.spriteAtlasLoop === undefined) return asProjection(spriteAtlasSnapshot(undefined));
        const enabled = args.spriteAtlasLoop.toggle();
        if (enabled) args.setProjectileVisual('sprite');
        return asProjection(spriteAtlasSnapshot(args.spriteAtlasLoop));
      },
    }),
    projection.registerAction({
      id: 'game-default.toggle-font-source',
      title: 'Toggle TTF font plugin',
      description: 'Switch the same pooled hit-score GlyphText between the legacy baked pack and the licensed TTF font importer output.',
      run: () => asProjection({ fontSource: args.worldScoreText?.toggleFontSource() ?? 'legacy-pack', ...(args.worldScoreText?.snapshot() ?? {}) }),
    }),
    projection.registerAction({
      id: 'game-default.toggle-multi-world',
      title: 'Toggle secondary world',
      description: 'Enable or disable two beacon entities rendered from a secondary World using the primary camera and lights.',
      run: () => {
        if (args.multiWorldOverlay === undefined) return asProjection({ enabled: false, available: false });
        const nextEnabled = !args.multiWorldOverlay.snapshot().enabled;
        args.multiWorldOverlay.setEnabled(nextEnabled);
        return asProjection({ enabled: nextEnabled, available: true });
      },
    }),
    projection.registerAction({
      id: 'game-default.toggle-lighting-mode',
      title: 'Toggle Day/Night lighting',
      description: 'Toggle the authored Sun, Skylight, Skybox, and Camera projection through the ECS lighting mode fact.',
      run: () => {
        const phase = args.gameplayState.snapshot().phase;
        if (phase !== 'Play') return asProjection({ mode: args.lightingMode.snapshot().mode, refused: true, phase });
        return asProjection({ mode: args.lightingMode.toggle() });
      },
    }),
    projection.registerAction({
      id: 'game-default.set-view',
      title: 'Set camera view',
      description: 'Switch the existing camera owner without creating a second camera.',
      argsSchema: {
        type: 'object',
        required: ['mode'],
        properties: { mode: { type: 'string', enum: ['topdown', 'orbit', 'fps', 'pan'] } },
      },
      run: (input) => {
        const modeValue = typeof input === 'object' && input !== null && !Array.isArray(input) ? input.mode : undefined;
        if (modeValue !== 'topdown' && modeValue !== 'orbit' && modeValue !== 'fps' && modeValue !== 'pan') {
          throw new Error('mode must be one of topdown, orbit, fps, pan');
        }
        args.setMode(modeValue);
        return asProjection({ viewMode: modeValue });
      },
    }),
  ];
  args.context.effect(
    () => () => {
      for (const dispose of projectionDisposers.reverse()) dispose();
    },
    'game-default/projection',
  );
}
