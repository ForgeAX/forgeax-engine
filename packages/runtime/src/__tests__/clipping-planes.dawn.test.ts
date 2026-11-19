import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyClippingPlanes } from './clipping-planes.fixture';
import { startClippingPlanesServer } from './clipping-planes.server';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
async function fixture(mode: 'local' | 'view') {
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
  const server = await startClippingPlanesServer(mode);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi, ssrIdentity: gbufferReplayIdentity },
      { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport(server.binding) },
    ),
  );
  const directory = 'artifacts/clipping-planes/rhi-debug/dawn';
  host.assets.configureRuntimeBinding(server.binding);
  return {
    server,
    recorder,
    host,
    save(group: string, name: string, bytes: Uint8Array) {
      mkdirSync(`${directory}/${group}`, { recursive: true });
      writeFileSync(`${directory}/${group}/${name}`, bytes);
    },
    async dispose() {
      await server.close();
      renderValue(await host.renderer.dispose());
      target?.destroy();
      (await recorder.dispose()).unwrap();
    },
  };
}

it('verifies clipping color, depth, shadows and replay on fresh Dawn devices', {
  timeout: 120_000,
}, async () => {
  const f = await fixture('local');
  try {
    await verifyClippingPlanes(f.host.renderer, f.recorder, (name, bytes) =>
      f.save('view', name, bytes),
    );
    const handles = await Promise.all(
      f.server.guids.map(async (guid) => (await f.host.assets.load(guid, 'material')).unwrap()),
    );
    const materials = handles.map((handle) => f.host.assets.read(handle).unwrap());
    for (const material of materials) expect(material.values?.clippingControl).toBeDefined();
    f.save('', 'materials.json', new TextEncoder().encode(JSON.stringify(materials)));
    await verifyClippingPlanes(
      f.host.renderer,
      f.recorder,
      (name, bytes) => f.save('material', name, bytes),
      { assets: f.host.assets, handles },
    );
  } finally {
    await f.dispose();
  }
});

it('selects view clipping per camera for one cooked opaque material through color, depth, shadows and replay', {
  timeout: 120_000,
}, async () => {
  const started = performance.now();
  const f = await fixture('view');
  try {
    const material = (await f.host.assets.load(f.server.viewMaterialGuid, 'material')).unwrap();
    expect(f.host.assets.read(material).unwrap().values?.clippingControl).toBeUndefined();
    const projection = f.host.assets.getMaterialProjection(material).unwrap();
    const programs =
      projection?.passes
        .flatMap((pass) => pass.programs)
        .filter(
          (program) =>
            program.context.pipeline !== 'ray' &&
            program.context.viewClipping !== true &&
            program.context.lodCoverage !== true,
        ) ?? [];
    expect(programs.length).toBeGreaterThan(0);
    const families = programs.map((program) => ({
      key: program.specializationKey,
      context: program.context,
      address: program.address,
      variants: f.host.assets.shaderRegistry
        .materialShaderManifestEntry(program.specializationKey)
        ?.variants.map((variant) => variant.defines),
    }));
    f.save('cooked-view', 'programs.json', new TextEncoder().encode(JSON.stringify(families)));
    for (const family of families) {
      const lod =
        family.context.pipeline !== 'ray' &&
        family.context.capability !== 'uniform-fallback' &&
        (family.context.geometry === 'mesh' || family.context.pass === 'shadow');
      expect(family.variants).toEqual(
        lod
          ? [0, 1, 2, 3].map((mask) => ({
              CLIPPING_PLANES: (mask & 2) !== 0,
              LOD_DITHER: (mask & 1) !== 0,
            }))
          : [{ CLIPPING_PLANES: false }, { CLIPPING_PLANES: true }],
      );
    }
    const readyMs = Math.round(performance.now() - started);
    await verifyClippingPlanes(
      f.host.renderer,
      f.recorder,
      (name, bytes) => f.save('cooked-view', name, bytes),
      {
        assets: f.host.assets,
        handles: Array.from({ length: 5 }, () => material),
        viewClipping: true,
      },
    );
    f.save(
      'cooked-view',
      'timings.json',
      new TextEncoder().encode(
        JSON.stringify({ readyMs, verifiedMs: Math.round(performance.now() - started) }),
      ),
    );
  } finally {
    await f.dispose();
  }
});
