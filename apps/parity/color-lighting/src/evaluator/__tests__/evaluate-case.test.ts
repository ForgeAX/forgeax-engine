import { describe, expect, it } from 'vitest';
import { evaluateCase } from '../evaluate-case';
import { createVertexColorNamedCapture } from '../../capture/named-capture';
import fixtureJson from '../../../cases/vertex-color/vertex-color-vec3.json' with { type: 'json' };
import { evaluateVertexColorCase } from '../evaluate-case';
import type { VertexColorCaptureOutput, VertexColorReadbackMethod, VertexColorSemanticFixture } from '../../contracts/types';

const base = {
  caseId: 'm0-evaluator',
  required: true,
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
  forgeax: { implementation: 'forgeax', version: 'dev' },
  three: { implementation: 'three', version: 'r184', renderer: 'webgpu' },
};

describe('per-case evaluator', () => {
  it('fails aggregate-only input', () => {
    const result = evaluateCase({ ...base, aggregateDiff: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected aggregate-only failure');
    expect(result.error.code).toBe('aggregate-only-input');
  });

  it('fails a single byte over budget and reports first divergence', () => {
    const result = evaluateCase({
      ...base,
      analytic: { max: 0 },
      roi: { max: 0 },
      bytes: { differing: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.value?.verdict).toBe('failed');
    expect(result.value?.firstDivergence).toBeDefined();
  });

  it('keeps WebGL2 byte drift diagnostic while enforcing numeric bounds', () => {
    const result = evaluateCase({
      ...base,
      three: { ...base.three, renderer: 'webgl' },
      allowThreeWebglFallback: true,
      captures: {
        forgeax: { linear: [], final: [], hash: 'forgeax' },
        three: { linear: [], final: [], hash: 'three' },
      },
      analytic: { max: 0.01 },
      roi: { max: 0.01 },
      bytes: { differing: 4096 },
    });
    expect(result.ok).toBe(true);
    expect(result.value?.metrics.differingBytes).toBe(4096);
  });

  it('rejects non-finite metrics and unjustified wide budgets', () => {
    expect(evaluateCase({ ...base, analytic: { max: Number.NaN }, roi: { max: 0 }, bytes: { differing: 0 } }).ok).toBe(false);
    expect(evaluateCase({ ...base, budget: { analyticMax: 999999, roiMax: 0, byteMax: 0 }, analytic: { max: 0 }, roi: { max: 0 }, bytes: { differing: 0 } }).ok).toBe(false);
  });
});

const vertexFixture = fixtureJson as unknown as VertexColorSemanticFixture;
const vertexHash = '5e5ebc820d7db4904d11604c0ba00961ec4b1542bd4937d826eb781ed115c140';

function vertexOutput(
  sourceSha: string,
  sampleColor: readonly [number, number, number, number],
  readback: VertexColorReadbackMethod = 'copyTextureToBuffer',
): VertexColorCaptureOutput {
  return {
    backend: 'browser-webgpu',
    frameCount: 60,
    sourceSha,
    sourceFixtureHash: vertexHash,
    colorDomain: 'displayEncoded',
    samples: vertexFixture.samplePoints.map((sample) => ({ id: sample.id, coordinate: sample.coordinate, rgba: sampleColor })),
    linear: [0.2, 0.4, 0.8, 1],
    final: [51, 102, 204, 255],
    readback,
  };
}

describe('independent vertex-color evaluator', () => {
  it('requires independent producers, 60 frames, named samples, and a red white falsifier', async () => {
    const sourceSha = 'engine-source-sha';
    const forgeaxIdentity = { implementation: 'forgeax' as const, version: 'workspace', renderer: 'webgpu' as const, adapterId: 'forgeax-vertex-color-webgpu', pinnedCommit: sourceSha, buildIdentity: 'forgeax-build' };
    const threeIdentity = { implementation: 'three' as const, version: 'r184', renderer: 'webgpu' as const, adapterId: 'three-r184-vertex-color-webgpu', pinnedCommit: 'three-source', buildIdentity: 'three-build' };
    const forgeax = await createVertexColorNamedCapture(vertexFixture, forgeaxIdentity, vertexOutput(sourceSha, [0.2, 0.4, 0.8, 1]));
    const three = await createVertexColorNamedCapture(
      vertexFixture,
      threeIdentity,
      vertexOutput(sourceSha, [0.21, 0.4, 0.8, 1], 'readRenderTargetPixelsAsync'),
    );
    const result = evaluateVertexColorCase({
      caseId: 'vertex-color-vec3',
      fixture: vertexFixture,
      invocationId: 'm5-evaluator',
      backend: 'browser-webgpu',
      sourceSha,
      expectedSamples: vertexFixture.samplePoints.map((sample) => ({ id: sample.id, coordinate: sample.coordinate, rgba: [0.2, 0.4, 0.8, 1] as const })),
      forgeax,
      three,
      falsifier: { kind: 'white-color', samples: vertexFixture.samplePoints.map((sample) => ({ id: sample.id, coordinate: sample.coordinate, rgba: [1, 1, 1, 1] as const })) },
      artifacts: ['artifact://m5/forgeax', 'artifact://m5/three'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected independent vertex-color parity to pass');
    expect(result.value.frameCount).toBe(60);
    expect(result.value.falsifier.verdict).toBe('passed');
  });

  it('rejects same producer identity and wrong domain before publishing a report', async () => {
    const sourceSha = 'engine-source-sha';
    const identity = { implementation: 'forgeax' as const, version: 'workspace', renderer: 'webgpu' as const, adapterId: 'same', pinnedCommit: sourceSha, buildIdentity: 'same' };
    const capture = await createVertexColorNamedCapture(vertexFixture, identity, vertexOutput(sourceSha, [0.2, 0.4, 0.8, 1]));
    const result = evaluateVertexColorCase({
      caseId: 'vertex-color-vec3', fixture: vertexFixture, invocationId: 'm5-invalid', backend: 'browser-webgpu', sourceSha,
      expectedSamples: vertexFixture.samplePoints.map((sample) => ({ id: sample.id, coordinate: sample.coordinate, rgba: [0.2, 0.4, 0.8, 1] as const })),
      forgeax: capture, three: capture,
      falsifier: { kind: 'white-color', samples: capture.samples }, artifacts: ['artifact://m5/invalid'],
    });
    expect(result.ok).toBe(false);
  });
});
