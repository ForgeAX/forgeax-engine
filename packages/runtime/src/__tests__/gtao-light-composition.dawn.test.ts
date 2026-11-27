import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_TAA,
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
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderPublicationUrl } from './shader-manifest-url.fixture';
import { RESPONSE_SIZE, renderWorldResponse } from './skylight-response.fixture';
import { unwrap } from './specular-aa.fixture';

function contactWorld(environment: boolean, direct: boolean, emissive = false, antialias = 0) {
  const world = new World();
  const material = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        metallic: 0,
        roughness: 1,
        ...(emissive ? { emissive: [0.25, 0.125, 0.375] } : {}),
      }),
    )
    .unwrap();
  for (const [width, height, depth, z, x] of [
    [20, 20, 0.01, -4.005, 0],
    [1.4, 1.4, 0.8, -3.6, 0],
    // A shallow contact keeps near-edge samples inside the default GTAO falloff.
    [0.9, 1.4, 0.2, -3.9, 1.4],
  ]) {
    const mesh = testAssets(world)
      .create(createBoxGeometry(width, height, depth).unwrap())
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [x ?? 0, 0, z ?? 0] } },
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
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
  return world;
}

const CASES = [
  ['forward', 'ssao', 0],
  ['forward', 'gtao', 0],
  ['deferred', 'ssao', 0],
  ['deferred', 'gtao', 0],
  ['deferred', 'gtao', ANTIALIAS_TAA],
] as const;

it.each(CASES)(
  'composes Standard %s %s with AA %i using only indirect lighting',
  async (path, method, antialias) => {
    const surface = offscreenCanvas(RESPONSE_SIZE);
    const { renderer } = unwrap(
      await constructRuntimeRendererHost(
        surface.canvas as unknown as HTMLCanvasElement,
        { rhi: webgpu.rhi },
        { shaderManifestUrl: shaderPublicationUrl(await buildEngineShaderTemplateManifest()) },
      ),
    );
    try {
      const render = (environment: boolean, direct: boolean, emissive = false) =>
        renderWorldResponse(renderer, contactWorld(environment, direct, emissive, antialias), path);
      const profile = {
        ...renderer.inspect().profile,
        renderPath: path,
        ...(path === 'deferred' ? { gbufferFormat: 'default' as const } : {}),
      };
      unwrap(renderer.setProfile({ ...profile, ambientOcclusion: { enabled: false } }));
      const indirect = await render(true, false);
      const direct = await render(false, true);
      const emissive = await render(false, false, true);

      unwrap(
        renderer.setProfile({
          ...profile,
          ambientOcclusion: {
            enabled: true,
            method,
            intensity: 1,
          },
        }),
      );
      const indirectAo = await renderWorldResponse(
        renderer,
        contactWorld(true, false, false, antialias),
        path,
        async (draw) => {
          for (let frame = 1; frame < 60; frame++) await draw();
          if (path === 'deferred' && method === 'gtao') {
            const receipt = renderer.inspect().standardLighting?.ambientOcclusion;
            expect(receipt?.historyFrames).toBeGreaterThanOrEqual(59);
          }
        },
      );
      const directAo = await render(false, true);
      const emissiveAo = await render(false, false, true);
      let directError = 0;
      let emissiveError = 0;
      let affected = 0;
      let minRatio = 1;
      for (let y = 16; y < RESPONSE_SIZE - 16; y++) {
        for (let x = 16; x < RESPONSE_SIZE - 16; x++) {
          const i = (y * RESPONSE_SIZE + x) * 3;
          directError = Math.max(directError, Math.abs((directAo[i] ?? NaN) - (direct[i] ?? NaN)));
          emissiveError = Math.max(
            emissiveError,
            Math.abs((emissiveAo[i] ?? NaN) - (emissive[i] ?? NaN)),
          );
          minRatio = Math.min(minRatio, (indirectAo[i] ?? NaN) / (indirect[i] ?? NaN));
          const cutoff = path === 'deferred' && method === 'gtao' ? 0.99 : 0.95;
          if ((indirectAo[i] ?? NaN) < cutoff * (indirect[i] ?? NaN)) affected++;
        }
      }
      const inspection = renderer.inspect().standardLighting?.ambientOcclusion;
      expect(inspection?.status).toBe('active');
      expect(inspection?.passes).not.toContain('ssao-scene-color');
      if (path === 'deferred' && method === 'gtao')
        expect(inspection?.passes).toEqual(
          expect.arrayContaining(['gtao-spatial', 'gtao-temporal', 'gtao-resolve']),
        );
      else if (path === 'forward') expect(inspection?.passes).not.toContain('ssao-blur');
      expect(affected, `minimum indirect ratio ${minRatio}`).toBeGreaterThan(50);
      expect(directError).toBeLessThan(0.002);
      expect(emissiveError).toBeLessThan(0.002);
    } finally {
      unwrap(await renderer.dispose());
      surface.destroy();
    }
  },
  120_000,
);
