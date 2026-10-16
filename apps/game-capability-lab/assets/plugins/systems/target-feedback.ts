import { MeshRenderer } from '@forgeax/engine-render';
import { FixedTime, FixedUpdate, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import type { GameplayAudio } from '../gameplay-audio';
import type { GameplayChangeDetectionHandle } from '../change-detection';
import type { ChromaticAberrationHandle } from '../chromatic-aberration';
import { recordTargetProfileHit, targetProfilePoints, type TargetProfileLoop } from '../target-profile-loop';
import type { SpriteAtlasLoop } from '../sprite-atlas-loop';
import type { VfxHitLoop } from '../vfx-hit-loop';
import type { HitStreakHandle } from '../hit-streak';
import type { WorldScoreTextHandle } from '../world-score-text';
import type { MatHandle } from '../scene-runtime';
import { activeScoringTargetEntities, scoringPoints, type ScoringTargetQuery, ScoringTarget } from '../scoring-target';
import { GameState } from '../gameplay-state';
import { HitFlash } from '../components/gameplay';
import type { TargetRelayHandle } from '../target-relay';

export type TargetFeedbackSystemContext = {
  readonly world: World;
  readonly targetQuery: ScoringTargetQuery;
  readonly targetProfile: TargetProfileLoop | undefined;
  readonly onProfileHit?: () => void;
  readonly targetRelay: TargetRelayHandle;
  readonly onTargetImpact?: (entity: EntityHandle, impactScale: number) => void;
  readonly onRelayHit?: () => void;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly onAtlasHit?: () => void;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly onFontScore?: () => void;
  readonly onVideoHit?: () => void;
  readonly onFbxHit?: (entity: EntityHandle) => void;
  readonly changeDetection: GameplayChangeDetectionHandle;
  readonly damageTarget: (entity: EntityHandle, points: number) => void;
  readonly spawnPopup: (text: string, x: number, y: number, z: number) => void;
  readonly gameplayAudio: GameplayAudio | undefined;
  readonly vfxHitLoop: VfxHitLoop;
  readonly triggerFlash: (entity?: EntityHandle) => void;
  readonly materialsForCurrentMesh: (entity: EntityHandle, flashing: boolean) => readonly MatHandle[];
  readonly chromaticAberration: ChromaticAberrationHandle;
  readonly hitStreak: HitStreakHandle | undefined;
};

export function resolveTargetImpactPoints(points: number, impactScale: number): number {
  return Math.round(points * Math.max(1, impactScale));
}

/** Apply one contact already admitted by the shared CollidingEntities owner. */
export function admitTargetImpact(
  ctx: TargetFeedbackSystemContext,
  entity: EntityHandle,
  projectileEntity: EntityHandle,
  impactScale: number,
): void {
  const target = ctx.world.get(entity, ScoringTarget);
  const transform = ctx.world.get(entity, Transform);
  if (!target.ok || !transform.ok) return;
  const fx = transform.value.pos[0] ?? 0;
  const fy = transform.value.pos[1] ?? 0;
  const fz = transform.value.pos[2] ?? 0;
  ctx.onTargetImpact?.(entity, impactScale);
  const relayWasActive = ctx.targetRelay.snapshot().status === 'active';
  if (ctx.spriteAtlasLoop?.recordHit(projectileEntity)) ctx.onAtlasHit?.();
  if (recordTargetProfileHit(ctx.targetProfile, entity)) ctx.onProfileHit?.();
  const basePoints = scoringPoints(ctx.world, entity);
  const points = basePoints === undefined
    ? undefined
    : resolveTargetImpactPoints(targetProfilePoints(ctx.targetProfile, basePoints), impactScale);
  if (points !== undefined) {
    const award = ctx.hitStreak?.recordHit(points) ?? { points, hits: 0, multiplier: 1 };
    ctx.changeDetection.recordHit(entity, award.points);
    ctx.damageTarget(entity, award.points);
    ctx.spawnPopup(`+${award.points}`, fx, fy + 0.8, fz);
    if (ctx.worldScoreText?.snapshot().fontSource === 'ttf-plugin' && ctx.spriteAtlasLoop?.active !== true) ctx.onFontScore?.();
    ctx.onVideoHit?.();
    ctx.onFbxHit?.(entity);
    ctx.gameplayAudio?.triggerHit();
  }
  if (relayWasActive && ctx.targetRelay.recordHit(entity)) ctx.onRelayHit?.();
  const flash = ctx.world.get(entity, HitFlash);
  if (!flash.ok || flash.value.remaining <= 0) ctx.triggerFlash(entity);
}

/** Own the transient HitFlash lifecycle; physical admission lives in projectile-impact. */
export function installTargetFeedbackSystem(ctx: TargetFeedbackSystemContext): void {
  ctx.world.addSystem(FixedUpdate, {
    name: 'game-target-feedback',
    runIf: inState(GameState, 'Play'),
    after: ['game-projectile-simulation'],
    queries: [],
    fn: () => {
      const dt = ctx.world.getResource(FixedTime).delta;
      for (const entity of activeScoringTargetEntities(ctx.targetQuery)) {
        const flash = ctx.world.get(entity, HitFlash);
        if (!flash.ok || flash.value.remaining <= 0) continue;
        const remaining = flash.value.remaining - dt;
        if (remaining <= 0) {
          ctx.world.set(entity, MeshRenderer, { materials: [...ctx.materialsForCurrentMesh(entity, false)] });
          ctx.world.set(entity, HitFlash, { remaining: 0 });
        } else {
          ctx.world.set(entity, HitFlash, { remaining });
        }
      }
      const intensity = ctx.chromaticAberration.snapshot().intensity;
      if (intensity > 0) ctx.chromaticAberration.setIntensity(Math.max(0, intensity - dt * 0.14));
    },
  }).unwrap();
}
