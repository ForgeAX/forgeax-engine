import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { componentDefinition, componentSchema } from '@forgeax/engine-ecs/internal';
import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ParticleEffectPlayer, type ParticleEffectPlayerData } from '../index.js';
import { cookedEffectFixture } from './cooked-effect-fixture';
import { runtimeEffectFixture } from './runtime-effect-fixture';

const asset = await cookedEffectFixture({
  program: { emitters: [{ id: 'player', capacity: 4, renderers: [] }] },
});

describe('ParticleEffectPlayer ECS contract', () => {
  it('exposes author intent and opt-in preparation with stable defaults with stable defaults', () => {
    expect(Object.keys(componentSchema(ParticleEffectPlayer))).toEqual([
      'effect',
      'playing',
      'preparePipelines',
      'seed',
      'timeScale',
    ]);
    expect(componentSchema(ParticleEffectPlayer)).toEqual({
      effect: 'asset<particle-effect>',
      playing: 'bool',
      preparePipelines: 'bool',
      seed: 'u32',
      timeScale: 'f32',
    });
    expect(componentDefinition(ParticleEffectPlayer).defaults).toEqual({
      playing: true,
      preparePipelines: false,
      seed: 0,
      timeScale: 1,
    });
    expect(ParticleEffectPlayer.fields.effect.type).toBe('asset<particle-effect>');
    expect(ParticleEffectPlayer.fields.playing.default).toBe(true);
    expect(ParticleEffectPlayer.fields.seed.default).toBe(0);
    expect(ParticleEffectPlayer.fields.timeScale.default).toBe(1);
  });

  it('round-trips a scene-compatible player payload without changing intent', () => {
    const world = new World({ assets: new AssetRegistry() });
    const effect = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, asset))
      .unwrap();
    const payload: ParticleEffectPlayerData = {
      effect,
      playing: false,
      preparePipelines: false,
      seed: 42,
      timeScale: 0.5,
    };
    const roundTrip: unknown = JSON.parse(JSON.stringify(payload));

    expect(roundTrip).toEqual(payload);
  });

  it('uses the shared asset identity in a real spawn and QueryRow loop', () => {
    const world = new World({ assets: new AssetRegistry() });
    const effect = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, asset))
      .unwrap();
    const entity = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect, playing: true, seed: 7, timeScale: 0.25 },
      })
      .unwrap();
    const query = world.query({ read: [ParticleEffectPlayer] }).unwrap();
    let observed = false;

    for (const row of query) {
      const player = row.get(ParticleEffectPlayer);
      expectTypeOf(player.effect).toEqualTypeOf<AssetHandle<'particle-effect'>>();
      expectTypeOf(player.playing).toBeBoolean();
      expectTypeOf(player.seed).toBeNumber();
      expectTypeOf(player.timeScale).toBeNumber();
      expect(player.effect).toBe(effect);
      observed = true;
    }

    expect(entity).toBeDefined();
    expect(observed).toBe(true);
  });

  it('keeps the shared-ref data shape assignable to the public handle contract', () => {
    const world = new World({ assets: new AssetRegistry() });
    const effect: AssetHandle<'particle-effect'> = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, asset))
      .unwrap();
    expectTypeOf<ParticleEffectPlayerData['effect']>().toEqualTypeOf<
      AssetHandle<'particle-effect'>
    >();
    expect(effect).toBeGreaterThan(0);
  });
});
