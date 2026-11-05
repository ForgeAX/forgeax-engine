import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, beforeAll, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { verifyPaged2d } from './paged-2d.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

let url: string;
beforeAll(async () => {
  url = shaderManifestUrl(await buildEngineShaderManifest());
}, 120_000);
afterAll(() => URL.revokeObjectURL(url));

it.each([
  'sprite-fold',
  'sprite-instances',
  'instances',
  'tilemap',
] as const)('qualifies 512 %s elements, atlas edits and shrink through 60 native frames', async (kind) => {
  const target = offscreenCanvas(128, 64);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    target.canvas,
    {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice: (device) =>
          ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
      },
    },
    { shaderManifestUrl: url },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  const directory = `artifacts/webgl2-basics/dawn-${kind}`;
  mkdirSync(directory, { recursive: true });
  try {
    await verifyPaged2d(
      host.value.renderer,
      host.value.assets,
      recorder,
      kind,
      async (name, tape, pixels) => {
        writeFileSync(`${directory}/${name}.rhitape`, tape.bytes);
        writeFileSync(`${directory}/${name}.rgba16f`, pixels);
      },
    );
  } finally {
    await host.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    target.destroy();
  }
}, 120_000);
