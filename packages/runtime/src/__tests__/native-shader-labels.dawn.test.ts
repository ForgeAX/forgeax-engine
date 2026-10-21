import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import type { MaterialAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { createIrradianceFieldHarness } from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'compiles content-addressed Standard shaders after native renderer initialization',
  async () => {
    const bootstrapStandardPipelines: string[] = [];
    const materialTargets = new Map<string, string[]>();
    const rhi = {
      ...webgpu.rhi,
      requestAdapter: async (...args: Parameters<typeof webgpu.rhi.requestAdapter>) => {
        const result = await webgpu.rhi.requestAdapter(...args);
        if (!result.ok) return result;
        const adapter = result.value;
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (...deviceArgs) => {
          const deviceResult = await requestDevice(...deviceArgs);
          if (deviceResult.ok) {
            const device = deviceResult.value;
            const createPipeline = device.createRenderPipeline.bind(device);
            device.createRenderPipeline = (descriptor) => {
              const label = descriptor.label ?? '';
              if (/^pbr-pipeline-standard(?:-hdr)?$/.test(label))
                bootstrapStandardPipelines.push(label);
              if (label.startsWith('pbr-pipeline-'))
                materialTargets.set(
                  label,
                  descriptor.fragment?.targets.map((target) => target?.format ?? 'unattached') ??
                    [],
                );
              return createPipeline(descriptor);
            };
          }
          return deviceResult;
        };
        return result;
      },
    };
    const h = await createIrradianceFieldHarness({
      rhi,
      manifest: shaderManifestUrl(await buildEngineShaderManifest()),
    });
    try {
      expect(bootstrapStandardPipelines).toEqual([]);
      h.setGi(undefined);
      h.setSun(1);
      // Publication admission needs these frames before the cooked Standard
      // pipeline is created; compiling that shader alone misses the regression.
      for (let frame = 0; frame < 4; frame++) await h.draw();
      const image = await h.image();
      expect(h.errors).toEqual([]);
      expect(image.mean).toBeGreaterThan(0);
      // The fixture starts in Deferred. Exercise Forward HDR as well and
      // identify the white Standard material through its admitted Cook programs,
      // so an unrelated unlit or post-process HDR pipeline cannot satisfy this.
      const profile = h.renderer.setProfile({
        ...h.base,
        renderPath: 'forward',
        visibleSurface: false,
      });
      if (!profile.ok) throw profile.error;
      for (let frame = 0; frame < 4; frame++) await h.draw();
      const forwardImage = await h.image();
      expect(h.errors).toEqual([]);
      expect(forwardImage.mean).toBeGreaterThan(0);
      const white = h.assets.getMaterialProjectionForPayload(
        runtimeAssets(h.assets).borrow<MaterialAsset>(h.white).unwrap(),
      );
      expect(white).toBeDefined();
      const targets = white?.passes.flatMap((pass) =>
        pass.programs.flatMap((program) => {
          const target = materialTargets.get(`pbr-pipeline-${program.specializationKey}-hdr`);
          return target === undefined ? [] : [target];
        }),
      );
      expect(targets).toContainEqual(['rgba16float']);
    } finally {
      await h.dispose();
    }
  },
  120_000,
);
