import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { surfaceLocalRayCases, surfaceLocalRayInputSha256 } from './sdf-surface-local-ray.data';
import {
  assessSurfaceLocalRays,
  surfaceLocalRayInputBytes,
  verifySurfaceLocalRayCase,
} from './sdf-surface-local-ray.fixture';

const caseNamed = (name: string) => {
  const row = surfaceLocalRayCases.find((value) => value.name === name);
  if (!row) throw new Error(`Required authored local-ray case missing: ${name}`);
  return row;
};

describe('canonical forward-certified local rays', () => {
  it('proves exact points, box corners and endpoint differences through the forward equations', () => {
    expect(surfaceLocalRayCases).toHaveLength(35);
    expect(surfaceLocalRayCases.filter((row) => row.expectedValid)).toHaveLength(18);
    expect(surfaceLocalRayCases.filter((row) => !row.expectedValid)).toHaveLength(17);
    for (const row of surfaceLocalRayCases)
      if (row.expectedValid) expect(() => verifySurfaceLocalRayCase(row), row.name).not.toThrow();
  });

  it('retains the independently authored raw-word input stream', () => {
    const bytes = surfaceLocalRayInputBytes();
    expect(bytes.byteLength).toBe(35 * 176);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(surfaceLocalRayInputSha256);
  });

  it('rejects an incorrect canonical expectation and insufficient source-pair certificates', () => {
    const identity = caseNamed('scale-1');
    expect(() =>
      verifySurfaceLocalRayCase({
        ...identity,
        exactOrigin: [['2', '1'], identity.exactOrigin[1], identity.exactOrigin[2]],
      }),
    ).toThrow('forward equation');
    const wide = caseNamed('both-wide-identity'),
      last = wide.exactOriginCorners?.[7];
    if (!last || !wide.exactOriginCorners) throw new Error('Full box-corner control required');
    const corners = [...wide.exactOriginCorners];
    corners[7] = [['99', '1'], last[1], last[2]];
    expect(() => verifySurfaceLocalRayCase({ ...wide, exactOriginCorners: corners })).toThrow(
      'forward equation',
    );
    for (const name of ['k-equals-three', 'translation-residual-nonzero'])
      expect(() =>
        verifySurfaceLocalRayCase({
          ...caseNamed(name),
          certificate: [0, 0],
        }),
      ).toThrow('Certificate');
  });

  it('detects a position-residual direction expansion even when the interval encloses the truth', () => {
    const row = caseNamed('direction-does-not-use-position-residual');
    const output = new Uint32Array(20);
    output[3] = 1;
    output[8] = 0x3f800000;
    output[12] = 0x3f800000;
    output.set(row.range, 16);
    expect(assessSurfaceLocalRays(output, [row]).failures).toEqual([]);
    output[8] = 0;
    output[12] = 0x40000000;
    expect(assessSurfaceLocalRays(output, [row]).failures).toEqual([
      `${row.name}: position residual was added to direction`,
    ]);
  });
});
