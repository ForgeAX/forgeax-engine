import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import { Materials } from '../materials';
import {
  collectMaterialTextureSources,
  materialTextureSourceFields,
} from '../render-system-extract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { CanvasTexture, canvasTextureState } from '../textures/canvas-texture';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 8,
  height: 8,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: false,
};

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function targetSource(host: ReturnType<typeof createRenderTargetHost>) {
  const target = value(host.createRenderTarget(descriptor));
  return {
    target,
    source: value(
      host.createRenderTargetTextureSource(target, {
        aspect: 'color',
        dimension: '2d',
        mipLevel: 0,
      }),
    ),
  };
}

describe('material texture source projection', () => {
  it('reads explicit sources only from declared slots without probing numeric references', () => {
    const host = createRenderTargetHost();
    const { source } = targetSource(host);
    const stats = { sourceFieldsVisited: 0, producerRoutes: {} };
    const values = { roughness: { source }, baseColorTexture: { source }, numeric: 2147483647 };
    const selected = collectMaterialTextureSources(
      values,
      new Set(['baseColorTexture', 'numeric']),
      stats,
    );
    expect([...selected]).toEqual([['baseColorTexture', source]]);
    expect(stats).toEqual({ sourceFieldsVisited: 2, producerRoutes: { target: 1 } });
    expect(
      collectMaterialTextureSources({ texture: 2147483647, nested: { texture: 2147483647 } }).size,
    ).toBe(0);
    host.dispose();
  });

  it('retains a source through asset read, copy and update with one native owner', () => {
    const assets = new AssetRegistry();
    const host = createRenderTargetHost();
    const other = createRenderTargetHost();
    const { target, source } = targetSource(host);
    const material = assets
      .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: { source } }))
      .unwrap();
    const copied = assets.copy(material).unwrap();
    assets.update(copied, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    const read = assets.read(copied).unwrap();
    const clone = collectMaterialTextureSources(read.values ?? {}).get('baseColorTexture');
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    if (clone?.source !== 'target') throw new Error('missing target source');
    expect(host.resolveRenderTargetTextureSource(clone)?.target).toBe(target);
    expect(other.resolveRenderTargetTextureSource(clone)).toBeUndefined();
    value(host.destroyRenderTarget(target));
    expect(host.resolveRenderTargetTextureSource(clone)).toBeUndefined();
    host.dispose();
    other.dispose();
    assets.dispose();
  });

  it('derives source fields from the published parameter schema', () => {
    const fields = materialTextureSourceFields([
      { name: 'roughness', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
      { name: 'normal', type: 'texture2d_array' },
      { name: 'sampler', type: 'sampler' },
    ]);
    expect([...(fields ?? [])]).toEqual(['albedo', 'normal']);
  });

  it('shares one Canvas state across cloned material tokens and retires it explicitly', () => {
    const canvas = { width: 8, height: 8 } as OffscreenCanvas;
    const texture = new CanvasTexture(canvas, { flipY: false });
    const clone = structuredClone(texture.source);
    const first = canvasTextureState(clone);
    expect(first?.canvas).toBe(canvas);
    expect(first?.flipY).toBe(false);
    texture.update();
    expect(canvasTextureState(clone)).toBe(first);
    expect(first?.version).toBe(2);
    expect(canvasTextureState({ ...clone, owner: 'foreign' })).toBeUndefined();
    texture.dispose();
    expect(first?.lifetime.signal.aborted).toBe(true);
    expect(canvasTextureState(clone)).toBeUndefined();
    texture.update();
    expect(first?.version).toBe(2);
    expect(canvas.width).toBe(8);
  });
});
