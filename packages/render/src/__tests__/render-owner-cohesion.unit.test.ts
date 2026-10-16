import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

const extractRoot = read('../render-system-extract.ts');
const extractTail = read('../render-system-extract-tail.ts');
const rendererSystem = read('../render-system.ts');
const rendererFactory = read('../assembly/factory.ts');
const webgpuReady = read('../assembly/webgpu-ready.ts');
const webgpuPbrReady = read('../assembly/webgpu-pbr-ready.ts');
const gpuDrivenOwner = read('../assembly/gpu-driven-owner.ts');
const skinPaletteOwner = read('../assembly/skin-palette-owner.ts');
const productionRaster = read('../gpu-driven/production-raster.ts');

describe('render owner cohesion', () => {
  it('keeps the MeshRenderer query singular at the extract boundary', () => {
    expect(count(extractTail, /read: \[MeshRenderer\]/g)).toBe(1);
    expect(extractTail).toContain('MeshRenderer');
    expect(extractTail).not.toMatch(/renderableQuery(?:NoMaterial|NoTransform|Full)/);
  });

  it('keeps GPU-driven frame construction in one assembly owner', () => {
    expect(count(gpuDrivenOwner, /new GpuDrivenProduction\(/g)).toBe(1);
    expect(rendererSystem).not.toContain('new GpuDrivenProduction(');
    expect(rendererSystem).toContain('createGpuDrivenOwner(');
    expect(count(skinPaletteOwner, /createSkinPaletteAllocator\(/g)).toBe(1);
    expect(rendererFactory).not.toContain('createSkinPaletteAllocator(');
  });

  it('keeps production raster free of World and AssetRegistry reads', () => {
    expect(productionRaster).not.toMatch(/^import[^\n]*\bWorld\b/m);
    expect(productionRaster).not.toMatch(
      /AssetRegistry|resolveAssetHandle|assets\.(?:get|lookup|load)/,
    );
    expect(productionRaster).toContain('RenderableSnapshot');
  });

  it('keeps the root seams attached to their single owners', () => {
    expect(extractRoot).not.toContain("from './render-system-extract-tail'");
    expect(extractTail).toContain("from './extract/world-environment'");
    expect(extractTail).toContain('export function extractFrame');
    expect(webgpuPbrReady).toContain('buildGpuDrivenPbrReadyModules');
    expect(webgpuPbrReady).toContain('buildGpuDrivenPbrReadyLayouts');
    expect(webgpuReady).toContain('buildGpuDrivenPbrReadyModules({');
    expect(webgpuReady).toContain('buildGpuDrivenPbrReadyLayouts(rhiDevice');
    expect(webgpuReady).toContain('gpuDrivenPbrPrograms:');
    expect(webgpuReady).toContain('gpuDrivenPbrPipelineLayout:');
    expect(rendererSystem).toContain('createGpuDrivenOwner(');
    expect(productionRaster).not.toContain('ownsAllRenderables');
    expect(productionRaster).not.toContain('gpuOwnedEntityKeys');
  });
});
