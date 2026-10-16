import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import assert from 'node:assert/strict';
import { createApp, inputPlugin } from '@forgeax/engine-app';
import {
  FixedTime,
  FixedUpdate,
  Time,
  Update,
  World,
  defineComponent,
} from '@forgeax/engine-ecs';
import {
  INPUT_MAP_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  inputBackendPlugin,
} from '@forgeax/engine-input';
import { vec3 } from '@forgeax/engine-math';
import { ok } from '@forgeax/engine-types';
import { ChildOf } from '@forgeax/engine-scene';
import {
  addOnEnter,
  addOnExit,
  defineState,
  despawnOnExit,
  getState,
  setNextState,
  statePlugin,
} from '@forgeax/engine-state';

const Mode = defineState('M1CompositionMode', ['menu', 'play']);
const Position = defineComponent('M1CompositionPosition', { x: 'f32', y: 'f32', z: 'f32' });
const Marker = defineComponent('M1CompositionMarker', { value: 'u32' });
const PhaseMarker = defineComponent('M1CompositionPhaseMarker', { value: 'u32' });

function makeSample(index) {
  return {
    downKeys: index === 0 ? new Set(['Space']) : new Set(),
    upKeys: new Set(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
  };
}

function makeInputBackend() {
  let sampleIndex = 0;
  let detached = false;
  return {
    sample() {
      assert.equal(detached, false);
      return makeSample(sampleIndex++);
    },
    detach() {
      detached = true;
    },
  };
}

function makeRenderer(drawCalls) {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    state() {
      return 'alive';
    },
    draw(input) {
      drawCalls.push({ worldCount: input.leases.length });
      return ok(undefined);
    },
    subscribe() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onLost() {
      return () => {};
    },
    attach() {
      return ok({ dispose() {} });
    },
    detachWorld() {},
    dispose() {},
  };
}

