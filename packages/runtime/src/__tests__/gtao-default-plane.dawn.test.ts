import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { RESPONSE_SIZE, renderWorldResponse } from './skylight-response.fixture';

function planeWorld() {
  const world = new World();
  const mesh = testAssets(world)
    .create(createBoxGeometry(40, 40, 0.001).unwrap())
    .unwrap();
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 }))
    .unwrap();
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, -4], quat: [Math.sin(-Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)] },
      },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: {} }).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
  return world;
}

it('default zero-bias GTAO leaves an unoccluded tilted receiver unchanged', async () => {
  const target = offscreenCanvas(RESPONSE_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const manifest = shaderManifestUrl(await buildEngineShaderManifest());
  const host = await constructRuntimeRendererHost(
    target.canvas as unknown as HTMLCanvasElement,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifest },
  );
  if (!host.ok) throw host.error;
  const renderer = host.value.renderer;
  const directory =
    process.env.FORGEAX_GTAO_EVIDENCE_DIR ?? 'artifacts/rendering-parity/gtao-plane';
  mkdirSync(directory, { recursive: true });
  try {
    const baseline = await renderWorldResponse(renderer, planeWorld(), 'deferred');
    const profile = renderer.setProfile({
      ...renderer.inspect().profile,
      ssao: { algorithm: 'gtao', quality: 'high' },
    });
    if (!profile.ok) throw profile.error;
    const actual = await renderWorldResponse(renderer, planeWorld(), 'deferred', async (draw) => {
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const tape = (await pending).unwrap();
      writeFileSync(`${directory}/frame.rhitape`, tape.bytes);
      writeFileSync(
        `${directory}/frame.json`,
        JSON.stringify(
          {
            digest: tape.digest,
            ...summarizeFrame(buildFrameModel(decodeTape(tape.bytes).unwrap())),
          },
          null,
          2,
        ),
      );
    });
    let minimum = 1,
      total = 0,
      count = 0;
    for (let y = 24; y < RESPONSE_SIZE - 24; y++)
      for (let x = 24; x < RESPONSE_SIZE - 24; x++) {
        const i = (y * RESPONSE_SIZE + x) * 3;
        const visibility = (actual[i] ?? NaN) / (baseline[i] ?? NaN);
        minimum = Math.min(minimum, visibility);
        total += visibility;
        count++;
      }
    writeFileSync(`${directory}/result.json`, JSON.stringify({ minimum, mean: total / count }));
    expect(minimum).toBeGreaterThan(0.99);
    expect(total / count).toBeGreaterThan(0.999);
  } finally {
    renderer.dispose();
    target.destroy();
  }
}, 120_000);
