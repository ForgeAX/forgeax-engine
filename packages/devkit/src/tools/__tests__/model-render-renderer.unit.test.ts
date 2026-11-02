import { describe, expect, it } from 'vitest';
import { isSoftwareAdapter } from '../model-render.js';

const info = (description: string, vendor = '', device = '', architecture = '') => ({
  vendor,
  architecture,
  device,
  description,
});

describe('isSoftwareAdapter', () => {
  it('is true for a Lavapipe adapter', () => {
    expect(
      isSoftwareAdapter(info('llvmpipe (LLVM 15.0.7, 256 bits)', 'mesa', 'llvmpipe', 'lavapipe')),
    ).toBe(true);
    expect(isSoftwareAdapter(info('Mesa Lavapipe 23.2.1 (software rasterizer)'))).toBe(true);
    expect(isSoftwareAdapter(info('', '', 'LLVMPIPE'))).toBe(true);
  });

  it('is true for a SwiftShader adapter', () => {
    expect(isSoftwareAdapter(info('SwiftShader Device (Subzero)', 'google', 'swiftshader'))).toBe(
      true,
    );
    expect(isSoftwareAdapter(info('Google SwiftShader'))).toBe(true);
  });

  it('is false for a real GPU, including one from the same vendor family', () => {
    expect(isSoftwareAdapter(info('NVIDIA GeForce RTX 4090', 'nvidia', 'ada', 'ad102'))).toBe(
      false,
    );
    expect(isSoftwareAdapter(info('Apple M2 Pro', 'apple', 'metal', 'apple-gpu'))).toBe(false);
    expect(isSoftwareAdapter(info('Intel(R) UHD Graphics 630', 'intel', 'gen-9'))).toBe(false);
    expect(isSoftwareAdapter(info('', 'google'))).toBe(false);
  });
});
