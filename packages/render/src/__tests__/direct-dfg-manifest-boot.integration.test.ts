import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { buildEngineShaderManifest } from '../../../vite-plugin-shader/src/index';
import { prepareMaterialShaders } from '../assembly/material-shader-policy';

it('loads the published fit/LUT manifest through ordinary renderer boot without admitting ray kernels as materials', async () => {
  const previousSource = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
  const previousShared = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
  delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  try {
    const published = JSON.stringify(await buildEngineShaderManifest());
    const registry = new ShaderRegistry({
      manifestUrl: 'memory://engine-shaders/manifest.json',
      readText: async () => published,
    });
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    // The simulator has no storage buffers. A storage-capable null backend
    // would hide the extra undeclared axis in the canonical all-true key.
    vi.spyOn(device, 'caps', 'get').mockReturnValue({
      ...device.caps,
      backendKind: 'wgpu-webgl2',
      storageBuffer: false,
    });
    const assets = new AssetRegistry(registry);
    await prepareMaterialShaders(device, () => registry, assets, new Map());
    const ray = [...registry.materialShaderManifestEntries()].find((entry) =>
      entry.sourcePath.replaceAll('\\', '/').endsWith('/ray-path-tracer.wgsl'),
    );
    expect(ray?.identifier).toBe('forgeax::engine-ray-path-tracer');
    expect(ray?.variants.map((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE).sort()).toEqual(
      [false, true],
    );
    expect(registry.findMaterialArtifact('forgeax::engine-ray-path-tracer').ok).toBe(false);
    expect(registry.findMaterialArtifact('forgeax::default-standard-pbr').ok).toBe(true);
  } finally {
    if (previousSource === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previousSource;
    if (previousShared === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previousShared;
  }
}, 300_000);
