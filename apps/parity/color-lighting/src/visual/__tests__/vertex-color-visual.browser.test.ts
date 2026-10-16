import { describe, expect, it } from 'vitest';
import { validateVertexColorReadback } from '../../capture/attachment-readback';

describe('vertex-color Browser WebGPU visual lane', () => {
  it('fails closed when a real producer readback is not supplied', () => {
    const result = validateVertexColorReadback({
      backend: 'browser-webgpu',
      frameCount: 0,
      colorDomain: 'displayEncoded',
      source: 'live-producer',
      readback: 'copyTextureToBuffer',
      finalBytes: new Uint8Array(),
      linearBytes: new Uint8Array(),
      frameId: 0,
      rawHash: '',
    });
    expect(result.ok).toBe(false);
  });
});
