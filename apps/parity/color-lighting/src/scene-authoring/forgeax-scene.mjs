import { createApp } from '@forgeax/engine/app/browser';
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import {
  Camera,
  perspective,
  DirectionalLight,
  Skylight,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  Materials,
  TONEMAP_NONE,
  TONEMAP_ACES_FILMIC,
  ANTIALIAS_NONE,
  ANTIALIAS_FXAA,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
} from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { rhi } from '@forgeax/engine/rhi-webgpu';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// Complete scene authoring: no shared scene/material/light setup helpers.
/** @param {HTMLCanvasElement} canvas */
export async function createForgeaxScene(canvas) {
  const app = (await createApp(canvas, { rhi }, forgeaxBundlerAdapter())).unwrap();
  const { world } = app;
  const unsubscribe = app.onError((error) => {
    throw error;
  });

  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [7, 5, 9],
          quat: quat.fromLookAt(quat.create(), [7, 5, 9], [0, 0.8, 0], [0, 1, 0]),
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 1, near: 0.1, far: 40 }),
          clearColor: [0.025, 0.035, 0.055, 1],
          bloomThreshold: 1,
          bloomIntensity: 1,
          bloomRadius: 0,
          bloomSmoothWidth: 0.01,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-4, -8, -5],
        color: [1, 1, 1],
        intensity: 3,
        castShadow: true,
        mapSize: 1024,
        cascadeCount: 3,
        splitLambda: 0.5,
        cascadeBlend: 0,
        shadowDistance: 40,
        depthBias: 0.00001,
        normalBias: 0.05,
      },
    })
    .unwrap();
  // Optional diagnostic: solid Skylight includes specular environment lighting.
  const ambient = world
    .spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0 } })
    .unwrap();

  const objects = [
    {
      geometry: createBoxGeometry(10, 0.2, 10).unwrap(),
      position: [0, -0.1, 0],
      baseColor: 0x858b94,
      metallic: 0,
      roughness: 0.8,
      emissive: 0,
      emissiveIntensity: 0,
    },
    {
      geometry: createBoxGeometry(1.6, 1.6, 1.6).unwrap(),
      position: [-1.6, 0.8, 0],
      baseColor: 0x367fd4,
      metallic: 0,
      roughness: 0.35,
      emissive: 0,
      emissiveIntensity: 0,
    },
    {
      geometry: createSphereGeometry(0.9, 48, 32).unwrap(),
      position: [1.2, 0.9, 0],
      baseColor: 0xc98242,
      metallic: 0.65,
      roughness: 0.25,
      emissive: 0,
      emissiveIntensity: 0,
    },
    {
      geometry: createSphereGeometry(0.25, 32, 24).unwrap(),
      position: [0, 1.9, -1.4],
      baseColor: 0xffffff,
      metallic: 0,
      roughness: 0.5,
      emissive: 0xffc070,
      emissiveIntensity: 6,
    },
  ];
  const meshes = objects.map(({ geometry, position, ...parameters }) =>
    world
      .spawn(
        { component: Transform, data: { pos: position } },
        {
          component: MeshFilter,
          data: { assetHandle: world.allocSharedRef('MeshAsset', geometry) },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [world.allocSharedRef('MaterialAsset', Materials.standard(parameters))],
          },
        },
        { component: ShadowParticipation, data: {} },
      )
      .unwrap(),
  );

  app.start().unwrap();
  return {
    /** @param {'direct' | 'post' | 'bloom'} mode */
    setMode(mode) {
      world
        .set(camera, Camera, {
          tonemap: mode === 'direct' ? TONEMAP_NONE : TONEMAP_ACES_FILMIC,
          antialias: mode === 'direct' ? ANTIALIAS_NONE : ANTIALIAS_FXAA,
          bloom: mode === 'bloom' ? BLOOM_ENABLED : BLOOM_DISABLED,
        })
        .unwrap();
    },
    /** @param {boolean} enabled */
    setShadows(enabled) {
      for (const mesh of meshes)
        world.set(mesh, ShadowParticipation, { receive: enabled }).unwrap();
    },
    /** @param {boolean} enabled */
    setAmbient(enabled) {
      world.set(ambient, Skylight, { intensity: enabled ? 0.3 : 0 }).unwrap();
    },
    /** @param {boolean} side */
    setView(side) {
      const pos = [side ? -7 : 7, 5, 9];
      world
        .set(camera, Transform, {
          pos,
          quat: quat.fromLookAt(quat.create(), pos, [0, 0.8, 0], [0, 1, 0]),
        })
        .unwrap();
    },
    async dispose() {
      unsubscribe();
      (await app.dispose()).unwrap();
    },
  };
}
