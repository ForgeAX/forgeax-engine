// Bevy `examples/3d/shadow_biases.rs`, shared by the browser app and the Dawn
// smoke so the falsified scene is the one users see.
//
// Bevy parents both lights under one transform at (5, 5, 0) looking at the
// origin; the directional light only uses that rotation. ForgeaX keeps the
// point light's Transform and derives DirectionalLight.direction from it.
//
// Bias units: PointLightShadow uses Bevy's semantics directly (depthBias in
// world meters, normalBias in cube texels). DirectionalLight keeps ForgeaX's
// units (depthBias is a normalized depth floor on top of automatic slope and
// texel coverage, normalBias is world meters), so its steps are rescaled.
import { createPlaneGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera, DirectionalLight, DirectionalShadowFilterValue, Materials, MeshFilter, MeshRenderer,
  PointLight, PointLightShadow, perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const SPAWN_PLANE_DEPTH = 300;
const SPAWN_HEIGHT = 2;
const SPHERE_RADIUS = 0.25;
// Same exposure mapping as shadow-caster-receiver: 1000 lux -> 2.
export const DIRECTIONAL_INTENSITY = 2;
export const POINT_INTENSITY = (1_000_000 / (4 * Math.PI)) * (DIRECTIONAL_INTENSITY / 1000);
export const LIGHT_POSITION = [5, 5, 0];
export const CAMERA_POSITION = [-1, 1, 1];
export const CAMERA_TARGET = [-1, 1, 0];
const FLAT = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

export const BIAS_DEFAULTS = Object.freeze({
  point: { depthBias: 0.08, normalBias: 0.6 },
  directional: { depthBias: 0.00001, normalBias: 0.05 },
});
export const BIAS_STEPS = Object.freeze({
  point: { depthBias: 0.01, normalBias: 0.1 },
  directional: { depthBias: 0.0005, normalBias: 0.01 },
});
// Bevy's F cycles Hardware2x2 / Gaussian / Temporal on the camera. ForgeaX
// filtering is per directional light (closed profile union, pcf1 is the
// single hardware 2x2 compare); point cube shadows are hardware 2x2 only.
export const FILTERS = Object.freeze(['pcf1', 'pcf3', 'pcf5', 'pcssMedium', 'pcssHigh']);

const lookDirection = (position) => {
  const length = Math.hypot(...position);
  return position.map((value) => -value / length);
};

export function spawnBiasesScene(world, aspect) {
  const sphere = createSphereGeometry(SPHERE_RADIUS, 32, 16);
  const plane = createPlaneGeometry(2 * SPAWN_PLANE_DEPTH, 2 * SPAWN_PLANE_DEPTH);
  if (!sphere.ok) throw sphere.error;
  if (!plane.ok) throw plane.error;
  const sphereMesh = world.allocSharedRef('MeshAsset', sphere.value);
  const white = (roughness) =>
    world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness }));
  const sphereMaterial = white(0.5);
  for (let z = -SPAWN_PLANE_DEPTH; z <= 0; z += 2) {
    world.spawn(
      { component: Transform, data: { pos: [0, z % 4 === 0 ? SPAWN_HEIGHT : SPHERE_RADIUS, z], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: sphereMesh } },
      { component: MeshRenderer, data: { materials: [sphereMaterial] } },
    ).unwrap();
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: FLAT, scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', plane.value) } },
    { component: MeshRenderer, data: { materials: [white(1)] } },
  ).unwrap();

  const pointLight = world.spawn(
    { component: Transform, data: { pos: LIGHT_POSITION, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 0, range: SPAWN_PLANE_DEPTH } },
    { component: PointLightShadow, data: { mapSize: 1024, farPlane: SPAWN_PLANE_DEPTH, ...BIAS_DEFAULTS.point } },
  ).unwrap();
  const directionalLight = world.spawn({
    component: DirectionalLight,
    data: {
      direction: lookDirection(LIGHT_POSITION), color: [1, 1, 1], intensity: DIRECTIONAL_INTENSITY,
      castShadow: true, shadowDistance: 150, shadowFilter: DirectionalShadowFilterValue.pcf1,
      ...BIAS_DEFAULTS.directional,
    },
  }).unwrap();

  world.spawn(
    {
      component: Transform,
      data: {
        pos: CAMERA_POSITION,
        quat: quat.fromLookAt(quat.create(), CAMERA_POSITION, CAMERA_TARGET, [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect }) },
  ).unwrap();

  return { pointLight, directionalLight };
}

