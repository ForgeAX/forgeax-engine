import { describe, expect, it } from 'vitest';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import {
  createHdrpBindGroupLayoutDescriptor,
  createHdrpSkinBindGroupLayoutDescriptor,
} from '../pbr-pipeline';

describe('HDRP group(2) mesh visibility contract', () => {
  it('exposes the mesh window to both vertex and fragment stages', () => {
    const descriptor = createHdrpBindGroupLayoutDescriptor();
    const mesh = descriptor.entries?.find((entry) => entry.binding === 0);
    expect(mesh?.visibility).toBe(GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT);
  });

  it('keeps skin palettes vertex-only while sharing mesh visibility', () => {
    const descriptor = createHdrpSkinBindGroupLayoutDescriptor();
    const mesh = descriptor.entries?.find((entry) => entry.binding === 0);
    const currentPalette = descriptor.entries?.find((entry) => entry.binding === 1);
    const previousPalette = descriptor.entries?.find((entry) => entry.binding === 2);
    expect(mesh?.visibility).toBe(GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT);
    expect(currentPalette?.visibility).toBe(GPU_SHADER_STAGE_VERTEX);
    expect(previousPalette?.visibility).toBe(GPU_SHADER_STAGE_VERTEX);
  });
});
