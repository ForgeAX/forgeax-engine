import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE, ANTIALIAS_TAA, Camera, DirectionalLight, DynamicResolution, Materials, MeshFilter, MeshRenderer,
  ReflectionProbe, ScreenSpaceReflection, Skylight, perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { spawnAtmosphereScene } from './atmosphere-scene.mjs';
import { createReflectionTexture } from './reflection-texture.mjs';

// Browser, Dawn correctness, and performance share this authored scene.
export const SSR_FIXTURE_REVISION = 'textured-reflection-scenes-v9';
export const SSR_ANTIALIAS_MODES = Object.freeze(['none', 'taa', 'taau', 'taa-dynamic']);
export const SSR_FIXTURES = Object.freeze(['cube', 'tiles', 'objects', 'no-hit', 'probe-updates', 'underside', 'atmosphere']);
export const SSR_PARAMETERS = Object.freeze({ maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 });

export function resolveSsrFixture(value = 'tiles') {
  if (!SSR_FIXTURES.includes(value)) throw new Error(`Unknown SSR fixture: ${value}`);
  return value;
}

export function spawnReflectionScene(world, aspect = 1, fixture = 'tiles', antialias = 'none') {
  resolveSsrFixture(fixture);
  if (!SSR_ANTIALIAS_MODES.includes(antialias)) throw new Error(`Unknown SSR antialias: ${antialias}`);
  if (fixture === 'atmosphere') return spawnAtmosphereScene(world,aspect);
  const texture = world.allocSharedRef('TextureAsset', createReflectionTexture());
  let movingObject;
  let receiver;
  const mesh = (geometry, pos, scale, material, quat = [0, 0, 0, 1]) => world.spawn(
    { component: Transform, data: { pos, scale, quat } },
    { component: MeshFilter, data: { assetHandle: geometry } },
    { component: MeshRenderer, data: { materials: [world.allocSharedRef('MaterialAsset', Materials.standard(material))] } },
  ).unwrap();
  if (fixture === 'no-hit') {
    // A reflective receiver without reflected scene objects still traces the
    // admitted distance. Keep the normal ray budget, not an early-exit setting.
    receiver = mesh(HANDLE_CUBE, [0, -1.1, 0], [9, 0.15, 9],
      { baseColor: [0.75, 0.8, 0.85, 1], metallic: 0.92, roughness: 0.12 });
  } else if (fixture === 'cube') {
    const plane = createPlaneGeometry(10, 10);
    if (!plane.ok) throw plane.error;
    mesh(world.allocSharedRef('MeshAsset', plane.value), [0, -1, 0], [1, 1, 1],
      { baseColor: [0.8, 0.85, 0.9, 1], metallic: 0.95, roughness: 0.08 },
      [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    movingObject = receiver = mesh(HANDLE_CUBE, [0, 0, 0], [2, 2, 2],
      { baseColor: [1, 0.08, 0.025, 1], metallic: 0.05, roughness: 0.4 });
  } else if (fixture === 'objects' || fixture === 'probe-updates') {
    mesh(HANDLE_CUBE, [0, -1.1, 0], [9, 0.15, 9],
    { baseColor: [0.75, 0.8, 0.85, 1], metallic: 0.92, roughness: 0.12 });
  receiver = mesh(HANDLE_SPHERE, [0, -0.025, 0], [1, 1, 1],
    { baseColor: [0.8, 0.9, 1, 1], metallic: 0.7, roughness: 0.18, baseColorTexture: texture });
  movingObject = mesh(HANDLE_CUBE, [2.25, -0.2, 0], [0.9, 1.65, 0.9],
    { baseColor: [1, 0.09, 0.025, 1], metallic: 0.05, roughness: 0.4, baseColorTexture: texture });
  mesh(HANDLE_CUBE, [-1.8, 0.175, -1], [0.7, 2.4, 0.7],
    { baseColor: [0.04, 0.35, 1, 1], metallic: 0.05, roughness: 0.4, baseColorTexture: texture });
  mesh(HANDLE_CUBE, [0.3, -0.475, -2.3], [1.1, 1.1, 1.1],
    { baseColor: [1, 0.65, 0.025, 1], metallic: 0.05, roughness: 0.4 });
  } else {
    if (fixture === 'underside') {
      mesh(HANDLE_CUBE, [0, -1.1, 0], [8, 0.15, 8],
        { baseColor: [0.63, 0.68, 0.73, 1], metallic: 0.9, roughness: 0.08 });
    } else {
      // Fixed-seed mixed roughness tiles: the same boundaries must reproduce
      // in every browser, native run, capture, and SSR on/off comparison.
      const roughnesses = [0.08, 0.18, 0.3, 0.45, 0.6, 0.85];
      let seed = 0x535352;
      for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const roughness = roughnesses[Math.floor(seed / 0x100000000 * roughnesses.length)];
          mesh(HANDLE_CUBE, [-3.5 + col, -1.1, -3.5 + row], [0.985, 0.15, 0.985],
            { baseColor: [0.63, 0.68, 0.73, 1], metallic: 0.9, roughness });
        }
      }
    }
    const palette = [
      [1, 0.08, 0.025], [1, 0.5, 0.035], [0.04, 0.7, 0.3],
      [0.025, 0.3, 1], [0.6, 0.07, 1], [0.05, 0.8, 1],
    ];
    for (let wall = 0; wall < 2; wall += 1) {
      mesh(HANDLE_CUBE, wall === 0 ? [0, 1, -4.05] : [-4.05, 1, 0],
        wall === 0 ? [8.1, 4.1, 0.12] : [0.12, 4.1, 8.1],
        { baseColor: [0.012, 0.018, 0.025, 1], roughness: 0.9 });
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 10; col += 1) {
          const color = palette[(col + row * 2 + wall * 3) % palette.length];
          const along = -3.6 + col * 0.8;
          const height = -0.64 + row * 0.78;
          const glow = (col + row * 3 + wall) % 7 === 0;
          mesh(HANDLE_CUBE, wall === 0 ? [along, height, -3.95] : [-3.95, height, along],
            wall === 0 ? [0.75, 0.73, 0.12] : [0.12, 0.73, 0.75],
            { baseColor: [...color, 1], metallic: 0.05, roughness: 0.35,
              // Retain sparse untextured tiles as a low-frequency control.
              ...(col % 5 === 4 ? {} : { baseColorTexture: texture, emissiveTexture: texture }),
              emissive: color, emissiveIntensity: glow ? 2.5 : 0 });
        }
      }
    }
    if (fixture === 'underside') {
      // An open-bottom shell, not a closed box or a double-sided material.
      // A ray arriving from below must not reflect the upward-facing roof.
      const plane = createPlaneGeometry(1, 1);
      if (!plane.ok) throw plane.error;
      const surface = world.allocSharedRef('MeshAsset', plane.value);
      const shell = { baseColor: [0.95, 0.07, 0.015, 1], roughness: 0.3, metallic: 0.15,
        baseColorTexture: texture };
      const half = Math.SQRT1_2;
      mesh(surface, [0.4, 0.25, 0], [2.5, 3.4, 1], shell, [-half, 0, 0, half]);
      mesh(surface, [0.4, 0, 1.7], [2.5, 0.5, 1], shell);
      mesh(surface, [0.4, 0, -1.7], [2.5, 0.5, 1], shell, [0, 1, 0, 0]);
      mesh(surface, [1.65, 0, 0], [3.4, 0.5, 1], shell, [0, half, 0, half]);
      mesh(surface, [-0.85, 0, 0], [3.4, 0.5, 1], shell, [0, -half, 0, half]);
      for (const x of [-0.9, 1.7]) for (const z of [-1.1, 1.1]) {
        mesh(HANDLE_SPHERE, [x, -0.62, z], [0.48, 0.8, 0.8],
          { baseColor: [0.018, 0.022, 0.028, 1], roughness: 0.9 });
      }
    }
  }
  const sun = world.spawn({ component: DirectionalLight,
    data: { direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 2, castShadow: false },
  }).unwrap();
  const skylight = world.spawn({ component: Skylight,
    data: { color: [0.55, 0.7, 1], intensity: 1 },
  }).unwrap();
  let reflectionProbe;
  if (fixture !== 'objects' && fixture !== 'no-hit') {
    // The bounded fixtures exercise local-probe selection. The objects
    // showcase intentionally stays Skylight-lit + SSR with no local probe:
    // its large floor extends far beyond any small probe box and would
    // produce invalid box projection.
    reflectionProbe = world.spawn(
      // Place the simple fixture's capture in empty space above its opaque cube.
      { component: Transform, data: { pos: fixture === 'cube' ? [0, 2, 0] : [0, 0, 0] } },
      { component: ReflectionProbe,
        // The central pavers are centered at y=-1.1. Include those receivers
        // while retaining the surrounding pavers as Skylight-only controls.
        data: { halfExtents: fixture === 'cube' ? [2.5, 3.2, 2.5] : fixture === 'probe-updates' ? [1.25, 1.2, 1.25] : [0.9, 1.2, 0.9], priority: 1, intensity: 1,
          resolution: 64, updateIntent: 0, invalidationVersion: 1 } },
    ).unwrap();
  }
  const objectShowcase = fixture === 'objects' || fixture === 'probe-updates' || fixture === 'no-hit';
  const eyeHeight = (objectShowcase || fixture === 'cube') ? 3 : fixture === 'underside' ? -0.3 : 0.8;
  const targetHeight = (objectShowcase || fixture === 'cube') ? 0 : -0.45;
  const pitch = -Math.atan2(eyeHeight - targetHeight, Math.hypot(6, 6));
  const yaw = Math.PI / 4;
  const camera = world.spawn(
    { component: Transform, data: { pos: [6, eyeHeight, 6],
      quat: [Math.sin(pitch / 2) * Math.cos(yaw / 2),
        Math.cos(pitch / 2) * Math.sin(yaw / 2),
        -Math.sin(pitch / 2) * Math.sin(yaw / 2),
        Math.cos(pitch / 2) * Math.cos(yaw / 2)] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect, near: 0.1, far: 20 }),
      clearColor: [0.04, 0.06, 0.1, 1], antialias: antialias === 'none' ? ANTIALIAS_NONE : ANTIALIAS_TAA } },
    { component: ScreenSpaceReflection, data: SSR_PARAMETERS },
  ).unwrap();
  if (antialias === 'taau' || antialias === 'taa-dynamic') {
    world.addComponent(camera, { component: DynamicResolution, data:
      antialias === 'taau' ? { targetGpuMs: 16.67, minScale: 0.67, maxScale: 0.67 }
        : { targetGpuMs: 1, minScale: 0.5, maxScale: 1 },
    }).unwrap();
  }
  return {
    sun,
    skylight,
    ...(reflectionProbe === undefined ? {} : { reflectionProbe }),
    camera,
    movingObject,
    receiver,
  };
}
