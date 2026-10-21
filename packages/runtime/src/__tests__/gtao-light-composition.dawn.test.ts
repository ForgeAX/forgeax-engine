import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  AmbientOcclusion,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { RESPONSE_SIZE, renderWorldResponse } from './skylight-response.fixture';
import { unwrap } from './specular-aa.fixture';

function contactWorld(environment: boolean, direct: boolean, directLightingStrength?: number) {
  const world = new World();
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 1 }))
    .unwrap();
  for (const [width, height, depth, z] of [
    [20, 20, 0.01, -4.005],
    [1.4, 1.4, 0.2, -3.9],
  ]) {
    const mesh = testAssets(world)
      .create(createBoxGeometry(width, height, depth).unwrap())
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, z ?? 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  if (environment) world.spawn({ component: Skylight, data: {} }).unwrap();
  if (direct)
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, 0, -1], intensity: 1, castShadow: false },
      })
      .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
  if (directLightingStrength !== undefined)
    world
      .addComponent(camera, { component: AmbientOcclusion, data: { directLightingStrength } })
      .unwrap();
  return world;
}

it('GTAO weights environment once and leaves direct lighting unchanged by default', async () => {
  const path = 'deferred';
  const surface = offscreenCanvas(RESPONSE_SIZE);
  const renderer = unwrap(
    await constructRuntimeRendererHost(
      surface.canvas as unknown as HTMLCanvasElement,
      { rhi: webgpu.rhi },
      { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    ),
  ).renderer;
  try {
    const images: Float32Array[] = [];
    for (const enabled of [false, true]) {
      if (enabled)
        unwrap(
          renderer.setProfile({
            ...renderer.inspect().profile,
            ssao: { algorithm: 'gtao', quality: 'high' },
          }),
        );
      for (const [environment, direct] of [
        [true, false],
        [false, true],
        [true, true],
      ]) {
        images.push(
          await renderWorldResponse(
            renderer,
            contactWorld(environment ?? false, direct ?? false),
            path,
          ),
        );
      }
    }
    const [environment, direct, combined, environmentAo, directAo, combinedAo] = images;
    if (!environment || !direct || !combined || !environmentAo || !directAo || !combinedAo)
      throw new Error('Missing AO composition images');
    let directError = 0,
      compositionError = 0,
      minimumAmbientVisibility = 1,
      affected = 0;
    for (let y = 16; y < RESPONSE_SIZE - 16; y++)
      for (let x = 16; x < RESPONSE_SIZE - 16; x++) {
        const i = (y * RESPONSE_SIZE + x) * 3;
        directError = Math.max(directError, Math.abs((directAo[i] ?? NaN) - (direct[i] ?? NaN)));
        compositionError = Math.max(
          compositionError,
          Math.abs((combinedAo[i] ?? NaN) - (environmentAo[i] ?? NaN) - (direct[i] ?? NaN)),
        );
        const visibility = (environmentAo[i] ?? NaN) / (environment[i] ?? NaN);
        minimumAmbientVisibility = Math.min(minimumAmbientVisibility, visibility);
        if (visibility < 0.95) affected++;
      }
    const directory = 'artifacts/rendering-parity/gtao-light-composition';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/${path}.json`,
      JSON.stringify({ directError, compositionError, minimumAmbientVisibility, affected }),
    );
    expect(directError).toBeLessThan(0.002);
    expect(compositionError).toBeLessThan(0.003);
    // A contact with no active AO would satisfy the algebra but must fail this falsifier.
    expect(minimumAmbientVisibility).toBeLessThan(0.95);
    expect(affected).toBeGreaterThan(50);
    const directOptIn = await renderWorldResponse(renderer, contactWorld(false, true, 1), path);
    let optedInError = 0;
    for (let i = 0; i < directOptIn.length; i++) {
      const visibility = (environmentAo[i] ?? NaN) / (environment[i] ?? NaN);
      optedInError = Math.max(
        optedInError,
        Math.abs((directOptIn[i] ?? NaN) - (direct[i] ?? NaN) * visibility),
      );
    }
    expect(optedInError).toBeLessThan(0.003);
  } finally {
    unwrap(await renderer.dispose());
    surface.destroy();
  }
}, 120_000);
