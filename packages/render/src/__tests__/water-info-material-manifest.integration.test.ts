import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { publishShaderManifest } from '../../../vite-plugin-shader/src/manifest-publication';
import { prepareMaterialShaders } from '../assembly/material-shader-policy';

const WATER_INFO_SHADER_IDENTIFIERS = [
  'forgeax::water-info-raster-water',
  'forgeax::water-info-raster-ground',
  'forgeax::water-info-raster-dilation',
] as const;

it('publishes WaterInfo raster shaders into renderer material artifacts', async () => {
  const engine = await loadEngineShaderEntries();
  const shaders = [
    engine.waterInfoRasterWater,
    engine.waterInfoRasterGround,
    engine.waterInfoRasterDilation,
  ];
  const materialShaders = [];
  const flatEntries = [];
  for (const shader of shaders) {
    const compiled = await compileShader(shader.source, {
      id: shader.id,
      imports: engine.imports,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok || shader.reservedIdentifier === undefined) continue;
    const { manifestEntry } = compiled.value;
    flatEntries.push({
      hash: manifestEntry.hash,
      wgsl: manifestEntry.wgsl,
      glsl: '',
      bindings:
        typeof manifestEntry.bindings === 'string'
          ? manifestEntry.bindings
          : JSON.stringify(manifestEntry.bindings),
    });
    materialShaders.push({
      identifier: shader.reservedIdentifier,
      sourcePath: shader.id,
      hash: manifestEntry.hash,
      composedWgsl: manifestEntry.wgsl,
      paramSchema: '[]',
      variants: [],
    });
  }
  const published = JSON.stringify(publishShaderManifest(flatEntries, materialShaders));
  const registry = new ShaderRegistry({
    manifestUrl: 'memory://engine-shaders/water-info.json',
    readText: async () => published,
  });
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();

  await prepareMaterialShaders(device, () => registry, new Map());

  const entries = [...registry.materialShaderManifestEntries()];
  expect(entries.map((entry) => entry.identifier).sort()).toEqual(
    [...WATER_INFO_SHADER_IDENTIFIERS].sort(),
  );
  for (const identifier of WATER_INFO_SHADER_IDENTIFIERS) {
    expect(registry.findMaterialArtifact(identifier).ok).toBe(true);
  }
});