function assertResult(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.error.code}`);
  return result.value;
}

async function main() {
  const world = new World({
    time: { fixedDeltaSeconds: 0.05, maxStepsPerUpdate: 2, maxDeltaSeconds: 0.2 },
  });
  const secondaryWorld = new World({
    time: { fixedDeltaSeconds: 0.05, maxStepsPerUpdate: 2, maxDeltaSeconds: 0.2 },
  });
  const inputBackend = makeInputBackend();
  const drawCalls = [];
  const scheduleTrace = [];
  const inputReadings = [];
  const errors = [];
  let fixedTicks = 0;
  let secondaryFixedTicks = 0;
  let deferredEntity;
  let deferredBeforeCount;
  let playEntity;
  let exitedPlay = 0;
  let faultThrown = false;
  let snapshotReference;

  world.insertResource(INPUT_MAP_KEY, [
    { action: 'jump', bindings: [{ type: 'key', key: 'Space' }] },
  ]);

  const plugin = {
    name: 'm1-composition',
    inject: ['world'],
    apply(ctx) {
      ctx.world.insertResource('m1CompositionPluginBuilt', true);
      return () => ctx.world.removeResource('m1CompositionPluginBuilt');
    },
  };

  const root = assertResult(
    world.spawn({ component: Position, data: { x: 0, y: 0, z: 0 }}),
    'root spawn',
  );
  const child = assertResult(world.spawn({ component: Marker, data: { value: 7 }}), 'child spawn');
  assertResult(world.addChild(root, child, ChildOf, { parent: root }), 'hierarchy attach');
  assert.deepEqual([...world.iterDescendants(root)], [child]);

  const impulse = vec3.create(1, 0.5, 0);
  const initial = vec3.create(0.25, 0.5, 0);
  const position = vec3.create();
  vec3.add(position, initial, impulse);
  assertResult(world.set(root, Position, { x: position[0], y: position[1], z: position[2] }), 'position set');

  addOnEnter(Mode, 'play', (target) => {
    playEntity = assertResult(
      target.spawn({ component: PhaseMarker, data: { value: 1 }}),
      'play entity spawn',
    );
    despawnOnExit(target, playEntity, Mode, 'play');
  });
  addOnExit(Mode, 'play', () => {
    exitedPlay += 1;
  });

  assertResult(
    world.addSystem(Update, {
      name: 'm1-update-before-fixed',
      after: ['transitionStates'],
      before: [FixedUpdate],
      queries: [],
      fn() {
        scheduleTrace.push('update-before-fixed');
      },
    }),
    'update-before-fixed registration',
  );
  assertResult(
    world.addSystem(Update, {
      name: 'm1-input-reader',
      after: ['m1-update-before-fixed'],
      before: [FixedUpdate],
      queries: [],
      fn(world) {
        const snapshot = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
        inputReadings.push({
          jump: snapshot.action('jump').isPressed(),
          justPressed: snapshot.action('jump').justPressed(),
        });
        snapshotReference = snapshot;
      },
    }),
    'input reader registration',
  );
  assertResult(
    world.addSystem(Update, {
      name: 'm1-input-reader-same-frame',
      after: ['m1-input-reader'],
      before: [FixedUpdate],
      queries: [],
      fn(world) {
        assert.equal(world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY), snapshotReference);
      },
    }),
    'same-frame input registration',
  );
  assertResult(
    world.addSystem(Update, {
      name: 'm1-deferred-spawn',
      after: ['m1-input-reader-same-frame'],
      before: [FixedUpdate],
      queries: [],
      fn(world, _queries, commands) {
        if (deferredEntity !== undefined) return;
        deferredBeforeCount = world.inspect().entityCount;
        deferredEntity = commands.spawn({ component: Marker, data: { value: 9 }});
        assert.equal(commands.isDeferred(deferredEntity), true);
        assert.equal(world.inspect().entityCount, deferredBeforeCount);
      },
    }),
    'deferred mutation registration',
  );
  assertResult(
    world.addSystem(FixedUpdate, {
      name: 'm1-fixed-probe',
      queries: [],
      fn(world) {
        scheduleTrace.push('fixed');
        fixedTicks += 1;
        const current = assertResult(world.get(root, Position), 'position read');
        assertResult(
          world.set(root, Position, {
            x: current.x + 0.25,
            y: current.y,
            z: current.z,
          }),
          'fixed position write',
        );
      },
    }),
    'fixed registration',
  );
  assertResult(
    world.addSystem(Update, {
      name: 'm1-update-after-fixed',
      after: [FixedUpdate],
      queries: [],
      fn() {
        scheduleTrace.push('update-after-fixed');
      },
    }),
    'update-after-fixed registration',
  );

  assertResult(
    secondaryWorld.addSystem(Update, {
      name: 'secondary-before-fixed',
      before: [FixedUpdate],
      queries: [],
      fn() {},
    }),
    'secondary update registration',
  );
  assertResult(
    secondaryWorld.addSystem(FixedUpdate, {
      name: 'secondary-fixed',
      queries: [],
      fn() {
        secondaryFixedTicks += 1;
      },
    }),
    'secondary fixed registration',
  );
  assertResult(secondaryWorld.spawn({ component: Marker, data: { value: 2 }}), 'secondary marker spawn');

  const scheduleData = world.scheduleData();
  const updateSchedule = scheduleData.find((schedule) => schedule.name === 'Update');
  assert.ok(updateSchedule);
  assert.deepEqual(updateSchedule.systems.map((system) => system.name), [
    'm1-update-before-fixed',
    'm1-input-reader',
    'm1-input-reader-same-frame',
    'm1-deferred-spawn',
    'm1-update-after-fixed',
  ]);
  assert.equal(
    updateSchedule.dependencies.some(
      ([source, target]) => source === 'm1-update-before-fixed' && target === 'm1-input-reader',
    ),
    true,
  );
  assert.equal(
    updateSchedule.dependencies.some(
      ([source, target]) => source === 'FixedUpdate' && target === 'm1-update-after-fixed',
    ),
    true,
  );
  assert.deepEqual(updateSchedule.systems[0]?.queries, []);
  console.log('[m1-composition] schedule data snapshot: PASS');

  const pendingFrames = [];
  const priorRaf = globalThis.requestAnimationFrame;
  const priorCaf = globalThis.cancelAnimationFrame;
  const priorPerformance = globalThis.performance;
  let clock = 0;
  globalThis.requestAnimationFrame = (callback) => {
    pendingFrames.push(callback);
    return pendingFrames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance = { now: () => clock };
  const appResult = await createApp({ platform: createSmokePlatform({ width: 1, height: 1 }),
    renderer: makeRenderer(drawCalls),
    world,
    plugins: [inputBackendPlugin(inputBackend), statePlugin(), inputPlugin(), plugin],
    silenceUnhandledErrors: true,
    drawSource: () => ({ worlds: [world, secondaryWorld], cameraOwner: 0, resourceOwner: 0 }),
  });
  assert.equal(appResult.ok, true);
  if (!appResult.ok) return;
  const app = appResult.value;
  app.onError((error) => errors.push(error));
  try {
    assertResult(setNextState(world, Mode, 'play'), 'request play');
    assertResult(app.start(), 'app start');
    const firstTimestamp = 200;
    clock = firstTimestamp;
    pendingFrames.shift()(firstTimestamp);
    assert.deepEqual(scheduleTrace.slice(0, 4), [
      'update-before-fixed',
      'fixed',
      'fixed',
      'update-after-fixed',
    ]);
    assert.equal(fixedTicks, 2);
    assert.equal(world.getResource(FixedTime).droppedUpdates, 1);
    assert.equal(world.getResource(FixedTime).droppedSeconds > 0, true);
    assert.deepEqual(inputReadings[0], { jump: true, justPressed: true });
    assert.equal(assertResult(getState(world, Mode), 'state read'), 'play');
    assert.equal(playEntity !== undefined, true);
    assert.equal(world.inspect().entityCount, deferredBeforeCount + 1);
    assert.equal([...world.iterDescendants(root)].length, 1);
    assert.equal(world.getResource('m1CompositionPluginBuilt'), true);
    const pluginNames = [...app.pluginContext.registry.values()].map((runtime) => runtime.name);
    assert.equal(pluginNames.includes('state'), true);
    assert.equal(pluginNames.includes('input'), true);
    assert.equal(pluginNames.includes('m1-composition'), true);
    assert.equal(drawCalls[0]?.worldCount, 2);
    assert.equal(secondaryFixedTicks, 2);
    console.log('[m1-composition] schedule order: update-before-fixed -> fixed -> fixed -> update-after-fixed');
    console.log('[m1-composition] deferred mutation, state lifecycle, input, hierarchy, and math: PASS');

    assertResult(setNextState(world, Mode, 'menu'), 'request menu');
    assertResult(
      world.addSystem(Update, {
        name: 'm1-composition-fault',
        after: ['m1-update-after-fixed'],
        queries: [],
        fn() {
          if (!faultThrown) {
            faultThrown = true;
            throw new Error('m1 composition fault');
          }
        },
      }),
      'fault registration',
    );
    clock = firstTimestamp + 200;
    pendingFrames.shift()(firstTimestamp + 200);
    assert.equal(errors.some((error) => error.code === 'app-system-update-failed'), true);
    assert.equal(exitedPlay, 1);
    assert.equal(assertResult(getState(world, Mode), 'state read'), 'menu');
    assert.equal(world.get(playEntity, PhaseMarker).ok, false);
    console.log('[m1-composition] multi-world drawSource and plugin registry: PASS');

    clock = firstTimestamp + 400;
    pendingFrames.shift()(firstTimestamp + 400);
    assert.equal(faultThrown, true);
    // The poisoned World retry is fanned out as a second App update failure.
    assert.equal(errors.filter((error) => error.code === 'app-system-update-failed').length, 2);
    assert.equal(secondaryFixedTicks, 6);
    // The secondary World remains renderable on both poisoned-primary retries.
    assert.equal(drawCalls.length, 3);
    assertResult(app.stop(), 'app stop');
    console.log('[m1-composition] App error fan-out and same-process recovery: PASS');
  } finally {
    if (priorRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = priorRaf;
    if (priorCaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = priorCaf;
    globalThis.performance = priorPerformance;
    inputBackend.detach();
  }

  assert.equal(world.getResource(Time).elapsed > 0, true);
  console.log('[m1-composition] PASS - M1 composition gates GREEN');
}

main().catch((error) => {
  console.error(`[m1-composition] FAIL - ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
