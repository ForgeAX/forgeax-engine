import { describe, expect, it } from 'vitest';
import { createVertexColorForgeaxProducer } from '../forgeax-adapter';
import { createVertexColorThreeProducer, threeToneMappingId } from '../three-adapter';
import fixtureJson from '../../../cases/vertex-color/vertex-color-vec3.json' with { type: 'json' };
import type { VertexColorCaptureOutput, VertexColorReadbackMethod, VertexColorSemanticFixture } from '../../contracts/types';

describe('Three r184 tone adapter', () => {
  it('uses Three r184 tone mapping IDs for browser output', () => {
    const modes = ['linear', 'reinhard', 'cineon', 'aces-filmic', 'agx', 'neutral'] as const;
    expect(modes.map((mode) => threeToneMappingId(mode))).toEqual([
      1, 2, 3, 4, 6, 7,
    ]);
  });
});

const fixture = fixtureJson as unknown as VertexColorSemanticFixture;

function captureOutput(
  backend: 'browser-webgpu' | 'dawn',
  sourceSha: string,
  readback: VertexColorReadbackMethod,
): VertexColorCaptureOutput {
  return {
    backend,
    frameCount: 60,
    sourceSha,
    sourceFixtureHash: '5e5ebc820d7db4904d11604c0ba00961ec4b1542bd4937d826eb781ed115c140',
    colorDomain: fixture.colorDomain,
    samples: fixture.samplePoints.map((sample) => ({ id: sample.id, coordinate: sample.coordinate, rgba: [0.2, 0.4, 0.8, 1] })),
    linear: [0.2, 0.4, 0.8, 1],
    final: [51, 102, 204, 255],
    readback,
  };
}

describe('independent vertex-color producers', () => {
  it('keeps ForgeaX and Three r184 identities and captures separate', async () => {
    const forgeax = createVertexColorForgeaxProducer(
      async (_fixture, backend) => captureOutput(backend, 'engine-sha', 'copyTextureToBuffer'),
      'engine-sha',
    );
    const three = createVertexColorThreeProducer(
      async (_fixture, backend) => captureOutput(backend, 'three-source', 'readRenderTargetPixelsAsync'),
    );
    const [forgeaxOutput, threeOutput] = await Promise.all([
      forgeax.capture(fixture, 'browser-webgpu'),
      three.capture(fixture, 'browser-webgpu'),
    ]);
    expect(forgeax.identity.implementation).toBe('forgeax');
    expect(three.identity).toMatchObject({ implementation: 'three', version: 'r184', renderer: 'webgpu' });
    expect(forgeaxOutput).not.toBe(threeOutput);
    expect(forgeaxOutput.final).not.toBe(threeOutput.final);
  });
});
