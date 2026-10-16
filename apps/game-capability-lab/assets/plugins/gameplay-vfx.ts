import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { FixedTime, FixedUpdate, type ComponentData, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { renderFeaturePlugin } from '@forgeax/engine-app';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';

const HIT_VFX_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse('019fb264-1000-7000-8000-000000000010');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
export const GAME_DEFAULT_HIT_VFX_GUID = AssetGuid.format(
  AssetGuid.derive(HIT_VFX_PACKAGE_NAMESPACE, 'vfx/hit'),
);
const CHARGE_VFX_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse('019fb264-1000-7000-8000-000000000020');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
export const GAME_DEFAULT_CHARGE_VFX_GUID = AssetGuid.format(
  AssetGuid.derive(CHARGE_VFX_PACKAGE_NAMESPACE, 'vfx/charge'),
);
export const GAME_DEFAULT_BOSS_TELEGRAPH_VFX_GUID = '019e9c00-0000-7000-8000-000000000100';
export const GAME_DEFAULT_BOSS_FLIGHT_VFX_GUID = '019e9c00-0000-7000-8000-000000000101';
export const GAME_DEFAULT_BOSS_CONTACT_VFX_GUID = '019e9c00-0000-7000-8000-000000000102';

export type VfxHitLoopMode = 'hit' | 'charge';
export interface VfxHitLoopSnapshot {
  readonly available: boolean; readonly mode: VfxHitLoopMode; readonly playing: boolean;
  readonly seed: number; readonly triggers: number; readonly guid: string | null;
  readonly emitterCount: number; readonly emitterStatuses: readonly string[];
  readonly batchKinds: readonly string[]; readonly alive: number; readonly bucketCount: number;
  readonly readiness: string; readonly errorCode: string | null; readonly errorHint: string | null;
}
export type BossVfxPhase = 'dormant' | 'telegraph' | 'flight' | 'contact';
export interface GameplayVfxSnapshot extends VfxHitLoopSnapshot {
  readonly hostCount: number; readonly attachedWorlds: number; readonly installedFeatures: number;
  readonly suiteGuid: string | null; readonly suiteEmitterCount: number;
  readonly rendererKinds: readonly string[]; readonly phase: BossVfxPhase;
  readonly eventSequence: number; readonly telegraphEvents: number; readonly flightEvents: number;
  readonly contactEvents: number; readonly activePlayers: number; readonly activeCarriers: number;
  readonly lastPosition: readonly [number, number, number] | null;
}
export interface VfxHitLoop {
  readonly trigger: () => void; readonly beginCharge: () => void; readonly endCharge: () => void;
  readonly triggerCharge: () => void; readonly reset: () => void;
  readonly snapshot: () => VfxHitLoopSnapshot; readonly dispose: () => Promise<void>;
}
export interface GameplayVfx extends VfxHitLoop {
  readonly beginTelegraph: (position: readonly [number, number, number]) => void;
  readonly flightPresentation: () => readonly ComponentData[];
  readonly attackFlightPresentation: () => readonly ComponentData[];
  readonly attachFlight: (entity: EntityHandle) => void;
  readonly stopFlight: (entity: EntityHandle) => void;
  readonly stopAttackFlight: (entity: EntityHandle) => void;
  readonly emitImpact: (position: readonly [number, number, number]) => void;
  readonly emitAttackImpact: (position: readonly [number, number, number], overcharged: boolean) => void;
  readonly stopAttackEffects: () => void;
  readonly resetAttack: () => void;
  readonly stopHostile: () => void;
  readonly bossSnapshot: () => GameplayVfxSnapshot;
}

function failure(error: unknown): { readonly code: string; readonly hint: string } {
  if (error !== null && typeof error === 'object') {
    const value = error as { readonly code?: unknown; readonly hint?: unknown };
    return { code: typeof value.code === 'string' ? value.code : 'vfx-host-failed', hint: typeof value.hint === 'string' ? value.hint : 'inspect the VFX host failure detail' };
  }
  return { code: 'vfx-host-failed', hint: String(error) };
}
function cameraSource(camera: EntityHandle) {
  return { read(currentWorld: World) {
    const transform = currentWorld.get(camera, Transform); const cameraValue = currentWorld.get(camera, Camera);
    if (!transform.ok || !cameraValue.ok) return undefined;
    const position = new Float32Array(transform.value.pos); const rotation = transform.value.quat;
    const right = quat.right(vec3.create(), rotation); const up = quat.up(vec3.create(), rotation); const forward = quat.forward(vec3.create(), rotation);
    const target = vec3.create(); vec3.add(target, position, forward); let viewProjection: Float32Array;
    if (cameraValue.value.projection === 1) {
      const halfWidth = (cameraValue.value.right - cameraValue.value.left) * 0.5; const halfHeight = (cameraValue.value.top - cameraValue.value.bottom) * 0.5;
      const projection = mat4.orthographicReverseZ(mat4.create(), -halfWidth, halfWidth, halfHeight, -halfHeight, cameraValue.value.near, cameraValue.value.far);
      viewProjection = mat4.multiply(mat4.create(), projection, mat4.lookAt(mat4.create(), position, target, up));
    } else viewProjection = mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), cameraValue.value.fov, cameraValue.value.aspect, cameraValue.value.near, cameraValue.value.far), mat4.lookAt(mat4.create(), position, target, up));
    return { position, right, up, viewProjection };
  } };
}
function unavailable(errorCode: string | null, errorHint: string | null): VfxHitLoopSnapshot {
  return { available: false, mode: 'hit', playing: false, seed: 0, triggers: 0, guid: null, emitterCount: 0, emitterStatuses: [], batchKinds: [], alive: 0, bucketCount: 0, readiness: 'unavailable', errorCode, errorHint };
}

