#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import assert from 'node:assert/strict';
import { AnimatedBy, AnimationTargetId, animationPlugin } from '@forgeax/engine-animation';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { scenePlugin, GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  buildAnimatedTransformWorld,
  replayAnimatedTransform,
  setAnimatedTransformPaused,
  setAnimatedTransformSpeed,
  TRANSFORM_CLIP_GUID,
  transformClip,
} from '../src/animated-transform.ts';

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: expected ${expected}, got ${actual}`);

function advance(world, seconds) {
  for (let remaining = seconds; remaining > 1e-9; remaining -= 0.1) {
    world.update(Math.min(0.1, remaining));
  }
}

const world = new World();
const clip = transformClip();
const clips = new Map([[TRANSFORM_CLIP_GUID, clip]]);
await createWorldContext(world, [scenePlugin(), animationPlugin((guid) => clips.get(guid))]);
const demo = buildAnimatedTransformWorld(world, clip);
const [direct, graph] = demo.instances;
assert.ok(direct);
assert.ok(graph);

if (process.env.ANIMATED_TRANSFORM_FALSIFY === 'missing-binding') {
  world.removeComponent(direct.planet, AnimatedBy).unwrap();
} else if (process.env.ANIMATED_TRANSFORM_FALSIFY === 'wrong-target-id') {
  world
    .set(direct.planet, AnimationTargetId, { value: '00000000000000000000000000000000' })
    .unwrap();
}

assert.equal(demo.instances.length, 2);
for (const instance of demo.instances) {
  assert.equal(instance.targets.length, 3);
  for (const target of instance.targets) {
    assert.equal(world.get(target, Transform).ok, true);
  }
}

advance(world, 0.25);

const directPlanet = world.get(direct.planet, Transform).unwrap();
const directOrbit = world.get(direct.orbitController, Transform).unwrap();
const directSatellite = world.get(direct.satellite, Transform).unwrap();
const directSatelliteWorld = world.get(direct.satellite, GlobalTransform).unwrap();
const graphPlanet = world.get(graph.planet, Transform).unwrap();
const graphOrbit = world.get(graph.orbitController, Transform).unwrap();
const graphSatellite = world.get(graph.satellite, Transform).unwrap();
const graphSatelliteWorld = world.get(graph.satellite, GlobalTransform).unwrap();

near(directPlanet.pos[1], 1, 'direct Planet translation');
near(graphPlanet.pos[1], 1, 'graph Planet translation');
near(directOrbit.quat[2], Math.sin(Math.PI / 8), 'direct OrbitController rotation');
near(graphOrbit.quat[2], Math.sin(Math.PI / 8), 'graph OrbitController rotation');
near(directSatellite.scale[0], 1.25, 'direct Satellite scale');
near(graphSatellite.scale[0], 1.25, 'graph Satellite scale');
near(directSatelliteWorld.world[12], -4 + Math.SQRT2, 'direct propagated world x');
near(graphSatelliteWorld.world[12], 4 + Math.SQRT2, 'graph propagated world x');

setAnimatedTransformPaused(world, demo, 'direct', true);
advance(world, 0.25);
near(world.get(direct.planet, Transform).unwrap().pos[1], 1, 'paused direct remains still');
near(world.get(graph.planet, Transform).unwrap().pos[1], 2, 'graph continues independently');

setAnimatedTransformPaused(world, demo, 'direct', false);
setAnimatedTransformPaused(world, demo, 'graph', true);
setAnimatedTransformSpeed(world, demo, 'direct', 2);
advance(world, 0.25);
near(world.get(direct.planet, Transform).unwrap().pos[1], 3, 'resumed direct uses speed');
near(world.get(graph.planet, Transform).unwrap().pos[1], 2, 'paused graph remains still');

replayAnimatedTransform(world, demo, 'direct');
world.update(0);
near(world.get(direct.planet, Transform).unwrap().pos[1], 0, 'direct replay resets time');

console.log('[bevy-animated-transform] running=1 motion=1 isolation=1');
console.log('[smoke] PASS - TRS, world propagation, controls, direct/graph, and isolation');
