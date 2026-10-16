import { describe, expect, it } from 'vitest';
import { deriveRenderExtent, renderExtentSize } from '../pipeline/render-extent';

describe('RenderExtent', () => {
  it('keeps output and internal domains distinct at a fixed TAAU scale', () => {
    const extent = deriveRenderExtent({
      outputWidth: 1920,
      outputHeight: 1080,
      requestedScale: 0.67,
      generation: 4,
    });

    expect(extent).toMatchObject({
      outputWidth: 1920,
      outputHeight: 1080,
      internalWidth: 1256,
      internalHeight: 704,
      scale: 0.65625,
      generation: 4,
    });
    expect(renderExtentSize(extent, 'internal')).toEqual({ width: 1256, height: 704 });
    expect(renderExtentSize(extent, 'output')).toEqual({ width: 1920, height: 1080 });
  });

  it('keeps a non-8-aligned output domain exact while fixed TAAU aligns only its internal domain', () => {
    const extent = deriveRenderExtent({
      outputWidth: 200,
      outputHeight: 150,
      requestedScale: 0.67,
      generation: 2,
    });

    expect(renderExtentSize(extent, 'output')).toEqual({ width: 200, height: 150 });
    expect(renderExtentSize(extent, 'internal')).toEqual({ width: 128, height: 96 });
    expect(extent.outputWidth).not.toBe(extent.internalWidth);
    expect(extent.outputHeight).not.toBe(extent.internalHeight);
  });

  it('keeps tiny surfaces native', () => {
    const extent = deriveRenderExtent({
      outputWidth: 7,
      outputHeight: 5,
      requestedScale: 0.5,
      generation: 9,
    });

    expect(extent.internalWidth).toBe(7);
    expect(extent.internalHeight).toBe(5);
    expect(extent.scale).toBe(1);
  });
});
