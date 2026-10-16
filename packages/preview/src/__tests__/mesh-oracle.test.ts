import { describe, expect, it } from 'vitest';
import { evaluateMeshOracle, type MeshOracleInput } from '../evidence/oracle.js';

const meshFacts = (overrides: Partial<MeshOracleInput> = {}): MeshOracleInput => ({
  requested: {
    subjectDigest: 'sha256:mesh',
    vertexDigest: 'sha256:vertices',
    indexDigest: 'sha256:indices',
    submeshDigest: 'sha256:submeshes',
    aabbDigest: 'sha256:aabb',
  },
  observed: {
    subjectDigest: 'sha256:mesh',
    vertexDigest: 'sha256:vertices',
    indexDigest: 'sha256:indices',
    submeshDigest: 'sha256:submeshes',
    aabbDigest: 'sha256:aabb',
    rendererHealthy: true,
    drawCalls: 2,
    nonBlackPixels: 100,
  },
  ...overrides,
});

describe('mesh preview oracle', () => {
  it('requires vertex, index, every submesh, AABB, and renderer facts together', () => {
    expect(evaluateMeshOracle(meshFacts())).toMatchObject({ status: 'passed', subjectBound: true });
  });

  it.each([
    [
      'vertex buffer replacement',
      { observed: { ...meshFacts().observed, vertexDigest: 'sha256:other' } },
    ],
    [
      'index buffer replacement',
      { observed: { ...meshFacts().observed, indexDigest: 'sha256:other' } },
    ],
    ['missing submesh', { observed: { ...meshFacts().observed, submeshDigest: 'sha256:missing' } }],
    ['wrong bounds framing', { observed: { ...meshFacts().observed, aabbDigest: 'sha256:other' } }],
  ])('rejects %s instead of accepting draw/nonBlackPixels alone', (_label, override) => {
    expect(evaluateMeshOracle(meshFacts(override))).toMatchObject({ status: 'failed' });
  });

  it('rejects a bright sky frame without a bound mesh subject', () => {
    expect(
      evaluateMeshOracle(
        meshFacts({ observed: { ...meshFacts().observed, subjectDigest: 'sha256:sky' } }),
      ),
    ).toMatchObject({ status: 'failed' });
  });
});