export async function createGameplayVfx(options: {
  readonly context: import('@forgeax/engine-plugin').Context;
  readonly world: World; readonly assets?: AssetRegistry;
  readonly target?: EntityHandle; readonly sentinel?: EntityHandle; readonly camera: EntityHandle;
}): Promise<GameplayVfx> {
  const noop = (reason: string, hint: string): GameplayVfx => {
    const base = unavailable(reason, hint);
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => base, dispose: async () => undefined, beginTelegraph: () => undefined, flightPresentation: () => [], attackFlightPresentation: () => [], attachFlight: () => undefined, stopFlight: () => undefined, stopAttackFlight: () => undefined, emitImpact: () => undefined, emitAttackImpact: () => undefined, stopAttackEffects: () => undefined, resetAttack: () => undefined, stopHostile: () => undefined, bossSnapshot: () => ({ ...base, hostCount: 0, attachedWorlds: 0, installedFeatures: 0, suiteGuid: null, suiteEmitterCount: 0, rendererKinds: [], phase: 'dormant', eventSequence: 0, telegraphEvents: 0, flightEvents: 0, contactEvents: 0, activePlayers: 0, activeCarriers: 0, lastPosition: null }), };
  };
  const { context, world, assets, target, sentinel, camera } = options;
  if (assets === undefined || target === undefined) return noop('host-unavailable', 'VFX needs the Preview AssetRegistry and a scored target.');
  const host = createVfxRuntimeHost({ camera: cameraSource(camera) });
  const attached = await host.attachWorld({ world, assets });
  if (!attached.ok) { const cause = failure(attached.error); return noop(cause.code, cause.hint); }
  const guids = [GAME_DEFAULT_HIT_VFX_GUID, GAME_DEFAULT_CHARGE_VFX_GUID, GAME_DEFAULT_BOSS_TELEGRAPH_VFX_GUID, GAME_DEFAULT_BOSS_FLIGHT_VFX_GUID, GAME_DEFAULT_BOSS_CONTACT_VFX_GUID] as const;
  const loaded = await Promise.all(guids.map((guid) => loadVfxGpuEffect(assets, guid)));
  const effects: VfxGpuEffectAsset[] = [];
  for (const entry of loaded) {
    if (!entry.ok) { const cause = failure(entry.error); await host.detachWorld({ world }); return noop(cause.code, cause.hint); }
    effects.push(entry.value);
  }
  const [hit, charge, telegraph, flight, contact] = effects as [VfxGpuEffectAsset, VfxGpuEffectAsset, VfxGpuEffectAsset, VfxGpuEffectAsset, VfxGpuEffectAsset];
  const hitEffect = world.allocSharedRef('ParticleEffectAsset', hit); const chargeEffect = world.allocSharedRef('ParticleEffectAsset', charge); const telegraphEffect = world.allocSharedRef('ParticleEffectAsset', telegraph); const flightEffect = world.allocSharedRef('ParticleEffectAsset', flight); const contactEffect = world.allocSharedRef('ParticleEffectAsset', contact);
  const player = world.addComponent(target, { component: ParticleEffectPlayer, data: { effect: hitEffect, playing: false, seed: 0, timeScale: 1 } });
  if (!player.ok) { await host.detachWorld({ world }); return noop(player.error.code, player.error.hint); }
  try {
    await context.plugin(renderFeaturePlugin(host.feature));
  } catch (cause) {
    await host.detachWorld({ world });
    const failureResult = failure(cause);
    return noop(failureResult.code, failureResult.hint);
  }
  let seed = 0; let mode: VfxHitLoopMode = 'hit'; let playing = false; let triggers = 0; let disposed = false;
  let phase: BossVfxPhase = 'dormant'; let eventSequence = 0; let telegraphEvents = 0; let flightEvents = 0; let contactEvents = 0; let lastPosition: readonly [number, number, number] | null = null;
  const flightEntities = new Set<EntityHandle>(); const impactCarriers = new Map<EntityHandle, number>(); const attackImpactCarriers = new Map<EntityHandle, number>();
  const featureReady = (): boolean => true;
  const writePlayer = (): void => { if (!disposed) world.set(target, ParticleEffectPlayer, { effect: mode === 'hit' ? hitEffect : chargeEffect, playing, seed, timeScale: 1 }); };
  const setEffect = (entity: EntityHandle, effect: typeof telegraphEffect, active: boolean, nextSeed: number): void => { if (!world.get(entity, Transform).ok && entity !== target) return; const existing = world.get(entity, ParticleEffectPlayer); if (existing.ok) world.set(entity, ParticleEffectPlayer, { effect, playing: active, seed: nextSeed, timeScale: 1 }); else world.addComponent(entity, { component: ParticleEffectPlayer, data: { effect, playing: active, seed: nextSeed, timeScale: 1 } }); };
  world.addSystem(FixedUpdate, { name: 'gameplay-vfx-carrier-cleanup', queries: [], fn: (_world, _queries) => { const dt = world.getResource(FixedTime).delta; for (const [entity, ttl] of impactCarriers) { const next = ttl - dt; if (next > 0) impactCarriers.set(entity, next); else { world.despawn(entity); impactCarriers.delete(entity); } } for (const [entity, ttl] of attackImpactCarriers) { const next = ttl - dt; if (next > 0) attackImpactCarriers.set(entity, next); else { world.despawn(entity); attackImpactCarriers.delete(entity); } } if (phase === 'contact' && impactCarriers.size === 0 && attackImpactCarriers.size === 0 && flightEntities.size === 0) { phase = 'dormant'; lastPosition = null; } } }).unwrap();
  const snapshot = (): VfxHitLoopSnapshot => { const runtime = world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY) ? world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY) : undefined; const effect = mode === 'hit' ? hit : charge; const kinds = effect.program.emitters.flatMap((entry) => entry.renderers.map((rendererEntry) => rendererEntry.kind)); return { available: true, mode, playing, seed, triggers, guid: mode === 'hit' ? GAME_DEFAULT_HIT_VFX_GUID : GAME_DEFAULT_CHARGE_VFX_GUID, emitterCount: effect.program.emitters.length, emitterStatuses: effect.program.emitters.map(() => 'gpu'), batchKinds: kinds, alive: 0, bucketCount: new Set(kinds).size, readiness: runtime?.hasPlayer(target) === true ? 'ready' : 'warming', errorCode: null, errorHint: null }; };
  const bossSnapshot = (): GameplayVfxSnapshot => { const base = snapshot(); const suite = [telegraph, flight, contact]; const kinds = suite.flatMap((effect) => effect.program.emitters.flatMap((entry) => entry.renderers.map((rendererEntry) => rendererEntry.kind))); const activeSentinelPlayer = phase === 'telegraph' ? 1 : 0; return { ...base, hostCount: 1, attachedWorlds: 1, installedFeatures: 1, suiteGuid: phase === 'telegraph' ? GAME_DEFAULT_BOSS_TELEGRAPH_VFX_GUID : phase === 'flight' ? GAME_DEFAULT_BOSS_FLIGHT_VFX_GUID : phase === 'contact' ? GAME_DEFAULT_BOSS_CONTACT_VFX_GUID : null, suiteEmitterCount: suite.reduce((sum, effect) => sum + effect.program.emitters.length, 0), rendererKinds: [...new Set(kinds)], phase, eventSequence, telegraphEvents, flightEvents, contactEvents, activePlayers: activeSentinelPlayer + flightEntities.size, activeCarriers: impactCarriers.size, lastPosition }; };
  const api: GameplayVfx = {
    trigger: () => { if (disposed) return; seed = (seed + 1) >>> 0; triggers += 1; mode = 'hit'; playing = true; writePlayer(); },
    beginCharge: () => { if (disposed || (mode === 'charge' && playing)) return; seed = (seed + 1) >>> 0; triggers += 1; mode = 'charge'; playing = true; writePlayer(); },
    endCharge: () => { if (!disposed && mode === 'charge') { playing = false; writePlayer(); } },
    triggerCharge: () => { if (disposed || (mode === 'charge' && playing)) return; seed = (seed + 1) >>> 0; triggers += 1; mode = 'charge'; playing = true; writePlayer(); },
    reset: () => { if (disposed) return; api.stopHostile(); seed = 0; triggers = 0; mode = 'hit'; playing = false; writePlayer(); },
    snapshot,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      api.stopHostile();
      world.set(target, ParticleEffectPlayer, { playing: false });
      await host.detachWorld({ world });
    },
    beginTelegraph: (position) => { if (disposed || !featureReady() || sentinel === undefined || world.get(sentinel, Transform).ok === false) return; seed = (seed + 1) >>> 0; phase = 'telegraph'; eventSequence += 1; telegraphEvents += 1; lastPosition = [...position]; setEffect(sentinel, telegraphEffect, true, seed); },
    flightPresentation: () => featureReady() ? [{ component: ParticleEffectPlayer, data: { effect: flightEffect, playing: true, seed: (seed + 1) >>> 0, timeScale: 1 } }] : [],
    attackFlightPresentation: () => featureReady() ? [{ component: ParticleEffectPlayer, data: { effect: flightEffect, playing: true, seed: (seed + 1) >>> 0, timeScale: 1 } }] : [],
    attachFlight: (entity) => { if (disposed || !featureReady()) return; if (sentinel !== undefined && world.get(sentinel, ParticleEffectPlayer).ok) world.set(sentinel, ParticleEffectPlayer, { playing: false }); flightEntities.add(entity); flightEvents += 1; phase = 'flight'; eventSequence += 1; const transform = world.get(entity, Transform); if (transform.ok) lastPosition = [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]; },
    stopFlight: (entity) => { if (!flightEntities.delete(entity)) return; if (world.get(entity, ParticleEffectPlayer).ok) world.set(entity, ParticleEffectPlayer, { playing: false }); if (phase === 'flight') phase = 'dormant'; },
    stopAttackFlight: (entity) => { if (world.get(entity, ParticleEffectPlayer).ok) world.set(entity, ParticleEffectPlayer, { playing: false }); },
    emitImpact: (position) => { if (disposed || !featureReady()) return; const carrier = world.spawn({ component: Transform, data: { pos: [...position] } }, { component: ParticleEffectPlayer, data: { effect: contactEffect, playing: true, seed: (seed + 1) >>> 0, timeScale: 1 } }); if (!carrier.ok) return; seed = (seed + 1) >>> 0; phase = 'contact'; eventSequence += 1; contactEvents += 1; lastPosition = [...position]; impactCarriers.set(carrier.value, 1.8); },
    emitAttackImpact: (position, overcharged) => { if (disposed || !featureReady()) return; if (!overcharged) { seed = (seed + 1) >>> 0; triggers += 1; mode = 'hit'; playing = true; writePlayer(); return; } const carrier = world.spawn({ component: Transform, data: { pos: [...position] } }, { component: ParticleEffectPlayer, data: { effect: contactEffect, playing: true, seed: (seed + 1) >>> 0, timeScale: 1 } }); if (!carrier.ok) return; seed = (seed + 1) >>> 0; triggers += 1; mode = 'hit'; playing = true; attackImpactCarriers.set(carrier.value, 1.8); },
    stopAttackEffects: () => { if (world.get(target, ParticleEffectPlayer).ok) world.set(target, ParticleEffectPlayer, { playing: false }); for (const entity of attackImpactCarriers.keys()) world.despawn(entity); attackImpactCarriers.clear(); },
    resetAttack: () => { if (disposed) return; api.stopAttackEffects(); },
    stopHostile: () => { if (sentinel !== undefined && world.get(sentinel, ParticleEffectPlayer).ok) world.set(sentinel, ParticleEffectPlayer, { playing: false }); for (const entity of flightEntities) if (world.get(entity, ParticleEffectPlayer).ok) world.set(entity, ParticleEffectPlayer, { playing: false }); flightEntities.clear(); for (const entity of impactCarriers.keys()) world.despawn(entity); impactCarriers.clear(); for (const entity of attackImpactCarriers.keys()) world.despawn(entity); attackImpactCarriers.clear(); phase = 'dormant'; lastPosition = null; },
    bossSnapshot,
  };
  return api;
}

export const createVfxHitLoop = createGameplayVfx;
