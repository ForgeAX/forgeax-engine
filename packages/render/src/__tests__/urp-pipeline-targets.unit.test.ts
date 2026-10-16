import { describe, expect, it } from 'vitest';
import { resolveStandardRenderFeatureTargets } from '../features/targets';

function targets(
  tonemap: 'none' | 'aces-filmic',
  antialias: 'none' | 'fxaa' | 'msaa',
  storageBuffer: boolean,
) {
  return resolveStandardRenderFeatureTargets({
    tonemap,
    antialias,
    colorAttachmentFormat: 'bgra8unorm-srgb',
    storageBuffer,
    multisample: true,
  });
}

describe('urp render feature targets', () => {
  it('keeps the storage-buffer no-tonemap no-FXAA path in a linear target', () => {
    expect(targets('none', 'none', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('publishes a float target for no-tonemap FXAA before the OETF boundary', () => {
    expect(targets('none', 'fxaa', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('publishes the MSAA linear-LDR target with the graph sample count', () => {
    expect(targets('none', 'msaa', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 4,
    });
  });

  it('publishes a float target for non-storage-buffer LDR frames', () => {
    expect(targets('none', 'none', false)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('keeps a linear target when MSAA is unavailable on a storage-buffer lane', () => {
    expect(
      resolveStandardRenderFeatureTargets({
        tonemap: 'none',
        antialias: 'msaa',
        colorAttachmentFormat: 'bgra8unorm-srgb',
        storageBuffer: true,
        multisample: false,
      })[0],
    ).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });
});
