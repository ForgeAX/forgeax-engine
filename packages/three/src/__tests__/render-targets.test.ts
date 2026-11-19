import type { RenderTarget as NativeTarget, Renderer } from '@forgeax/engine-render';
import CubeRenderTarget from 'three/src/renderers/common/CubeRenderTarget.js';
import { HalfFloatType, LinearMipmapLinearFilter, RenderTarget } from 'three/src/Three.Core.js';
import { describe, expect, it, vi } from 'vitest';
import { RenderTargets, targetDescriptor } from '../render-targets';
import { textureCoordinates } from '../texture';

function fixture() {
  let id = 0;
  const renderer = {
    createRenderTarget: vi.fn(() => ({ ok: true, value: { id: ++id } as unknown as NativeTarget })),
    resizeRenderTarget: vi.fn(() => ({ ok: true, value: undefined })),
    createRenderTargetTextureSource: vi.fn(() => ({
      ok: true,
      value: { kind: 'render-texture-source', source: 'target', id: ++id, owner: 'fixture' },
    })),
    prepareRenderTargetEnvironment: vi.fn(async () => ({
      ok: true,
      value: {
        source: { kind: 'render-target-environment' },
        release: () => ({ ok: true, value: undefined }),
      },
    })),
    destroyRenderTarget: vi.fn(() => ({ ok: true, value: undefined })),
  };
  return { renderer, targets: new RenderTargets(renderer as unknown as Renderer) };
}

describe('Three native target leases', () => {
  it('resolves CubeRenderTarget texture ownership through the admitted projection', async () => {
    const { renderer, targets } = fixture();
    const cube = new CubeRenderTarget(8, { type: HalfFloatType });
    expect(cube.texture.renderTarget).toBeNull();
    targets.target(cube);
    await targets.prepareEnvironment(cube.texture);
    expect(renderer.prepareRenderTargetEnvironment).toHaveBeenCalledTimes(1);
    expect(targets.environment(cube.texture)).toMatchObject({ kind: 'render-target-environment' });
    targets.dispose();
  });
  it('flips target UVs after the authored transform as r187 WebGPU does', () => {
    const target = new RenderTarget(16, 16);
    target.texture.offset.set(0.2, 0.3);
    target.texture.repeat.set(2, 3);
    const coordinates = textureCoordinates(target.texture).unwrap();
    expect(coordinates.transform.offset).toEqual([0.2, 0.7]);
    expect(coordinates.transform.scale).toEqual([2, -3]);
  });
  it('retains one native target and source until source disposal, then readmits', () => {
    const { renderer, targets } = fixture();
    const target = new RenderTarget(16, 8, { type: HalfFloatType, samples: 4 });
    const native = targets.target(target);
    expect(targetDescriptor(target)).toMatchObject({
      format: 'rgba16float',
      sampleCount: 4,
      shape: '2d',
    });
    expect(() => targets.binding(target.texture)).toThrow(/explicit write/);
    targets.submitted(target);
    const binding = targets.binding(target.texture);
    expect(targets.target(target)).toBe(native);
    expect(targets.binding(target.texture)).toBe(binding);
    expect(renderer.createRenderTarget).toHaveBeenCalledTimes(1);
    target.setSize(32, 16);
    expect(renderer.destroyRenderTarget).toHaveBeenCalledTimes(1);
    expect(targets.target(target)).not.toBe(native);
    expect(() => targets.binding(target.texture)).toThrow(/explicit write/);
    targets.dispose();
    expect(renderer.destroyRenderTarget).toHaveBeenCalledTimes(2);
  });
  it('rejects mip-filtered target maps rather than sampling an incomplete view', () => {
    const { targets } = fixture();
    const target = new RenderTarget(8, 8);
    targets.target(target);
    targets.submitted(target);
    target.texture.minFilter = LinearMipmapLinearFilter;
    expect(() => targets.binding(target.texture)).toThrow(/non-mip filter/);
    targets.dispose();
  });
  it('rejects unsupported attachments and automatic mips instead of omitting them', () => {
    const target = new RenderTarget(8, 8, { count: 2 });
    expect(() => targetDescriptor(target)).toThrow(/one RGBA/);
    const mip = new RenderTarget(8, 8, { generateMipmaps: true });
    expect(() => targetDescriptor(mip)).toThrow(/automatic mip/);
  });
});
