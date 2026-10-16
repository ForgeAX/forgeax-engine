import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FixedUpdate, World, type EntityHandle } from '@forgeax/engine-ecs';
import { Context } from '@forgeax/engine-plugin';
import { Collider, ColliderShapeValue, CollidingEntities, RigidBody, RigidBodyTypeValue, type PhysicsWorld } from '@forgeax/engine-physics';
import { MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { registerStatesPlugin } from '@forgeax/engine-state';
import {
  projectSentinelAvailability,
  readSentinelEncounterReadiness,
  resolveAuthoredSentinelIdentity,
} from '../assets/plugins/sentinel-authorship';
import { installProjectileImpactSystem, resolveProjectileImpact } from '../assets/plugins/projectile-impact';
import {
  advanceSentinelCadence,
  createSentinelRangedThreat,
  initialSentinelCadence,
  SENTINEL_COOLDOWN_TICKS,
  SENTINEL_TELEGRAPH_TICKS,
} from '../assets/plugins/sentinel-ranged-threat';
import {
  Projectile,
  PROJECTILE_ALLEGIANCE_PLAYER,
  Sentinel,
} from '../assets/plugins/components/gameplay';
import { installGameplayState } from '../assets/plugins/gameplay-state';
import { installDefaultGameplayConfig } from '../assets/plugins/resources/gameplay';
import { ScoringTarget } from '../assets/plugins/scoring-target';
import {
  attachScenePhysics,
  PROJECTILE_COVER_SOLVER_GROUPS,
  YELLOW_TARGET_SOLVER_GROUPS,
} from '../assets/plugins/scene-runtime';

describe('sentinel ranged threat owner', () => {
  const loaded = (nodes: ReadonlyArray<{ localId: number; name: string }>) => ({
    nodes: nodes.map((node) => ({
      localId: node.localId,
      components: { Name: { value: node.name } },
    })),
    mapping: new Map(nodes.map((node) => [node.localId, node.localId + 100])),
  }) as unknown as Parameters<typeof resolveAuthoredSentinelIdentity>[0];

  it('uses cover-first deterministic contact priority for both allegiances', () => {
    const contacts = [
      { entity: 9, kind: 'player' as const },
      { entity: 7, kind: 'cover' as const },
      { entity: 8, kind: 'target' as const },
    ];
    expect(resolveProjectileImpact('hostile', 3, contacts)).toEqual({ entity: 7, outcome: 'cover-blocked' });
    expect(resolveProjectileImpact('player', 3, [...contacts].reverse())).toEqual({ entity: 7, outcome: 'cover-blocked' });
  });

  it('ignores source, admits only allegiance-owned targets, and refuses once', () => {
    expect(resolveProjectileImpact('player', 3, [
      { entity: 3, kind: 'target' },
      { entity: 5, kind: 'barrier' },
    ])).toEqual({ entity: 5, outcome: 'barrier' });
    expect(resolveProjectileImpact('hostile', 3, [
      { entity: 3, kind: 'player' },
      { entity: 4, kind: 'other' },
    ])).toEqual({ entity: 4, outcome: 'refused' });
  });

  it('refuses player impacts on dormant Sentinel and admits them after awakening', () => {
    const world = new World();
    registerStatesPlugin(world);
    installGameplayState({ context: new Context(), world, reset: () => {} });
    for (const [name, after] of [
      ['physicsCollisionSync', []],
      ['game-projectile-simulation', ['physicsCollisionSync']],
    ] as const) {
      world.addSystem(FixedUpdate, { name, after: [...after], queries: [], fn: () => {} }).unwrap();
    }
    const player = world.spawn({ component: Transform, data: {} }).unwrap();
    const sentinel = world.spawn(
      { component: Sentinel, data: {} },
      { component: ScoringTarget, data: { points: 10 } },
      { component: Transform, data: { pos: [0, 0.9, 8] } },
    ).unwrap();
    let projectiles: EntityHandle[] = [];
    const spawnShot = (): EntityHandle => {
      const projectile = world.spawn(
        {
          component: Projectile,
          data: { source: player, allegiance: PROJECTILE_ALLEGIANCE_PLAYER },
        },
        { component: CollidingEntities, data: { entities: [sentinel] } },
      ).unwrap();
      projectiles.push(projectile);
      return projectile;
    };
    let admitted = 0;
    const outcomes: string[] = [];
    installProjectileImpactSystem({
      world,
      player,
      projectileEntities: () => projectiles,
      barrierEntity: undefined,
      barrierRoute: undefined,
      counterattack: undefined,
      admitTarget: () => { admitted += 1; },
      onCoverImpact: () => {},
      consume: (entity) => {
        world.despawn(entity).unwrap();
        projectiles = projectiles.filter((candidate) => candidate !== entity);
      },
      onOutcome: (_source, outcome) => { outcomes.push(outcome); },
      onTargetResolved: () => {},
      after: ['physicsCollisionSync', 'game-projectile-simulation'],
      before: [],
    });

    spawnShot();
    world.update(1 / 60).unwrap();
    expect(admitted).toBe(0);
    expect(outcomes).toEqual(['refused']);

    world.set(sentinel, Sentinel, { mode: 1 });
    spawnShot();
    world.update(1 / 60).unwrap();
    expect(admitted).toBe(1);
    expect(outcomes).toEqual(['refused', 'target']);
  });

  it('wakes from the first real core, freezes aim for 45 ticks, then cools down for 90', () => {
    let state = initialSentinelCadence();
    state = advanceSentinelCadence(state, { collected: 1, playerChest: [1, 2, 3] });
    expect(state).toMatchObject({ mode: 'telegraph', ticks: SENTINEL_TELEGRAPH_TICKS, aim: [1, 2, 3] });
    for (let tick = 0; tick < SENTINEL_TELEGRAPH_TICKS; tick++) {
      state = advanceSentinelCadence(state, { collected: 1, playerChest: [9, 9, 9] });
    }
    expect(state).toMatchObject({ mode: 'cooldown', ticks: SENTINEL_COOLDOWN_TICKS, shotsFired: 1, aim: [1, 2, 3] });
    for (let tick = 0; tick < SENTINEL_COOLDOWN_TICKS; tick++) {
      state = advanceSentinelCadence(state, { collected: 1, playerChest: [4, 5, 6] });
    }
    expect(state).toMatchObject({ mode: 'telegraph', ticks: SENTINEL_TELEGRAPH_TICKS, aim: [4, 5, 6] });
  });

  it('cancels cadence while Disabled or outside Play', () => {
    const telegraph = advanceSentinelCadence(initialSentinelCadence(), { collected: 1, playerChest: [1, 2, 3] });
    expect(advanceSentinelCadence(telegraph, { collected: 1, playerChest: [1, 2, 3], disabled: true }).mode).toBe('dormant');
    expect(advanceSentinelCadence(telegraph, { collected: 1, playerChest: [1, 2, 3], playing: false }).mode).toBe('dormant');
  });

  it('authors stable Sentinel and cover identities 35-37', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Record<string, { payload: { entities?: Record<string, { components: { Name?: { value?: string } } }> } }>;
    };
    const entities = Object.values(pack.assets).flatMap((asset) => Object.entries(asset.payload.entities ?? {}));
    expect(entities.filter((entity) => ['Sentinel', 'ProjectileCoverLeft', 'ProjectileCoverRight']
      .includes(entity[1].components.Name?.value ?? ''))
      .map(([key, entity]) => [key, entity.components.Name?.value])).toEqual([
      ['sentinel', 'Sentinel'],
      ['projectilecoverleft', 'ProjectileCoverLeft'],
      ['projectilecoverright', 'ProjectileCoverRight'],
    ]);
  });

  it('keeps the rotating kinematic YellowPillar off projectile-cover solver contacts', () => {
    const world = new World();
    const entities = [6, 36, 37].map(() => world.spawn({ component: Transform, data: {} }).unwrap());
    attachScenePhysics({ world }, {
      mapping: new Map([[6, entities[0]!], [36, entities[1]!], [37, entities[2]!]]),
      nodes: [
        { localId: 6, components: { Name: { value: 'YellowPillar' }, Transform: { scale: [0.6, 1.5, 0.6] } } },
        { localId: 36, components: { Name: { value: 'ProjectileCoverLeft' }, Transform: { scale: [1.6, 1.8, 0.6] } } },
        { localId: 37, components: { Name: { value: 'ProjectileCoverRight' }, Transform: { scale: [1.6, 1.8, 0.6] } } },
      ],
    });
    const yellowCollider = world.get(entities[0]!, Collider).unwrap();
    const yellowGroups = yellowCollider.solverGroups;
    const coverGroups = world.get(entities[1]!, Collider).unwrap().solverGroups;
    const interacts = (left: number, right: number) => (
      ((left >>> 16) & (right & 0xffff)) !== 0
      && ((right >>> 16) & (left & 0xffff)) !== 0
    );
    expect(yellowGroups).toBe(YELLOW_TARGET_SOLVER_GROUPS);
    expect(yellowCollider.shape).toBe(ColliderShapeValue.capsule);
    expect(yellowCollider.radius).toBeCloseTo(0.3);
    expect(yellowCollider.halfHeight).toBeCloseTo(0.45);
    expect(world.get(entities[0]!, RigidBody).unwrap().type).toBe(RigidBodyTypeValue.kinematic);
    expect(world.get(entities[2]!, Collider).unwrap().solverGroups).toBe(PROJECTILE_COVER_SOLVER_GROUPS);
    expect(interacts(yellowGroups, coverGroups)).toBe(false);
    expect(interacts(yellowGroups, 0xffff_ffff)).toBe(true);
    expect(interacts(coverGroups, 0xffff_ffff)).toBe(true);
  });

  it('fails closed for missing, duplicate, mismatched, and physics-unready authored encounters', () => {
    const missing = resolveAuthoredSentinelIdentity(loaded([]));
    const duplicate = resolveAuthoredSentinelIdentity(loaded([
      { localId: 35, name: 'Sentinel' },
      { localId: 38, name: 'Sentinel' },
      { localId: 36, name: 'ProjectileCoverLeft' },
      { localId: 37, name: 'ProjectileCoverRight' },
    ]));
    const mismatch = resolveAuthoredSentinelIdentity(loaded([
      { localId: 34, name: 'Sentinel' },
      { localId: 36, name: 'ProjectileCoverLeft' },
      { localId: 37, name: 'ProjectileCoverRight' },
    ]));
    const readyIdentity = resolveAuthoredSentinelIdentity(loaded([
      { localId: 35, name: 'Sentinel' },
      { localId: 36, name: 'ProjectileCoverLeft' },
      { localId: 37, name: 'ProjectileCoverRight' },
    ]));
    expect(missing.available ? null : missing.unavailableReason.code).toBe('authored-sentinel-missing');
    expect(duplicate.available ? null : duplicate.unavailableReason.code).toBe('authored-sentinel-duplicate');
    expect(mismatch.available ? null : mismatch.unavailableReason.code).toBe('authored-local-id-mismatch');
    const unavailable = projectSentinelAvailability(readyIdentity, { sentinel: true, covers: [true, false] });
    expect(unavailable).toMatchObject({ available: false, unavailableReason: { code: 'physics-unavailable' } });
    expect(JSON.parse(JSON.stringify(unavailable))).toEqual(unavailable);
    expect(projectSentinelAvailability(readyIdentity, { sentinel: true, covers: [true, true] }))
      .toEqual({ available: true, unavailableReason: null });
  });

  it('holds the installed cadence on the same Sentinel-plus-two-cover readiness projected to inspection', () => {
    const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 1 } });
    registerStatesPlugin(world);
    installGameplayState({ context: new Context(), world, reset: () => {} });
    installDefaultGameplayConfig(world, {
      playerY: 0.75,
      topQuaternion: [0, 0, 0, 1],
      bulletRadius: 0.12,
      bulletHalfHeight: 0.18,
    });
    const player = world.spawn(
      { component: Transform, data: { pos: [0, 0.75, 0] } },
    ).unwrap();
    const sentinel = world.spawn(
      { component: Transform, data: { pos: [0, 0.9, 8] } },
      { component: MeshRenderer, data: { materials: [] } },
      { component: Sentinel, data: {} },
    ).unwrap();
    const left = world.spawn({ component: Transform, data: {} }).unwrap();
    const right = world.spawn({ component: Transform, data: {} }).unwrap();
    const identity = {
      available: true,
      identity: {
        sentinel,
        sentinelLocalId: 35,
        covers: [{ entity: left, localId: 36 }, { entity: right, localId: 37 }],
      },
      unavailableReason: null,
    } as const;
    const readyBodies = new Set<number>([sentinel, left]);
    const physics = {
      hasBody: (entity: number) => readyBodies.has(entity),
    } as unknown as PhysicsWorld;
    const readiness = () => readSentinelEncounterReadiness(identity, physics);
    const threat = createSentinelRangedThreat({
      world,
      entity: sentinel,
      player,
      extraction: { snapshot: () => ({ collected: 1 }) } as never,
      readiness,
      presentation: { hostileProjectileMaterial: 1 } as never,
      projectileEntities: () => [],
      consumeProjectile: () => {},
      onSpawn: () => {},
    });
    threat.installSystem();

    for (let tick = 0; tick < SENTINEL_TELEGRAPH_TICKS + 2; tick++) {
      world.update(1 / 60).unwrap();
    }
    expect(readiness()).toMatchObject({
      available: false,
      unavailableReason: { code: 'physics-unavailable' },
      sentinelBodyReady: true,
      coverBodiesReady: [true, false],
    });
    expect(threat.snapshot()).toMatchObject({ mode: 'dormant', shotsFired: 0 });

    readyBodies.add(right);
    world.update(1 / 60).unwrap();
    expect(readiness()).toMatchObject({ available: true, unavailableReason: null });
    expect(threat.snapshot()).toMatchObject({
      mode: 'telegraph',
      ticks: SENTINEL_TELEGRAPH_TICKS,
      shotsFired: 0,
    });
  });
});
