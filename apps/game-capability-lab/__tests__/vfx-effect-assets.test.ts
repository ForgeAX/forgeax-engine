import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { Disabled, World } from '@forgeax/engine-ecs';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { Name } from '@forgeax/engine-scene';
import { activeScoringTargetEntities, createScoringTargetQuery, firstScoringTarget, scoringTargetEntities, ScoringTarget } from '../assets/plugins/scoring-target';
import { GAME_DEFAULT_GAMEPLAY_CONFIG, installGameplayConfig } from '../assets/plugins/resources/gameplay';
import { describe, expect, it } from 'vitest';

const assetRoot = resolve(import.meta.dirname, '../assets');

function readEffect(fileName: string) {
  const pack = JSON.parse(readFileSync(resolve(assetRoot, fileName), 'utf8')) as {
    schemaVersion: string;
    packageId: string;
    assets: Record<string, { kind: string; refs: string[]; payload: unknown }>;
  };
  expect(pack.schemaVersion).toBe('3.0.0');
  const sourceKey = fileName.startsWith('hit-') ? 'vfx/hit' : 'vfx/charge';
  const entry = pack.assets[sourceKey];
  expect(entry).toMatchObject({ kind: 'particle-effect' });
  if (entry === undefined) throw new Error(`${fileName} has no asset entry`);
  const parsed = parseParticleEffectSourceV3(entry.payload);
  if (!parsed.ok) throw new Error(parsed.error.hint);
  if ('parent' in parsed.value) throw new Error(`${fileName} must be a root effect`);
  const packageId = PackageId.parse(pack.packageId);
  if (!packageId.ok) throw packageId.error;
  return { guid: AssetGuid.format(AssetGuid.derive(packageId.value, sourceKey)), effect: parsed.value };
}

describe('game-default authored VFX effects', () => {
  it('keeps hit and charge effects as separate GUID-addressed Pack assets', () => {
    const hit = readEffect('hit-vfx-effect.pack.json');
    const charge = readEffect('charge-vfx-effect.pack.json');
    expect(hit.guid).not.toBe(charge.guid);
    expect(hit.effect.emitters.flatMap((emitter) => emitter.renderers.map((renderer) => renderer.kind))).toEqual(['billboard', 'mesh']);
    expect(charge.effect.emitters.flatMap((emitter) => emitter.renderers.map((renderer) => renderer.kind))).toEqual(['billboard', 'mesh']);
  });

  it('keeps scheduling declarative and behavior in reusable WGSL modules', () => {
    const charge = readEffect('charge-vfx-effect.pack.json').effect;
    expect(charge.emitters.map((emitter) => emitter.schedule.rate)).toEqual([14, 4]);
    expect(charge.emitters.map((emitter) => emitter.schedule.loopDuration)).toEqual([0.9, 0.9]);
    expect(charge.emitters.map((emitter) => emitter.schedule.bursts?.[0]?.time)).toEqual([0, 0.15]);
    expect(charge.emitters.map((emitter) => emitter.program.module)).toEqual([
      'charge.vfx.wgsl',
      'charge.vfx.wgsl',
    ]);
    expect(readFileSync(resolve(assetRoot, 'charge.vfx.wgsl'), 'utf8')).toContain('fn vfx_update');
  });

  it('keeps disabled targets in the ECS-owned reset roster', () => {
    const world = new World();
    const target = world.spawn({ component: ScoringTarget, data: { points: 10, slot: 0 } }).unwrap();
    const query = createScoringTargetQuery(world);
    expect(activeScoringTargetEntities(query)).toEqual([target]);
    world.addComponent(target, { component: Disabled, data: {} }).unwrap();
    expect(activeScoringTargetEntities(query)).toHaveLength(0);
    expect(scoringTargetEntities(query)).toEqual([target]);
    world.removeComponent(target, Disabled).unwrap();
    expect(activeScoringTargetEntities(query)).toEqual([target]);
  });

  it('prefers the authored RedBox as the primary mission target', () => {
    const world = new World();
    const incidental = world.spawn({ component: ScoringTarget, data: { points: 25, slot: 0 } }).unwrap();
    const authored = world.spawn(
      { component: Name, data: { value: 'RedBox' } },
      { component: ScoringTarget, data: { points: 10, slot: 1 } },
    ).unwrap();
    const query = createScoringTargetQuery(world);
    expect(firstScoringTarget(world, query)).toBe(authored);
    expect(firstScoringTarget(world, query)).not.toBe(incidental);
  });

  it('keeps tuning discoverable as one ECS World resource', () => {
    const world = new World();
    installGameplayConfig(world, {
      movement: { speed: 6, bound: 11, playerY: 0.75, jumpVelocity: 6.5, gravity: 18 },
      camera: {
        topDownY: 13,
        topDownOffsetZ: 9,
        follow: 8,
        eyeHeight: 0.55,
        panSpeed: 8,
        panHalfHeightMin: 3,
        panHalfHeightMax: 14,
        topQuaternion: [0, 0, 0, 1],
      },
      projectile: { radius: 0.12, halfHeight: 0.16, speed: 24, life: 1.5, shootCooldown: 0.18 },
      sentinel: { telegraphTicks: 45, cooldownTicks: 90, projectileSpeed: 10, projectileLife: 2.5 },
    });
    expect(world.getResource<{ movement: { speed: number } }>(GAME_DEFAULT_GAMEPLAY_CONFIG).movement.speed).toBe(6);
  });
});
