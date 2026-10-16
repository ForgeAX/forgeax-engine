import type { RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { ShaderCatalog } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { prepareLowLimitMaterialShaderEntry } from '../assembly/material-shader-policy';
import { prewarmRequiredMaterialShaders } from '../assembly/material-shader-prewarm';

const source = `
@group(0) @binding(16) var cloud: texture_2d<f32>;
@group(0) @binding(17) var cloudSampler: sampler;
fn sampleCloud() -> f32 {
  return textureSampleLevel(cloud, cloudSampler, vec2<f32>(0.5), 0.0).x;
}`;

describe('material module prewarm and lazy pipeline agreement', () => {
  it.each([16, 32])('seeds the same source on a %i-texture device', async (limit) => {
    const entry = { source, paramSchema: [] };
    const variantSource = `${source}\n// published variant`;
    const registry = {
      findMaterialArtifact: () => ok(entry),
      materialShaderManifestEntries: () =>
        [
          {
            identifier: 'game::surface',
            variants: [
              { defines: { STYLE: true }, definesKey: 'STYLE=true', composedWgsl: variantSource },
              ...[true, false].map((atmosphere) => ({
                defines: { ATMOSPHERE_AVAILABLE: atmosphere },
                definesKey: `ATMOSPHERE_AVAILABLE=${atmosphere}`,
                composedWgsl: `// atmosphere ${atmosphere}\n${source}`,
              })),
              {
                defines: { VISIBLE_SURFACE_AVAILABLE: true },
                definesKey: 'VISIBLE_SURFACE_AVAILABLE=true',
                composedWgsl: 'enable primitive_index;\n// opt-in receiver output',
              },
              {
                defines: { COVERAGE_ONLY: true },
                definesKey: 'COVERAGE_ONLY=true',
                composedWgsl: '// depth-only optional producer',
              },
            ],
          },
        ][Symbol.iterator](),
    } as unknown as ShaderCatalog;
    const device = {
      caps: { storageBuffer: true, backendKind: 'webgpu' },
      limits: { maxSampledTexturesPerShaderStage: limit },
    } as RhiDevice;
    const compiled = new Map<ShaderModule, string>();
    const seeded = new Map<string, ShaderModule>();
    const compile = vi.fn(async (_device: RhiDevice, descriptor: { code: string }) => {
      const module = {} as ShaderModule;
      compiled.set(module, descriptor.code);
      return ok(module);
    });
    await prewarmRequiredMaterialShaders({
      rhiDevice: device,
      registry,
      requiredMaterialShaders: ['game::surface'],
      asyncCreateShaderModule: compile,
      seedShaderModule: (label, module) => {
        seeded.set(label, module);
      },
    });
    for (const [label, authored] of [
      ['module-game::surface', source],
      ['module-game::surface#STYLE=true', variantSource],
    ] as const) {
      const module = seeded.get(label);
      expect(module).toBeDefined();
      if (module === undefined) throw new Error(`Missing prewarmed module ${label}`);
      expect(compiled.get(module)).toBe(
        prepareLowLimitMaterialShaderEntry({ source: authored, paramSchema: [] }, limit).source,
      );
    }
    expect(compile).toBeCalledTimes(3);
    expect([...seeded.keys()]).toEqual([
      'module-game::surface',
      'module-game::surface#STYLE=true',
      `module-game::surface#ATMOSPHERE_AVAILABLE=${limit >= 31}`,
    ]);
    expect(entry.source).toBe(source);
  });
});
