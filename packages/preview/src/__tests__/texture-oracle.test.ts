import { describe, expect, it } from 'vitest';
import { evaluateTextureOracle, type TextureOracleInput } from '../evidence/oracle.js';

const textureFacts = (overrides: Partial<TextureOracleInput> = {}): TextureOracleInput => ({
  requested: {
    subjectDigest: 'sha256:texture',
    boundDigest: 'sha256:bound',
    dimensions: [4, 2],
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    mipCount: 1,
    uvDigest: 'sha256:uv',
    filter: 'linear',
    bindingDigest: 'sha256:binding',
  },
  observed: {
    subjectDigest: 'sha256:texture',
    boundDigest: 'sha256:bound',
    dimensions: [4, 2],
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    mipCount: 1,
    uvDigest: 'sha256:uv',
    filter: 'linear',
    bindingDigest: 'sha256:binding',
    rendererHealthy: true,
    drawCalls: 1,
    nonBlackPixels: 0,
    payloadClass: 'black',
  },
  ...overrides,
});

describe('Texture preview oracle', () => {
  it('accepts valid black, transparent, and single-channel payloads without a brightness gate', () => {
    for (const payloadClass of ['black', 'transparent', 'single-channel'] as const) {
      expect(
        evaluateTextureOracle(
          textureFacts({ observed: { ...textureFacts().observed, payloadClass } }),
        ),
      ).toMatchObject({
        status: 'passed',
        subjectBound: true,
      });
    }
  });

  it('rejects a wrong texture binding even when the frame is non-black', () => {
    expect(
      evaluateTextureOracle(
        textureFacts({
          observed: {
            ...textureFacts().observed,
            bindingDigest: 'sha256:wrong',
            nonBlackPixels: 100,
          },
        }),
      ),
    ).toMatchObject({ status: 'failed' });
  });

  it('requires dimensions, format, mips, UV, filter, and owner bound facts', () => {
    expect(
      evaluateTextureOracle(
        textureFacts({
          observed: { ...textureFacts().observed, dimensions: [8, 8] },
        }),
      ),
    ).toMatchObject({ status: 'failed' });
  });
});