/** L: swap the point light and the directional light. */
export function toggleLight(world, scene) {
  const point = world.get(scene.pointLight, PointLight).unwrap();
  world.set(scene.pointLight, PointLight, { intensity: point.intensity === 0 ? POINT_INTENSITY : 0 }).unwrap();
  world.set(scene.directionalLight, DirectionalLight, {
    intensity: point.intensity === 0 ? 0 : DIRECTIONAL_INTENSITY,
  }).unwrap();
}

/** F: advance the directional filter profile. */
export function cycleFilter(world, scene) {
  const current = world.get(scene.directionalLight, DirectionalLight).unwrap().shadowFilter;
  const index = FILTERS.findIndex((label) => DirectionalShadowFilterValue[label] === current);
  const next = FILTERS[(index + 1) % FILTERS.length];
  world.set(scene.directionalLight, DirectionalLight, { shadowFilter: DirectionalShadowFilterValue[next] }).unwrap();
  return next;
}

/** 1-8: step one bias of one light by `sign` steps, clamped at zero. */
export function adjustBias(world, scene, light, field, sign) {
  const [entity, component] = light === 'point'
    ? [scene.pointLight, PointLightShadow]
    : [scene.directionalLight, DirectionalLight];
  const current = world.get(entity, component).unwrap()[field];
  world.set(entity, component, { [field]: Math.max(0, current + sign * BIAS_STEPS[light][field]) }).unwrap();
}

/** R resets both lights to their defaults; Z zeroes every bias. */
export function setBiases(world, scene, values) {
  world.set(scene.pointLight, PointLightShadow, values.point).unwrap();
  world.set(scene.directionalLight, DirectionalLight, values.directional).unwrap();
}

export const ZERO_BIASES = Object.freeze({
  point: { depthBias: 0, normalBias: 0 },
  directional: { depthBias: 0, normalBias: 0 },
});

/** Arrows / PageUp / PageDown: move the light rig and keep it aimed at the origin. */
export function moveLight(world, scene, offset) {
  const position = [...world.get(scene.pointLight, Transform).unwrap().pos].map((value, i) => value + offset[i]);
  world.set(scene.pointLight, Transform, { pos: position }).unwrap();
  world.set(scene.directionalLight, DirectionalLight, { direction: lookDirection(position) }).unwrap();
}

export function describe(world, scene) {
  const point = world.get(scene.pointLight, PointLight).unwrap();
  const pointShadow = world.get(scene.pointLight, PointLightShadow).unwrap();
  const directional = world.get(scene.directionalLight, DirectionalLight).unwrap();
  const filter = FILTERS.find((label) => DirectionalShadowFilterValue[label] === directional.shadowFilter);
  const f = (value) => value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0');
  return [
    `Light: ${point.intensity === 0 ? 'Directional' : 'Point'}`,
    `Directional filter: ${filter} (point: hardware 2x2)`,
    `Point depth bias: ${f(pointShadow.depthBias)} m  |  normal bias: ${f(pointShadow.normalBias)} texels`,
    `Directional depth bias: ${f(directional.depthBias)}  |  normal bias: ${f(directional.normalBias)} m`,
    '',
    '1/2 point depth bias, 3/4 point normal bias',
    '5/6 directional depth bias, 7/8 directional normal bias',
    'L light, F filter, R reset, Z zero, arrows/PageUp/PageDown move light',
  ].join('\n');
}
