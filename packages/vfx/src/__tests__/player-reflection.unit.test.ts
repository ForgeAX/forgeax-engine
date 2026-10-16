import { World } from '@forgeax/engine-ecs';
import { componentDefinition, componentSchema } from '@forgeax/engine-ecs/internal';
import type { Handle, ParticleEffectAsset } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ParticleEffectPlayer, type ParticleEffectPlayerData } from '../index.js';

const asset: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 3,
  programFingerprint: 'sha256:test',
  emitters: [],
  program: { format: 'forgeax-vfx-program-4', fingerprint: 'sha256:test', emitters: [] },
};

describe('ParticleEffectPlayer ECS contract', () => {
  it('exposes exactly the four author-intent fields with stable defaults', () => {
    expect(Object.keys(componentSchema(ParticleEffectPlayer))).toEqual([
      'effect',
      'playing',
      'seed',
      'timeScale',
    ]);
    expect(componentSchema(ParticleEffectPlayer)).toEqual({
      effect: 'shared<ParticleEffectAsset>',
      playing: 'bool',
      seed: 'u32',
      timeScale: 'f32',
    });
    expect(componentDefinition(ParticleEffectPlayer).defaults).toEqual({
      playing: true,
      seed: 0,
      timeScale: 1,
    });
    expect(ParticleEffectPlayer.fields.effect.type).toBe('shared<ParticleEffectAsset>');
    expect(ParticleEffectPlayer.fields.playing.default).toBe(true);
    expect(ParticleEffectPlayer.fields.seed.default).toBe(0);
    expect(ParticleEffectPlayer.fields.timeScale.default).toBe(1);
  });

  it('round-trips a scene-compatible player payload without changing intent', () => {
    const world = new World();
    const effect = world.allocSharedRef('ParticleEffectAsset', asset);
    const payload: ParticleEffectPlayerData = {
      effect,
      playing: false,
      seed: 42,
      timeScale: 0.5,
    };
    const roundTrip: unknown = JSON.parse(JSON.stringify(payload));

    expect(roundTrip).toEqual(payload);
  });

  it('uses the shared asset identity in a real spawn and QueryRow loop', () => {
    const world = new World();
    const effect = world.allocSharedRef('ParticleEffectAsset', asset);
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
      expectTypeOf(player.effect).toEqualTypeOf<Handle<'ParticleEffectAsset', 'shared'>>();
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
    const world = new World();
    const effect: Handle<'ParticleEffectAsset', 'shared'> = world.allocSharedRef(
      'ParticleEffectAsset',
      asset,
    );
    expectTypeOf<ParticleEffectPlayerData['effect']>().toEqualTypeOf<
      Handle<'ParticleEffectAsset', 'shared'>
    >();
    expect(effect).toBeGreaterThan(0);
  });
});
