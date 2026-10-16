import { describe, expect, it } from 'vitest';
import { Disabled, FixedUpdate, World } from '@forgeax/engine-ecs';
import { Context } from '@forgeax/engine-plugin';
import { CollidingEntities, type PhysicsWorld } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { registerStatesPlugin } from '@forgeax/engine-state';
import {
  BouncyBallHazard,
  COUNTERATTACK_COOLDOWN_SECONDS,
  COUNTERATTACK_PRESSURE_TABLE,
  DamageHazard,
  PLAYER_MAX_HEALTH,
  PlayerHealth,
  createCounterattack,
  deriveCounterattackPressure,
  resolveCounterattackContact,
} from '../assets/plugins/counterattack.js';
import {
  Projectile,
  PROJECTILE_ALLEGIANCE_HOSTILE,
} from '../assets/plugins/components/gameplay.js';
import { installGameplayState } from '../assets/plugins/gameplay-state.js';
import { installProjectileImpactSystem } from '../assets/plugins/projectile-impact.js';
import { createRewardChoice } from '../assets/plugins/reward-choice.js';

describe('game-default counterattack pressure', () => {
  it('derives four bounded tiers only from collected EnergyCores', () => {
    expect(deriveCounterattackPressure(-1)).toEqual({
      tier: 0,
      ...COUNTERATTACK_PRESSURE_TABLE[0],
    });
    for (let tier = 0; tier < COUNTERATTACK_PRESSURE_TABLE.length; tier++) {
      expect(deriveCounterattackPressure(tier)).toEqual({
        tier,
        ...COUNTERATTACK_PRESSURE_TABLE[tier],
      });
    }
    expect(deriveCounterattackPressure(99)).toEqual({
      tier: 3,
      ...COUNTERATTACK_PRESSURE_TABLE[3],
    });
  });

  it('keeps baseline motion and raises every pressure dimension monotonically within the chase cap', () => {
    expect(COUNTERATTACK_PRESSURE_TABLE[0]).toEqual({
      patrolSpeed: 1.3,
      chaseSpeed: 2.15,
      pursuitRadius: 10,
    });
    for (let tier = 1; tier < COUNTERATTACK_PRESSURE_TABLE.length; tier++) {
      const previous = COUNTERATTACK_PRESSURE_TABLE[tier - 1];
      const current = COUNTERATTACK_PRESSURE_TABLE[tier];
      expect(current?.patrolSpeed).toBeGreaterThan(previous?.patrolSpeed ?? Number.POSITIVE_INFINITY);
      expect(current?.chaseSpeed).toBeGreaterThan(previous?.chaseSpeed ?? Number.POSITIVE_INFINITY);
      expect(current?.pursuitRadius).toBeGreaterThan(previous?.pursuitRadius ?? Number.POSITIVE_INFINITY);
    }
    expect(COUNTERATTACK_PRESSURE_TABLE[3].chaseSpeed)
      .toBeLessThanOrEqual(COUNTERATTACK_PRESSURE_TABLE[0].chaseSpeed * 1.5);
  });
});

