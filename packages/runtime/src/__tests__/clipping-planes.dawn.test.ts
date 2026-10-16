import { mkdirSync, writeFileSync } from 'node:fs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import type { MaterialAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyClippingPlanes } from './clipping-planes.fixture';
import { startClippingPlanesServer } from './clipping-planes.server';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it('verifies clipping color, depth, shadows and replay on fresh Dawn devices', {
  timeout: 120_000,
}, async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [64, 64],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const server = await startClippingPlanesServer();
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi, ssrIdentity: gbufferReplayIdentity },
      { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport(server.binding) },
    ),
  );
  const directory = 'artifacts/clipping-planes/rhi-debug/dawn';
  mkdirSync(directory, { recursive: true });
  host.assets.configureRuntimeBinding(server.binding);
  try {
    await verifyClippingPlanes(host.renderer, recorder, (name, bytes) => {
      mkdirSync(`${directory}/view`, { recursive: true });
      writeFileSync(`${directory}/view/${name}`, bytes);
    });
    const materials = await Promise.all(
      server.guids.map(async (guid) =>
        renderValue(
          await host.assets.loadByGuid<MaterialAsset>(renderValue(AssetGuid.parse(guid))),
        ),
      ),
    );
    for (const material of materials) {
      const projection = host.assets.getMaterialProjectionForPayload(material);
      expect(projection).toBeDefined();
      expect(material.values?.clippingControl).toBeDefined();
    }
    writeFileSync(`${directory}/materials.json`, JSON.stringify(materials));
    mkdirSync(`${directory}/material`, { recursive: true });
    await verifyClippingPlanes(
      host.renderer,
      recorder,
      (name, bytes) => {
        writeFileSync(`${directory}/material/${name}`, bytes);
      },
      materials,
    );
  } finally {
    await server.close();
    renderValue(await host.renderer.dispose());
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
