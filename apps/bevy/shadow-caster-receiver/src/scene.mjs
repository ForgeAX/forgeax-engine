// Bevy `examples/3d/shadow_caster_receiver.rs`, shared by the browser app and
// the Dawn smoke so the falsified scene is the one users see.
//
// Bevy NotShadowCaster / NotShadowReceiver map to ShadowParticipation. Every
// mesh carries the component so C and R invert its fields in place, exactly
// like Bevy inserting or removing the marker on each mesh.
import { createPlaneGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, PointLight, PointLightShadow,
  ShadowParticipation, perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const SPAWN_HEIGHT = 2;
const SPHERE_RADIUS = 0.25;
// Bevy OVERCAST_DAY (1000 lux) maps to directional intensity 2, so one lux is
// 0.002; Bevy's 1_000_000 lm point light is 1e6 / 4pi cd on the same scale.
export const DIRECTIONAL_INTENSITY = 2;
export const POINT_INTENSITY = (1_000_000 / (4 * Math.PI)) * (DIRECTIONAL_INTENSITY / 1000);
// Quat::from_euler(ZYX, 0, PI/2, -PI/4) applied to Bevy's -Z light forward.
export const DIRECTIONAL_DIRECTION = [-Math.SQRT1_2, -Math.SQRT1_2, 0];
export const CAMERA_POSITION = [-5, 5, 5];
export const CAMERA_TARGET = [-1, 1, 0];
const FLAT = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

export function spawnCasterReceiverScene(world, aspect) {
  const sphere = createSphereGeometry(SPHERE_RADIUS, 32, 16);
  const plane = createPlaneGeometry(20, 20);
  if (!sphere.ok) throw sphere.error;
  if (!plane.ok) throw plane.error;
  const sphereMesh = world.allocSharedRef('MeshAsset', sphere.value);
  const planeMesh = world.allocSharedRef('MeshAsset', plane.value);
  const material = (baseColor, roughness = 0.5) =>
    world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor, metallic: 0, roughness }));
  const mesh = (assetHandle, pos, rotation, baseColor, participation, roughness) =>
    world.spawn(
      { component: Transform, data: { pos, quat: rotation, scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle } },
      { component: MeshRenderer, data: { materials: [material(baseColor, roughness)] } },
      { component: ShadowParticipation, data: participation },
    ).unwrap();

  const meshes = {
    red: mesh(sphereMesh, [-1, SPAWN_HEIGHT, 0], [0, 0, 0, 1], [1, 0, 0, 1], { cast: true, receive: true }),
    blue: mesh(sphereMesh, [1, SPAWN_HEIGHT, 0], [0, 0, 0, 1], [0, 0, 1, 1], { cast: false, receive: true }),
    lime: mesh(planeMesh, [0, 1, -10], FLAT, [0, 1, 0, 1], { cast: false, receive: false }),
    ground: mesh(planeMesh, [0, 0, 0], FLAT, [1, 1, 1, 1], { cast: true, receive: true }, 1),
  };

  const pointLight = world.spawn(
    { component: Transform, data: { pos: [5, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 0, range: 500 } },
    { component: PointLightShadow, data: { mapSize: 1024, farPlane: 30 } },
  ).unwrap();
  const directionalLight = world.spawn({
    component: DirectionalLight,
    data: {
      direction: DIRECTIONAL_DIRECTION, color: [1, 1, 1], intensity: DIRECTIONAL_INTENSITY,
      castShadow: true, shadowDistance: 25,
    },
  }).unwrap();

  const camera = world.spawn(
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

  return { meshes, pointLight, directionalLight, camera };
}

/** L: swap the point light and the directional light, as Bevy's toggle_light. */
export function toggleLight(world, scene) {
  const point = world.get(scene.pointLight, PointLight).unwrap();
  const directional = world.get(scene.directionalLight, DirectionalLight).unwrap();
  world.set(scene.pointLight, PointLight, { intensity: point.intensity === 0 ? POINT_INTENSITY : 0 }).unwrap();
  world.set(scene.directionalLight, DirectionalLight, {
    intensity: directional.intensity === 0 ? DIRECTIONAL_INTENSITY : 0,
  }).unwrap();
  return point.intensity === 0 ? 'PointLight' : 'DirectionalLight';
}

/** C / R: casters become not and not-casters become casters (same for receivers). */
export function toggleParticipation(world, scene, field) {
  for (const entity of Object.values(scene.meshes)) {
    const current = world.get(entity, ShadowParticipation).unwrap();
    world.set(entity, ShadowParticipation, { [field]: !current[field] }).unwrap();
  }
}