describe('game-default counterattack damage', () => {
  it('restores the authored active hazard and exact transient fields on Reset', () => {
    const world = new World();
    const player = world.spawn(
      { component: PlayerHealth, data: { current: 1, max: 3 } },
      { component: Transform, data: { pos: [0, 0.75, 0] } },
    ).unwrap();
    const hazard = world.spawn(
      { component: BouncyBallHazard, data: { mode: 1, patrolAngle: 2 } },
      { component: DamageHazard, data: { cooldown: 0.7, acceptedHits: 2 } },
      { component: Transform, data: { pos: [-5, 0.55, 4] } },
      { component: Disabled, data: {} },
    ).unwrap();

    const counterattack = createCounterattack(world, player, () => 0);

    expect(world.get(hazard, Disabled).ok).toBe(false);
    expect(world.get(hazard, BouncyBallHazard).unwrap()).toEqual({
      mode: 0,
      patrolAngle: 0,
    });
    expect(world.get(hazard, DamageHazard).unwrap()).toEqual({
      cooldown: 0,
      acceptedHits: 0,
    });
    expect(world.get(player, PlayerHealth).unwrap()).toEqual({ current: 3, max: 3 });
    expect(counterattack.snapshot()).toMatchObject({
      hazardActive: true,
      hazardMode: 'patrol',
      pressureTier: 0,
    });
  });

  it('removes exactly one heart for an admitted contact', () => {
    expect(resolveCounterattackContact({ health: 3, cooldown: 0 })).toEqual({
      health: 2,
      cooldown: 1.2,
      admitted: true,
      defeated: false,
      shieldConsumed: false,
    });
  });

  it('suppresses repeated contact during the attacker cooldown', () => {
    expect(resolveCounterattackContact({ health: 2, cooldown: 0.4 })).toEqual({
      health: 2,
      cooldown: 0.4,
      admitted: false,
      defeated: false,
      shieldConsumed: false,
    });
  });

  it('re-arms BouncyBall with a readable Shield reaction window', () => {
    const world = new World();
    const player = world.spawn(
      { component: Transform, data: { pos: [0, 0.75, 0] } },
    ).unwrap();
    const hazard = world.spawn(
      { component: BouncyBallHazard, data: {} },
      { component: DamageHazard, data: {} },
      { component: Transform, data: { pos: [-5, 0.55, 4] } },
    ).unwrap();
    const counterattack = createCounterattack(world, player, () => 3);
    world.addComponent(hazard, { component: Disabled, data: {} }).unwrap();

    expect(counterattack.arm()).toBe(true);
    expect(world.get(hazard, Disabled).ok).toBe(false);
    expect(world.get(hazard, DamageHazard).unwrap().cooldown)
      .toBeCloseTo(COUNTERATTACK_COOLDOWN_SECONDS);
  });

  it('installs reward then projectile then BouncyBall so Sentinel owns the new Shield', () => {
    const world = new World();
    registerStatesPlugin(world);
    installGameplayState({ context: new Context(), world, reset: () => {} });
    for (const [name, after] of [
      ['physicsCollisionSync', []],
      ['game-player-movement', ['physicsCollisionSync']],
      ['game-energy-core-extraction', ['game-player-movement']],
    ] as const) {
      world.addSystem(FixedUpdate, { name, after: [...after], queries: [], fn: () => {} }).unwrap();
    }
    const player = world.spawn(
      { component: Transform, data: { pos: [0, 0.75, 0] } },
      { component: CollidingEntities, data: { entities: [] } },
      { component: PlayerHealth, data: {} },
    ).unwrap();
    const shield = world.spawn({ component: Transform, data: { pos: [-1.5, 0.3, -2.8] } }).unwrap();
    const overcharge = world.spawn({ component: Transform, data: { pos: [1.5, 0.3, -2.8] } }).unwrap();
    const bouncyBall = world.spawn(
      { component: BouncyBallHazard, data: {} },
      { component: DamageHazard, data: {} },
      { component: Transform, data: { pos: [-5, 0.55, 4] } },
      { component: Disabled, data: {} },
    ).unwrap();
    const sentinel = world.spawn({ component: Transform, data: { pos: [0, 0.9, 8] } }).unwrap();
    const projectile = world.spawn(
      {
        component: Projectile,
        data: {
          source: sentinel,
          allegiance: PROJECTILE_ALLEGIANCE_HOSTILE,
        },
      },
      { component: DamageHazard, data: {} },
      { component: CollidingEntities, data: { entities: [] } },
    ).unwrap();
    const physics = { hasBody: () => true } as unknown as PhysicsWorld;
    const counterattack = createCounterattack(world, player, () => 3);
    world.addComponent(bouncyBall, { component: Disabled, data: {} }).unwrap();
    const reward = createRewardChoice(world, player, {
      pedestals: [
        { entity: shield, localId: 31, kind: 'shield' },
        { entity: overcharge, localId: 32, kind: 'overcharge' },
      ],
    });
    expect(reward).toBeDefined();
    reward!.installSystem({
      physics,
      isAvailable: () => true,
      onProgress: () => {},
      onChange: (snapshot, event) => {
        if (event === 'selected' && snapshot.state === 'shield-ready') counterattack.arm();
      },
    });
    counterattack.installSystem({
      physics,
      rewardChoice: reward,
      requestDefeat: () => {},
      onHit: () => {},
    });
    let sentinelShielded = false;
    installProjectileImpactSystem({
      world,
      player,
      projectileEntities: () => world.get(projectile, Projectile).ok ? [projectile] : [],
      barrierEntity: undefined,
      barrierRoute: undefined,
      counterattack,
      admitTarget: () => {},
      onCoverImpact: () => {},
      consume: (entity) => world.despawn(entity).unwrap(),
      onOutcome: (source, outcome, shielded) => {
        sentinelShielded = source === sentinel && outcome === 'player' && shielded;
      },
      onTargetResolved: () => {},
      after: ['physicsCollisionSync', 'game-reward-choice'],
      before: ['game-counterattack'],
    });
    world.set(player, CollidingEntities, { entities: [shield, bouncyBall] });

    world.update(1 / 60).unwrap();
    world.set(player, CollidingEntities, { entities: [bouncyBall] });
    for (let tick = 0; tick < 120; tick++) world.update(1 / 60).unwrap();

    expect(reward!.snapshot().state).toBe('shield-ready');
    expect(world.get(player, PlayerHealth).unwrap().current).toBe(PLAYER_MAX_HEALTH);
    const guardedDamage = world.get(bouncyBall, DamageHazard).unwrap();
    expect(guardedDamage.cooldown).toBeCloseTo(COUNTERATTACK_COOLDOWN_SECONDS);
    expect(guardedDamage.acceptedHits).toBe(0);

    world.set(projectile, CollidingEntities, { entities: [player] });
    world.update(1 / 60).unwrap();

    expect(sentinelShielded).toBe(true);
    expect(reward!.snapshot()).toMatchObject({
      state: 'consumed',
      shieldConsumptions: 1,
    });
    expect(world.get(player, PlayerHealth).unwrap().current).toBe(PLAYER_MAX_HEALTH);
    expect(counterattack.snapshot().lastShieldedHealth).toBe(PLAYER_MAX_HEALTH);
    expect(world.get(projectile, Projectile).ok).toBe(false);
    expect(world.get(bouncyBall, DamageHazard).unwrap()).toMatchObject({
      acceptedHits: 0,
    });
  });

  it('requests defeat only when the last heart is removed', () => {
    expect(resolveCounterattackContact({ health: 1, cooldown: 0 })).toEqual({
      health: 0,
      cooldown: 1.2,
      admitted: true,
      defeated: true,
      shieldConsumed: false,
    });
  });
});
