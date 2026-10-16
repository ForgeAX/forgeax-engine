import { describe, expect, it } from 'vitest';
import type { ForgeaxSurfaceEvidence } from '../adapters/forgeax-adapter';
import { buildFallbackSurfaceContract } from '../fallback-surface-contract';

const proof = {
  descriptor: true,
  acquisition: true,
  validation: true,
  surfaceIdentity: 'surface-1',
  requested: {
    format: 'rgba8unorm',
    usage: 16,
    width: 2,
    height: 2,
    alphaMode: 'opaque',
    presentMode: 'fifo',
  },
  validated: {
    format: 'rgba8unorm',
    usage: 16,
    width: 2,
    height: 2,
    alphaMode: 'opaque',
    presentMode: 'fifo',
  },
} as const;

function evidence(overrides: Partial<ForgeaxSurfaceEvidence> = {}): ForgeaxSurfaceEvidence {
  return {
    captureIdentity: 'chromium-webgl2:case-1:surface-1:output-transform:frame-2:2:' + 'a'.repeat(64),
    actualBackendKind: 'wgpu-webgl2',
    surface: {
      storageFormat: 'rgba8unorm',
      displayFormat: 'rgba8unorm',
      displayEncoded: true,
      endpoint: 'surface.storage.raw',
      capability: 'surface-raw-endpoint',
    },
    presentationProof: proof,
    pixelReadbackEvidence: {
      surfaceIdentity: 'chromium-webgl2:case-1:surface-1:output-transform:frame-2:2:' + 'a'.repeat(64),
      observationId: 'output-transform:frame-2',
      frameId: 2,
      width: 2,
      height: 2,
      byteLength: 16,
      rawHash: 'a'.repeat(64),
      status: 'present',
      source: {
        endpoint: 'surface.display.final',
        method: 'chromium-compositor-rgba8',
      },
    },
    ...overrides,
  };
}

function input(surfaceEvidence: ForgeaxSurfaceEvidence | undefined = evidence(), passed = true, caseId = 'case-1') {
  return {
    caseId,
    passed,
    expectedWidth: 2,
    expectedHeight: 2,
    ...(surfaceEvidence === undefined ? {} : { surfaceEvidence }),
  } as const;
}

describe('fallback surface contract', () => {
  it('passes only when each case has matching presentation and pixel proof', () => {
    const result = buildFallbackSurfaceContract('chromium-webgl2', [input()]);
    expect(result.status).toBe('pass');
    expect(result.cases[0]?.status).toBe('pass');
  });

  it('accepts the wgpu Rust enum spelling at the proof boundary', () => {
    const rustProof = {
      ...proof,
      requested: { ...proof.requested, format: 'Rgba8Unorm' },
      validated: { ...proof.validated, format: 'Rgba8Unorm' },
    };
    const result = buildFallbackSurfaceContract(
      'webkit-webgl2',
      [
        input({
          ...evidence({ presentationProof: rustProof }),
          pixelReadbackEvidence: {
            ...evidence().pixelReadbackEvidence,
            surfaceIdentity: 'webkit-webgl2:case-1:surface-1:output-transform:frame-2:2:' + 'a'.repeat(64),
            source: { endpoint: 'surface.display.final', method: 'webkit-compositor-rgba8' },
          },
          captureIdentity: 'webkit-webgl2:case-1:surface-1:output-transform:frame-2:2:' + 'a'.repeat(64),
        }),
      ],
    );
    expect(result.status).toBe('pass');
    expect(result.cases[0]?.status).toBe('pass');
  });

  it('fails a single parity case even when its bytes are present', () => {
    const result = buildFallbackSurfaceContract('chromium-webgl2', [input(evidence(), false)]);
    expect(result.status).toBe('failed');
    expect(result.cases[0]?.missing).toContain('case');
  });

  it('fails closed when configure-time proof is partial', () => {
    const partial = evidence({ presentationProof: { ...proof, acquisition: false } });
    const result = buildFallbackSurfaceContract('chromium-webgl2', [input(partial)]);
    expect(result.status).toBe('failed');
    expect(result.cases[0]?.missing).toContain('presentationProof');
  });

  it('fails closed when the final surface is not display encoded', () => {
    const result = buildFallbackSurfaceContract(
      'chromium-webgl2',
      [input(evidence({ surface: { ...evidence().surface, displayEncoded: false } }))],
    );
    expect(result.status).toBe('failed');
    expect(result.cases[0]?.missing).toContain('presentationProof');
  });

  it('rejects a non-WebGL2 backend identity', () => {
    const result = buildFallbackSurfaceContract('chromium-webgl2', [input(evidence({ actualBackendKind: 'webgpu' }))]);
    expect(result.cases[0]?.missing).toContain('actualBackendKind');
    expect(result.status).toBe('failed');
  });

  it('rejects truncated pixels and mismatched surface identity', () => {
    const truncated = evidence({
      pixelReadbackEvidence: {
        ...evidence().pixelReadbackEvidence,
        byteLength: 12,
        status: 'empty',
      },
    });
    const identityMismatch = evidence({
      pixelReadbackEvidence: {
        ...evidence().pixelReadbackEvidence,
        surfaceIdentity: 'surface-2',
      },
    });
    const result = buildFallbackSurfaceContract('chromium-webgl2', [input(truncated, true, 'truncated'), input(identityMismatch, true, 'identity')]);
    expect(result.cases[0]?.missing).toContain('pixelReadbackEvidence.byteLength');
    expect(result.cases[1]?.missing).toContain('pixelReadbackEvidence.surfaceIdentity');
    expect(result.status).toBe('failed');
  });

  it('does not allow a transparency capture to reuse a sentinel capture identity', () => {
    const reused = evidence();
    const result = buildFallbackSurfaceContract('chromium-webgl2', [input(reused, true, 'sentinel'), input(reused, true, 'transparent')]);
    expect(result.status).toBe('failed');
    expect(result.cases[1]?.missing).toContain('captureIdentity.unique');
  });
});
