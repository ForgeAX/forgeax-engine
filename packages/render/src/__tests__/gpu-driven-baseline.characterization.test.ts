import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

const productionRaster = read('../gpu-driven/production-raster.ts');
const productionRasterMaterial = read('../gpu-driven/production-raster-material.ts');
const frameRecord = read('../record/frame.ts');
const mainPass = read('../record/main-pass.ts');
const shadowPass = read('../record/shadow-pass.ts');
const skinTasks = read('../record/skin-tasks.ts');
const extractRoot = read('../render-system-extract.ts');
const extractTail = read('../render-system-extract-tail.ts');
const rendererSystem = read('../render-system.ts');
const webgpuReady = read('../assembly/webgpu-ready.ts');
const webgpuPbrReady = read('../assembly/webgpu-pbr-ready.ts');
const gpuDrivenOwner = read('../assembly/gpu-driven-owner.ts');

describe('GPU-driven baseline characterization', () => {
  it('records the exact source revision and current owner seams', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(extractRoot).not.toContain("from './render-system-extract-tail'");
    expect(extractTail).toContain("from './extract/world-environment'");
    expect(extractTail).toContain('export function extractFrame');
    expect(extractTail).toContain('read: [MeshRenderer]');
    expect(webgpuPbrReady).toContain('export async function buildGpuDrivenPbrReadyModules');
    expect(webgpuPbrReady).toContain('export function buildGpuDrivenPbrReadyLayouts');
    expect(webgpuReady).toContain(
      "import { buildGpuDrivenPbrReadyLayouts, buildGpuDrivenPbrReadyModules } from './webgpu-pbr-ready';",
    );
    expect(webgpuReady).toContain('const gpuDrivenModules = await buildGpuDrivenPbrReadyModules({');
    expect(webgpuReady).toContain('gpuDrivenPbrPrograms:');
    expect(webgpuReady).toContain('gpuDrivenPbrPipelineLayout:');
    expect(rendererSystem).toContain('createGpuDrivenOwner(');
  });

  it('requires the prepared Standard PBR production owner', () => {
    expect(productionRaster).not.toContain('GPU_DRIVEN_STANDARD_PBR_WGSL');
    expect(productionRaster).not.toContain('class GpuDrivenPbrRaster');
    expect(productionRaster).toContain('MaterialAbiRasterAdapter');
    expect(productionRasterMaterial).toContain('deriveVertexBufferLayoutFromProjection');
    expect(productionRasterMaterial).toContain('vertexLayout.arrayStride');
  });

  it('keeps CPU-only video slots out of the global GPU receipt gate', () => {
    expect(mainPass).toContain('videoTextureFields?.size');
    expect(mainPass).toContain('prepareMaterialBinding = (slot)');
    expect(mainPass).not.toContain('for (let materialSlot = 0; materialSlot < materialSlotCount;');
    expect(productionRaster).toMatch(
      /material bind group for global slot \$\{globalMaterialSlot\}/,
    );
  });

  it('keeps probe-bearing rows on the GPU lane with the shared probe buffer', () => {
    expect(frameRecord).toContain(
      'const frameGpuDriven = fallbackLaneLimit ? undefined : gpuDriven;',
    );
    expect(frameRecord).not.toContain('const probeBlendFrame =');
    expect(frameRecord).toContain('frameGpuDriven.scene?.probeBlend');
    expect(frameRecord).toContain('probeBlendRecordBuffer: gpuProbeBlendBuffer');
  });

  it('freezes CPU shadow caster enumeration as the pre-GPU baseline', () => {
    expect(shadowPass).toContain('validatedOrdered');
    expect(shadowPass).toMatch(/for \(let i = 0; i < validatedOrdered\.length; i\+\+\)/);
    expect(shadowPass).toContain('recordShadowCasterDraws');
  });

  it('freezes current ownership and stable-frame inspection signals', () => {
    expect(productionRaster).toContain('selection: filtered.selection');
    expect(productionRaster).not.toContain('ownsAllRenderables');
    expect(rendererSystem).toContain(
      'gpuDriven: gpuDrivenProduction.inspect(skinTasks.paletteUploadBytes)',
    );
    expect(productionRaster).toContain('gpuOwnedSnapshotsMaterialized');
    expect(productionRaster).toContain('validatedGpuOwnedRows');
    expect(productionRaster).toContain('cpuFallbackDrawItems');
  });

  it('keeps the single-query and single-task-owner constraints visible', () => {
    expect(count(extractTail, /read: \[MeshRenderer\]/g)).toBe(1);
    expect(count(rendererSystem, /new RecordingSkinTasks\(/g)).toBe(1);
    expect(count(read('../record/recording-skin-tasks.ts'), /new SkinTasks\(/g)).toBe(1);
    expect(skinTasks).toContain('export class SkinTasks');
    expect(gpuDrivenOwner).toContain('createGpuDrivenOwner');
  });
});
