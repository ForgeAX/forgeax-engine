import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveCounterattackContact } from '../assets/plugins/counterattack.js';
import {
  OVERCHARGE_IMPACT_MULTIPLIER,
  resolveProjectileSpawn,
} from '../assets/plugins/systems/projectile-simulation.js';
import { resolveTargetImpactPoints } from '../assets/plugins/systems/target-feedback.js';
import {
  resolveRewardChoiceContacts,
  type RewardPedestalContact,
} from '../assets/plugins/reward-choice.js';
import { SCENE_GUID } from '../assets/plugins/scene-runtime.js';

const pedestals: readonly RewardPedestalContact[] = [
  { entity: 301, authoredLocalId: 31, kind: 'shield' },
  { entity: 302, authoredLocalId: 32, kind: 'overcharge' },
];

describe('arena reward choice', () => {
  it('admits only an available player choice and resolves simultaneous contacts by authored order', () => {
    expect(resolveRewardChoiceContacts([302, 301], pedestals, 'none', false)).toEqual({
      state: 'none',
      selected: null,
      refusal: 'unavailable',
      simultaneous: true,
    });
    expect(resolveRewardChoiceContacts([302, 301], pedestals, 'none', true)).toEqual({
      state: 'shield-ready',
      selected: 'shield',
      refusal: null,
      simultaneous: true,
    });
    expect(resolveRewardChoiceContacts([302], pedestals, 'shield-ready', true)).toEqual({
      state: 'shield-ready',
      selected: null,
      refusal: 'locked',
      simultaneous: false,
    });
  });

  it('consumes shield only at the otherwise-admitted live hazard edge', () => {
    expect(resolveCounterattackContact({ health: 3, cooldown: 0, shieldReady: true })).toEqual({
      health: 3,
      cooldown: 1.2,
      admitted: true,
      defeated: false,
      shieldConsumed: true,
    });
    expect(resolveCounterattackContact({ health: 3, cooldown: 0.4, shieldReady: true })).toEqual({
      health: 3,
      cooldown: 0.4,
      admitted: false,
      defeated: false,
      shieldConsumed: false,
    });
    expect(resolveCounterattackContact({ health: 3, cooldown: 0, shieldReady: false }).health).toBe(2);
  });

  it('consumes overcharge only for the next actually spawned charged projectile', () => {
    expect(resolveProjectileSpawn({ normalFire: false, chargedFire: true, cooldown: 0.1, chargePower: 2.5, overchargeReady: true })).toEqual({
      spawned: false,
      impactScale: 1,
      consumeOvercharge: false,
    });
    expect(resolveProjectileSpawn({ normalFire: true, chargedFire: false, cooldown: 0, chargePower: 2.5, overchargeReady: true })).toEqual({
      spawned: true,
      impactScale: 1,
      consumeOvercharge: false,
    });
    expect(resolveProjectileSpawn({ normalFire: false, chargedFire: true, cooldown: 0, chargePower: 2.5, overchargeReady: true })).toEqual({
      spawned: true,
      impactScale: 2.5 * OVERCHARGE_IMPACT_MULTIPLIER,
      consumeOvercharge: true,
    });
    const baseline = resolveProjectileSpawn({ normalFire: false, chargedFire: true, cooldown: 0, chargePower: 2.5, overchargeReady: false });
    expect(baseline.impactScale).toBe(2.5);
    expect(resolveTargetImpactPoints(20, 2.5 * OVERCHARGE_IMPACT_MULTIPLIER)).toBe(100);
    expect(resolveTargetImpactPoints(20, baseline.impactScale)).toBe(50);
  });

  it('authors exactly two stable reward pedestals in the default SceneAsset', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8'));
    const scene = pack.assets['scene/main'];
    expect(SCENE_GUID).toBe('4a673a93-24b5-56d8-9413-0f2e4e82c088');
    const entities = (scene?.payload.entities ?? {}) as Record<string, { components: { Name?: { value?: string } } }>;
    const rewards = Object.entries(entities).filter(
      ([, entity]) => entity.components.Name?.value === 'ShieldPedestal' || entity.components.Name?.value === 'OverchargePedestal',
    );
    expect(rewards.map(([key, reward]) => [key, reward.components.Name?.value])).toEqual([
      ['shieldpedestal', 'ShieldPedestal'],
      ['overchargepedestal', 'OverchargePedestal'],
    ]);
  });
});
