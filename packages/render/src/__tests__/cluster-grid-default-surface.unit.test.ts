import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLUSTER_GRID } from '../pipeline/standard-profile';

const ownerSource = readFileSync(
  new URL('../pipeline/standard-profile.ts', import.meta.url),
  'utf8',
);
const layoutSource = readFileSync(
  new URL('../pipeline/standard-lighting/layout.ts', import.meta.url),
  'utf8',
);
const recordSource = readFileSync(new URL('../record/frame-lighting.ts', import.meta.url), 'utf8');

describe('cluster grid default owner', () => {
  it('keeps all record-stage fallbacks on the pipeline owner', () => {
    expect(DEFAULT_CLUSTER_GRID).toEqual({ x: 16, y: 9, z: 24 });
    expect(
      layoutSource.match(/export const DEFAULT_CLUSTER_GRID\s*=\s*\{ x: 16, y: 9, z: 24 \}/g),
    ).toHaveLength(1);
    expect(ownerSource).toMatch(/DEFAULT_CLUSTER_GRID/);
    expect(recordSource.match(/clusterGrid \?\? DEFAULT_CLUSTER_GRID/g)).toHaveLength(1);
    expect(recordSource).not.toMatch(/clusterGrid \?\? \{\s*x: 16,\s*y: 9,\s*z: 24,\s*\}/);
  });

  it('does not advertise the retired four-slot point/spot surface on the clustered path', () => {
    expect(recordSource).not.toContain('warnMultiLightPoint(');
    expect(recordSource).not.toContain('warnMultiLightSpot(');
  });
});
