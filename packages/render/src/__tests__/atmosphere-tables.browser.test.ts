import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import * as wgpu from '../../../rhi-wgpu/src/index';
import { earthAtmosphere } from './atmosphere-fixture';
import { runAtmosphereTables } from './atmosphere-tables-gpu';
import type { SsrShaderManifest } from './ssr-gpu-dispatch';

it('matches all physical sky LUT texels across WebGPU compute, raster and actual WebGL2', {
  timeout: 180000,
}, async () => {
  const response = await fetch('/shaders/manifest.json');
  expect(response.ok).toBe(true);
  const manifest = (await readShaderManifestPublication(
    await response.json(),
  )) as SsrShaderManifest;
  const source = (entry: string) => {
    const found = manifest.entries.find((row) => row.wgsl.includes(`fn ${entry}(`));
    if (found === undefined) throw new Error(`missing published ${entry}`);
    return found.wgsl;
  };
  const native = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let portable: import('@forgeax/engine-rhi').RhiDevice | undefined;
  const previous = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  try {
    const reference = await runAtmosphereTables(
      native,
      (desc) => webgpu.createShaderModuleImmediate(native, desc),
      source('atmosphere_transmittance'),
      'compute',
    );
    const raster = await runAtmosphereTables(
      native,
      (desc) => webgpu.createShaderModuleImmediate(native, desc),
      source('atmosphere_transmittance_fragment'),
      'fragment',
    );
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    const adapter = (await wgpu.rhi.requestAdapter({}, canvas)).unwrap();
    portable = (await adapter.requestDevice()).unwrap();
    expect(portable.caps.backendKind).toBe('wgpu-webgl2');
    const device = portable;
    const gl = await runAtmosphereTables(
      device,
      (desc) => wgpu.createShaderModuleImmediate(device, desc),
      source('atmosphere_transmittance_fragment'),
      'fragment',
    );
    const summaries = [];
    for (const [lane, actual] of [
      ['webgpu-fragment', raster],
      ['wgpu-webgl2-fragment', gl],
    ] as const) {
      for (const [index, expected] of reference.entries()) {
        const table = actual[index];
        expect(table?.name).toBe(expected.name);
        if (table === undefined) throw new Error('missing physical table');
        let maximum = 0,
          maximumRgb = 0;
        for (const [channel, value] of table.values.entries()) {
          expect(Number.isFinite(value)).toBe(true);
          if (channel % 4 !== 3) maximumRgb = Math.max(maximumRgb, value);
          const target = expected.values[channel] ?? 0;
          maximum = Math.max(maximum, Math.abs(value - target) / Math.max(0.001, Math.abs(target)));
        }
        expect(maximum, `${lane} ${table.name}`).toBeLessThan(0.005);
        expect(maximumRgb, `${lane} ${table.name} nonzero transport`).toBeGreaterThan(0.001);
        summaries.push({
          lane,
          table: table.name,
          channels: table.values.length,
          maximumRelativeError: maximum,
          maximumRgb,
        });
      }
    }
    // Independent vertical Beer-law integral at the bottom-left transmittance texel.
    const medium = earthAtmosphere;
    const rayleigh =
      medium.rayleighScaleHeight *
      (1 - Math.exp(-medium.atmosphereHeight / medium.rayleighScaleHeight));
    const mie =
      medium.mieScaleHeight * (1 - Math.exp(-medium.atmosphereHeight / medium.mieScaleHeight));
    for (let channel = 0; channel < 3; channel++) {
      const expected = Math.exp(
        -(medium.rayleighScattering[channel] ?? 0) * rayleigh -
          (medium.mieScattering + medium.mieAbsorption) * mie -
          (medium.absorption[channel] ?? 0) * medium.absorptionHalfWidth,
      );
      expect(Math.abs((gl[0]?.values[channel] ?? 0) - expected)).toBeLessThan(0.002);
    }
    await commands.writeFile(
      'artifacts/ci-focus/atmosphere-background/tables.json',
      JSON.stringify(summaries),
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', previous);
    webgpu.disposeDevice(native);
    if (portable !== undefined) wgpu.disposeDevice(portable);
  }
});
