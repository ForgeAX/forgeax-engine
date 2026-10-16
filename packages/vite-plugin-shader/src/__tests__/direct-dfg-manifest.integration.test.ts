import { expect, it } from 'vitest';
import { buildEngineShaderManifest } from '../index.js';

it('publishes fit defaults and distinct LUT utility variants from real Engine sources', async () => {
  const previousSource = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
  const previousShared = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
  delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  try {
    const manifest = await buildEngineShaderManifest();
    for (const identifier of [
      'forgeax::engine-ray-path-tracer',
      'forgeax::engine-standard-deferred-lighting',
    ]) {
      const entry = manifest.materialShaders.find((entry) => entry.identifier === identifier);
      expect(entry, identifier).toBeDefined();
      const fit =
        entry?.variants.filter((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === false) ??
        [];
      const lut =
        entry?.variants.filter((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === true) ??
        [];
      expect(fit.length).toBeGreaterThan(0);
      expect(lut.length).toBe(fit.length);
      expect(fit.some((variant) => variant.composedWgsl === entry?.composedWgsl)).toBe(true);
      expect(manifest.entries.some((candidate) => candidate.wgsl === entry?.composedWgsl)).toBe(
        true,
      );
      for (const variant of fit) {
        expect(/var directDfgLut(?:_\d+)?\b/.test(variant.composedWgsl), `${identifier} fit`).toBe(
          false,
        );
      }
      for (const variant of lut) {
        expect(
          /var directDfgLut(?:_\d+)?\b/.test(variant.composedWgsl),
          `${identifier} LUT: ${variant.composedWgsl.match(/var\s+\w*Dfg\w*/g)?.join(', ')}`,
        ).toBe(true);
      }
    }
  } finally {
    if (previousSource === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previousSource;
    if (previousShared === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previousShared;
  }
}, 300_000);
