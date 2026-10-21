import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { buildEngineShaderManifest } from '../../../vite-plugin-shader/src/index';
import { prepareMaterialShaders } from '../assembly/material-shader-policy';

it('loads the published fit/LUT manifest through ordinary renderer boot without admitting ray kernels as materials', async () => {
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
  await prepareMaterialShaders(device, () => registry, new Map());
  const ray = [...registry.materialShaderManifestEntries()].find((entry) =>
    entry.sourcePath.replaceAll('\\', '/').endsWith('/ray-path-tracer.wgsl'),
  );
  expect(ray?.identifier).toBe('forgeax::engine-ray-path-tracer');
  expect(ray?.variants.map((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE).sort()).toEqual([
    false,
    true,
  ]);
  expect(registry.findMaterialArtifact('forgeax::engine-ray-path-tracer').ok).toBe(false);
  expect(registry.findMaterialArtifact('forgeax::default-standard-pbr').ok).toBe(true);
}, 300_000);
