import { createWorldContext, defineSystem, FixedUpdate, Time, World } from '@forgeax/engine-ecs';
import {
  Collider,
  PhysicsSimulation,
  type PhysicsSolverOutput,
  type PhysicsWorld,
  PhysicsWorldResource,
  RigidBody,
} from '@forgeax/engine-physics';
import physics3d from '@forgeax/engine-physics-rapier3d';
import type { Plugin } from '@forgeax/engine-plugin';
import { ChildOf, scenePlugin, Transform, WaterPontoonSet } from '@forgeax/engine-scene';
import { processWaterBuoyancySolverTask, WaterSystem } from '@forgeax/engine-water';
import { describe, expect, it, vi } from 'vitest';
import {
  installWaterBuoyancy,
  WATER_BUOYANCY_RESOURCE,
  type WaterBuoyancyState,
} from '../water-buoyancy.js';
import { waterScenePlugin } from '../water-scene-plugin.js';
import { WaterBuoyancy } from '../water-system-order.js';
import { testAssets } from './helpers/runtime-assets.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const state = (world: World) => world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE);
const advance = (world: World, count = 1) => {
  for (let i = 0; i < count; i++) world.update(1 / 60).unwrap();
};

describe('Water buoyancy fixed Runtime assembly', () => {
  it.each([
    1 / 60,
    1 / 20,
    1,
  ])('uses the effective external frame delta at the Water results boundary for host delta %s', async (delta) => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      world.update(delta).unwrap();
      const frameDelta = world.getResource(Time).delta;
      expect(frameDelta).toBe(Math.min(delta, 0.1));
      expect(state(world).async.resultsTimeSeconds).toBeCloseTo(
        requiredFixtureValue(physics.getSolverClock).call(physics).resultsTimeSeconds + frameDelta,
        10,
      );
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it.each([
    1 / 60,
    1 / 20,
  ])('retains Current and every completed event through host delta %s while pending or malformed', async (completionDelta) => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
    const outputs: PhysicsSolverOutput[] = [];
    let deliver = false;
    let corrupt = false;
    // This controls result delivery only; actual Worker execution has separate Browser evidence.
    const participant = vi.spyOn(physics, 'createSolverParticipant').mockImplementation(() => ({
      ok: true,
      value: {
        execution: 'worker-solver',
        asyncResults: true,
        capacity: 64,
        submit(task) {
          const { payload: _payload, ...identity } = task;
          const result = processWaterBuoyancySolverTask(task, {
            solveStep: task.solveStep,
            deltaSeconds: 1 / 60,
            timestampSeconds: task.sourceStep / 60,
            getBodyDynamics: requiredFixtureValue(physics.getCommittedBodyDynamics).bind(physics),
            applyForceAtPoint: requiredFixtureValue(physics.applyBodyForceAtPoint).bind(physics),
            applyTorque: requiredFixtureValue(physics.applyBodyTorque).bind(physics),
            raycast: physics.raycast.bind(physics),
            traceTerrainDown: () => undefined,
          });
          if (!result.ok) throw result.error;
          const frozen = JSON.parse(new TextDecoder().decode(result.value));
          frozen.result.value.splashWakeEvents = [
            {
              sourcePhysicsStep: task.solveStep,
              queryTimeSeconds: task.referenceTimeSeconds,
              fixedDeltaSeconds: 1 / 60,
              rootEntity: task.entity,
              rootGeneration: task.entityGeneration,
              pontoonId: frozen.result.value.pontoons[0].pontoonId,
              phase: 'exited',
              positionM: frozen.result.value.pontoons[0].centerM,
              forceN: [0, 0, 0],
              contact: { kind: 'none', reason: 'exited' },
            },
          ];
          if (corrupt) frozen.result = { ok: true, value: null };
          outputs.push({
            ...identity,
            completedStep: task.solveStep,
            outputTimestampSeconds: task.sourceStep / 60,
            inputReleased: true,
            result: { ok: true, value: new TextEncoder().encode(JSON.stringify(frozen)) },
          });
          return { ok: true, value: undefined };
        },
        cancel: () => true,
        drain: () => {
          if (!deliver) return [];
          deliver = false;
          return outputs.splice(0);
        },
        inspect: () => ({
          queued: 0,
          awaitingCompletion: 0,
          outputs: outputs.length,
          accepted: 0,
          backpressure: 0,
          cancelled: 0,
          stale: 0,
          consumed: 0,
          released: 0,
        }),
        dispose: () => {
          outputs.length = 0;
        },
      },
    }));
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      const root = world
        .spawn(
          { component: Transform },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
          {
            component: WaterPontoonSet,
            data: { anchorsM: [0, 0, 0], radiiM: [0.5], useAsyncPath: true },
          },
        )
        .unwrap();
      advance(world, 2);
      deliver = true;
      world.update(completionDelta).unwrap();
      const selected = state(world).steps.find((row) => row.entity === root);
      expect(selected?.result.ok).toBe(true);
      const consumedEvents = state(world).splashWakeEvents;
      expect(consumedEvents.length).toBeGreaterThan(1);
      expect(consumedEvents.every((event) => event.phase === 'exited')).toBe(true);
      expect(new Set(consumedEvents.map((event) => event.sourcePhysicsStep)).size).toBe(
        consumedEvents.length,
      );
      const observePendingWater = defineSystem({
        name: 'observePendingWater',
        after: [WaterBuoyancy],
        before: [PhysicsSimulation],
        queries: [],
        fn: () => {
          expect(state(world).steps.find((row) => row.entity === root)).toBe(selected);
        },
      });
      world.addSystem(FixedUpdate, observePendingWater).unwrap();
      advance(world);
      expect(state(world).splashWakeEvents).toEqual([]);
      world.removeSystem(FixedUpdate, observePendingWater).unwrap();
      corrupt = true;
      deliver = true;
      advance(world);
      expect(state(world).steps.find((row) => row.entity === root)?.result).toMatchObject({
        ok: false,
        error: { code: 'fixed-input-invalid' },
      });
      world.set(root, WaterPontoonSet, { enabled: false }).unwrap();
      advance(world);
      expect(state(world).steps).toEqual([]);
    } finally {
      release();
      participant.mockRestore();
      await context.fiber.dispose();
    }
  });

  it.each([
    'first',
    'last',
  ] as const)('retains the shared solver when only the %s root disables async', async (position) => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
    const getBodyDynamics = physics.getCommittedBodyDynamics?.bind(physics);
    const applyForceAtPoint = physics.applyBodyForceAtPoint?.bind(physics);
    const applyTorque = physics.applyBodyTorque?.bind(physics);
    if (!getBodyDynamics || !applyForceAtPoint || !applyTorque)
      throw new Error('Rapier committed force operations are required');
    const outputs: PhysicsSolverOutput[] = [];
    const submittedEntities: number[] = [];
    const cancelledEntities: number[] = [];
    let deliver = false;
    const dispose = vi.fn(() => {
      outputs.length = 0;
    });
    const participant = vi.spyOn(physics, 'createSolverParticipant').mockImplementation(() => ({
      ok: true,
      value: {
        execution: 'worker-solver',
        asyncResults: true,
        capacity: 64,
        submit(task) {
          const { payload: _payload, ...identity } = task;
          const result = processWaterBuoyancySolverTask(task, {
            solveStep: task.solveStep,
            deltaSeconds: 1 / 60,
            timestampSeconds: task.sourceStep / 60,
            getBodyDynamics,
            applyForceAtPoint,
            applyTorque,
            raycast: physics.raycast.bind(physics),
            traceTerrainDown: () => undefined,
          });
          if (!result.ok) throw result.error;
          submittedEntities.push(task.entity);
          outputs.push({
            ...identity,
            completedStep: task.solveStep,
            outputTimestampSeconds: task.sourceStep / 60,
            inputReleased: true,
            result,
          });
          return { ok: true, value: undefined };
        },
        cancel(id) {
          const index = outputs.findIndex((output) => output.taskId === id);
          const output = outputs[index];
          if (output) {
            cancelledEntities.push(output.entity);
            outputs.splice(index, 1);
          }
          return output !== undefined;
        },
        drain() {
          if (!deliver) return [];
          deliver = false;
          return outputs.splice(0);
        },
        inspect: () => ({
          queued: 0,
          awaitingCompletion: 0,
          outputs: outputs.length,
          accepted: 0,
          backpressure: 0,
          cancelled: cancelledEntities.length,
          stale: 0,
          consumed: 0,
          released: 0,
        }),
        dispose,
      },
    }));
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    const spawn = () =>
      world
        .spawn(
          { component: Transform },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
          {
            component: WaterPontoonSet,
            data: { anchorsM: [0, 0, 0], radiiM: [0.5], useAsyncPath: true },
          },
        )
        .unwrap();
    try {
      const roots = [spawn(), spawn()] as const;
      const disabled = roots[position === 'first' ? 0 : 1];
      const active = roots[position === 'first' ? 1 : 0];
      advance(world, 2);
      expect(participant).toHaveBeenCalledTimes(1);
      expect(state(world).async.pending).toBeGreaterThan(0);
      world.set(disabled, WaterPontoonSet, { useAsyncPath: false }).unwrap();
      const completed = state(world).async.completed;
      const submitted = submittedEntities.filter((entity) => entity === active).length;
      advance(world);
      expect(dispose).not.toHaveBeenCalled();
      expect(cancelledEntities.length).toBeGreaterThan(0);
      expect(cancelledEntities.every((entity) => entity === disabled)).toBe(true);
      expect(state(world).async.execution).toBe('worker-solver');
      expect(state(world).async.pending).toBeGreaterThan(0);
      expect(submittedEntities.filter((entity) => entity === active).length).toBeGreaterThan(
        submitted,
      );
      deliver = true;
      advance(world);
      expect(state(world).async.completed).toBeGreaterThan(completed);
      expect(state(world).steps.find((step) => step.entity === active)?.result.ok).toBe(true);
      expect(
        state(world).async.selections.find((row) => row.entity === active)?.currentTaskId,
      ).toEqual(expect.any(Number));
      const selection = state(world).async.selections.find((row) => row.entity === disabled);
      expect(selection?.currentTaskId).toBeUndefined();
      expect(selection?.nextTaskId).toBeUndefined();
      world.set(active, WaterPontoonSet, { useAsyncPath: false }).unwrap();
      advance(world, 2);
      expect(participant).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(state(world).async).toMatchObject({ execution: 'disabled', pending: 0 });
    } finally {
      release();
      participant.mockRestore();
      await context.fiber.dispose();
    }
  });

  it('rejects the translated root itself as a descendant socket', async () => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      const root = world
        .spawn(
          { component: Transform, data: { pos: [10, 20, 30] } },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
        )
        .unwrap();
      world
        .addComponent(root, {
          component: WaterPontoonSet,
          data: { anchorMode: 1, socketEntities: [root], anchorsM: [0, 0, 0], radiiM: [0.5] },
        })
        .unwrap();
      advance(world, 3);
      expect(state(world).steps.find((row) => row.entity === root)?.result).toMatchObject({
        ok: false,
        error: {
          code: 'buoyancy-config-invalid',
          detail: { kind: 'socket', socket: root, reason: 'not-descendant' },
        },
      });
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('assembles Water without pontoons with Physics=%s', async (withPhysics) => {
    const world = new World();
    const assets = testAssets(world);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const context = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      ...(withPhysics ? [physics3d] : []),
      waterScenePlugin(),
    ]);
    try {
      advance(world, 3);
      expect(state(world)).toMatchObject({
        steps: [],
        forceEvents: [],
        splashWakeEvents: [],
        asyncEnabled: true,
        async: { execution: 'disabled', submitted: 0, completed: 0, pending: 0 },
      });
      expect(world.hasResource(PhysicsWorldResource)).toBe(withPhysics);
    } finally {
      await context.fiber.dispose();
      assets.dispose();
    }
  });

  it('reports unsupported enabled pontoons when ordinary Physics is absent', async () => {
    const world = new World();
    const assets = testAssets(world);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const context = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      waterScenePlugin(),
    ]);
    try {
      const root = world
        .spawn(
          { component: Transform },
          { component: WaterPontoonSet, data: { anchorsM: [0, 0, 0], radiiM: [1] } },
        )
        .unwrap();
      advance(world, 3);
      expect(state(world)).toMatchObject({
        steps: [
          { entity: root, result: { ok: false, error: { code: 'buoyancy-physics-unsupported' } } },
        ],
        forceEvents: [],
        splashWakeEvents: [],
      });
    } finally {
      await context.fiber.dispose();
      assets.dispose();
    }
  });

  it.each([
    {
      scale: [-1, 1, 1],
      shear: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      anchor: [1, 0, 0],
      expected: [9, 20, 30],
    },
    {
      scale: [-2, 3, 4],
      shear: [0.5, 0.25, -0.5],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      anchor: [1, 2, 3],
      expected: [22, 20, 26],
    },
  ])('preserves reflected and affine relative anchors for $scale / $shear', async ({
    scale,
    shear,
    rotation,
    anchor,
    expected,
  }) => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      const root = world
        .spawn(
          { component: Transform, data: { pos: [10, 20, 30], scale, shear } },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
          { component: WaterPontoonSet, data: { anchorsM: anchor, radiiM: [0.5] } },
        )
        .unwrap();
      advance(world, 3);
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
      if (!physics.setBodyMotion) throw new Error('Native body motion is required');
      physics
        .setBodyMotion(root, {
          position: [10, 20, 30],
          rotation: rotation as [number, number, number, number],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        })
        .unwrap();
      advance(world);
      const row = state(world).steps.find((row) => row.entity === root);
      if (!row) throw new Error('Missing completed buoyancy step');
      const trace = row.result.unwrap().pontoons[0];
      expected.forEach((value, axis) => {
        expect(trace?.centerM[axis]).toBeCloseTo(value, 4);
      });
      expect(trace?.applicationPointM).toEqual(trace?.centerM);
      world.set(root, WaterPontoonSet, { enabledPontoons: [2] }).unwrap();
      advance(world);
      expect(state(world).steps.find((row) => row.entity === root)?.result).toMatchObject({
        ok: false,
        error: {
          code: 'buoyancy-config-invalid',
          detail: { kind: 'configuration', reason: 'enabled-mask' },
        },
      });
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it('resolves direct and nested local sockets from identity against the native root pose and world offsets', async () => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      const root = world
        .spawn(
          { component: Transform, data: { pos: [10, 20, 30], scale: [2, 3, 4] } },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
        )
        .unwrap();
      const direct = world
        .spawn(
          { component: Transform, data: { pos: [-2, 1, 0] } },
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap();
      const parent = world
        .spawn(
          {
            component: Transform,
            data: { pos: [1, 2, 3], quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 1, 1] },
          },
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap();
      const nested = world
        .spawn(
          { component: Transform, data: { pos: [0, 1, 3] } },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
      world
        .addComponent(root, {
          component: WaterPontoonSet,
          data: {
            anchorMode: 1,
            socketEntities: [direct, nested],
            anchorsM: [0.25, -0.5, 1, -0.75, 0.5, -1],
            radiiM: [0.5, 0.5],
          },
        })
        .unwrap();
      advance(world, 3);
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
      if (!physics.setBodyMotion) throw new Error('Native body motion is required');
      physics
        .setBodyMotion(root, {
          position: [10, 20, 30],
          rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        })
        .unwrap();
      advance(world);
      const row = state(world).steps.find((row) => row.entity === root);
      if (!row) throw new Error('Missing completed buoyancy step');
      const step = row.result.unwrap();
      expect(step.dynamics.positionM).toEqual([10, 20, 30]);
      const [a, b] = step.pontoons;
      [10.25, 22.5, 35].forEach((value, axis) => {
        expect(a?.centerM[axis]).toBeCloseTo(value, 4);
      });
      [21.25, 29.5, 21].forEach((value, axis) => {
        expect(b?.centerM[axis]).toBeCloseTo(value, 4);
      });
      expect(a?.applicationPointM).toEqual(a?.centerM);
      expect(b?.applicationPointM).toEqual(b?.centerM);
      const first = Math.fround(4 / 13);
      expect(a?.coefficient).toBeCloseTo(first, 6);
      expect(b?.coefficient).toBeCloseTo(Math.fround(1 - first), 6);
      expect(step.dynamics.completedStep).toBe(step.overlaps.completedStep);
      expect(step.physicsStep).toBe(step.dynamics.nextFixedStep);
      world.despawn(nested).unwrap();
      advance(world);
      expect(state(world).steps.find((row) => row.entity === root)?.result).toMatchObject({
        ok: false,
        error: { code: 'buoyancy-config-invalid' },
      });
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it('uses parent-local socket geometry for coefficients while the force center includes its hierarchy', async () => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      const root = world
        .spawn(
          { component: Transform },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
        )
        .unwrap();
      const parent = world
        .spawn(
          {
            component: Transform,
            data: { pos: [1, 0, 0], quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
          },
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap();
      const sockets = [-1, 1].map((z) =>
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, z] } },
            { component: ChildOf, data: { parent } },
          )
          .unwrap(),
      );
      world
        .addComponent(root, {
          component: WaterPontoonSet,
          data: {
            anchorMode: 1,
            socketEntities: sockets,
            anchorsM: [0, 0, 0, 0, 0, 0],
            radiiM: [0.5, 0.5],
          },
        })
        .unwrap();
      advance(world, 3);
      const row = state(world).steps.find((row) => row.entity === root);
      if (!row) throw new Error('Missing completed buoyancy step');
      const step = row.result.unwrap();
      expect(step.pontoons.map((point) => point.coefficient)).toEqual([0.5, 0.5]);
      expect(step.pontoons[0]?.centerM[0]).toBeCloseTo(0, 5);
      expect(step.pontoons[1]?.centerM[0]).toBeCloseTo(2, 5);
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it('retains first-seen masks across catch-up ticks and rebuilds only for admitted participant geometry', async () => {
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin(), physics3d]);
    const release = installWaterBuoyancy(world, new WaterSystem(() => undefined), () => undefined);
    try {
      const root = world
        .spawn(
          { component: Transform },
          { component: RigidBody, data: { mass: 10, gravityScale: 0 } },
          { component: Collider },
        )
        .unwrap();
      const sockets = [-1, 1].map((z) =>
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, z] } },
            { component: ChildOf, data: { parent: root } },
          )
          .unwrap(),
      );
      const config = {
        anchorMode: 1,
        socketEntities: sockets,
        anchorsM: [0, 0, 0, 0, 0, 0],
        radiiM: [0.5, 0.5],
      };
      advance(world, 2);
      world.addComponent(root, { component: WaterPontoonSet, data: config }).unwrap();
      const hits: boolean[] = [];
      world
        .addSystem(
          FixedUpdate,
          defineSystem({
            name: 'observeWaterCoefficientCache',
            after: [WaterBuoyancy],
            before: [PhysicsSimulation],
            queries: [],
            fn: () => {
              const result = state(world).steps.find((row) => row.entity === root)?.result;
              if (result?.ok) hits.push(result.value.coefficientCache.hit);
            },
          }),
        )
        .unwrap();
      world.update(3.1 / 60).unwrap();
      expect(hits).toEqual([false, true, true]);
      world.set(sockets[0] as never, Transform, { pos: [0, 0, -3] }).unwrap();
      world.set(root, WaterPontoonSet, { maxBuoyantForceN: 200 }).unwrap();
      advance(world);
      const read = () => {
        const result = state(world).steps.find((row) => row.entity === root)?.result;
        if (!result?.ok) throw new Error('Missing admitted coefficient state');
        return result.value;
      };
      expect(read().pontoons.map((p) => p.coefficient)).toEqual([0.5, 0.5]);
      expect(read().coefficientCache.hit).toBe(true);
      world.set(root, WaterPontoonSet, { enabledPontoons: [1, 0] }).unwrap();
      advance(world);
      expect(read().coefficientCache).toEqual({ enabledMask: 1, hit: false });
      world.set(root, WaterPontoonSet, { enabledPontoons: [1, 1] }).unwrap();
      advance(world);
      expect(read().coefficientCache).toEqual({ enabledMask: 3, hit: true });
      expect(read().pontoons.map((p) => p.coefficient)).toEqual([0.5, 0.5]);
      world.removeComponent(root, WaterPontoonSet).unwrap();
      world.addComponent(root, { component: WaterPontoonSet, data: config }).unwrap();
      advance(world);
      expect(read().coefficientCache).toEqual({ enabledMask: 3, hit: false });
      expect(read().pontoons.map((p) => p.coefficient)).toEqual([0.75, 0.25]);
    } finally {
      release();
      await context.fiber.dispose();
    }
  });
});
