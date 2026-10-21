import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  SkyboxBackground,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { RESPONSE_SIZE, renderWorldResponse, responsePanorama } from './skylight-response.fixture';
import { unwrap } from './specular-aa.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

// A fully rough white conductor reduces to cosine-weighted environment light.
// Looking at the same flat patch from the front or a grazing angle must not
// redirect that broad lobe into the opposite side of the environment.
function planeWorld(angle: number, source: 'studio' | 'panorama' | 'solid' = 'studio') {
  const world = new World();
  const mesh = testAssets(world).create(createPlaneGeometry(20, 20).unwrap()).unwrap();
  const material = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallic: 1,
        roughness: 1,
      }),
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -5] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn({
      component: Skylight,
      data: {
        ...(source === 'solid'
          ? {}
          : {
              equirect: testAssets(world)
                .create({
                  kind: 'equirect',
                  ...responsePanorama(source),
                  format: 'rgba16float',
                  colorSpace: 'linear',
                })
                .unwrap(),
            }),
      },
    })
    .unwrap();
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [5 * Math.sin(angle), 0, -5 + 5 * Math.cos(angle)],
          quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
        },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          clearColor: [0, 0, 0, 1],
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
  return world;
}

function center(rgb: Float32Array) {
  const mean = [0, 0, 0];
  for (let y = 126; y < 130; y++)
    for (let x = 126; x < 130; x++)
      for (let c = 0; c < 3; c++)
        mean[c] = (mean[c] ?? 0) + (rgb[(y * RESPONSE_SIZE + x) * 3 + c] ?? NaN) / 16;
  return mean;
}

for (const path of ['forward', 'deferred'] as const)
  it(`fully rough environment radiance stays at the surface normal in ${path}`, {
    timeout: 300_000,
  }, async () => {
    const target = offscreenCanvas(RESPONSE_SIZE);
    const host = unwrap(
      await constructRuntimeRendererHost(
        target.canvas,
        { rhi },
        { shaderManifestUrl: manifestUrl },
      ),
    );
    try {
      const front = center(await renderWorldResponse(host.renderer, planeWorld(0), path));
      const grazing = center(
        await renderWorldResponse(host.renderer, planeWorld(Math.PI / 3), path),
      );
      mkdirSync('artifacts/environment-prefilter/dawn', { recursive: true });
      writeFileSync(
        `artifacts/environment-prefilter/dawn/${path}.json`,
        JSON.stringify({ front, grazing }, null, 2),
      );
      for (let c = 0; c < 3; c++) {
        expect(front[c], 'HDR environment reaches the receiver').toBeGreaterThan(0.1);
        expect(
          Math.abs((front[c] ?? NaN) - (grazing[c] ?? NaN)),
          `view-independent rough radiance channel ${c}`,
        ).toBeLessThan(0.02);
      }
    } finally {
      unwrap(await host.renderer.dispose());
      target.destroy();
    }
  });

for (const path of ['forward', 'deferred'] as const)
  it(`switches image sources and returns to solid Skylight in ${path}`, {
    timeout: 300_000,
  }, async () => {
    const target = offscreenCanvas(RESPONSE_SIZE);
    const host = unwrap(
      await constructRuntimeRendererHost(
        target.canvas,
        { rhi },
        { shaderManifestUrl: manifestUrl },
      ),
    );
    try {
      // Switching managed source identities and resource scopes must replace
      // image radiance; returning to solid must not retain a prior image.
      const white = center(
        await renderWorldResponse(host.renderer, planeWorld(0, 'panorama'), path),
      );
      const studio = center(
        await renderWorldResponse(host.renderer, planeWorld(0, 'studio'), path),
      );
      const solid = center(await renderWorldResponse(host.renderer, planeWorld(0, 'solid'), path));
      for (let c = 0; c < 3; c++) {
        expect(Math.abs((white[c] ?? NaN) - 1)).toBeLessThan(0.02);
        expect(
          (white[c] ?? NaN) - (studio[c] ?? NaN),
          'the distinct HDR source must replace white radiance',
        ).toBeGreaterThan(0.2);
        expect(
          Math.abs((solid[c] ?? NaN) - 1),
          'solid must discard prior image radiance',
        ).toBeLessThan(0.001);
      }
    } finally {
      unwrap(await host.renderer.dispose());
      target.destroy();
    }
  });

it('keeps independent skybox and Skylight images in the same frame', {
  timeout: 300_000,
}, async () => {
  const target = offscreenCanvas(RESPONSE_SIZE);
  const host = unwrap(
    await constructRuntimeRendererHost(target.canvas, { rhi }, { shaderManifestUrl: manifestUrl }),
  );
  try {
    const world = planeWorld(0);
    world
      .spawn({
        component: SkyboxBackground,
        data: {
          equirect: testAssets(world)
            .create({
              kind: 'equirect',
              ...responsePanorama('panorama'),
              format: 'rgba16float',
              colorSpace: 'linear',
            })
            .unwrap(),
        },
      })
      .unwrap();
    const pixel = center(await renderWorldResponse(host.renderer, world, 'forward'));
    expect(pixel[0]).toBeGreaterThan(0.4);
    expect(pixel[0]).toBeLessThan(0.7);
    expect((pixel[0] ?? NaN) - (pixel[2] ?? NaN)).toBeGreaterThan(0.2);
  } finally {
    unwrap(await host.renderer.dispose());
    target.destroy();
  }
});
