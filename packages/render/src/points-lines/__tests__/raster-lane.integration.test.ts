import { describe, expect, it } from 'vitest';
import { createPointsLinesLaneContract, type PointsLinesLane } from '../record';

const lanes: readonly PointsLinesLane[] = ['direct', 'clustered', 'cpu-webgl2'];

describe('Points/Lines raster lane integration contract', () => {
  it.each(lanes)('%s consumes one unlit material and the existing graph', (lane) => {
    const contract = createPointsLinesLaneContract(lane, 'webgpu');

    expect(contract.lane).toBe(lane);
    expect(contract.material.shadingModel).toBe('unlit');
    expect(contract.material.source).toBe('MaterialAsset');
    expect(contract.graph.additionalAttachments).toBe(0);
    expect(contract.graph.additionalPasses).toBe(0);
    expect(contract.shadowDrawCount).toBe(0);
  });

  it('keeps clustered points and lines on the unlit route', () => {
    const contract = createPointsLinesLaneContract('clustered', 'webgpu');

    expect(contract.material.shadingModel).toBe('unlit');
    expect(contract.material.clusteredLighting).toBe(false);
    expect(contract.material.lit).toBe(false);
  });

  it('does not request compute, storage, or indirect features on CPU-WebGL2', () => {
    const contract = createPointsLinesLaneContract('cpu-webgl2', 'wgpu-webgl2');

    expect(contract.capabilities.compute).toBe(false);
    expect(contract.capabilities.storage).toBe(false);
    expect(contract.capabilities.indirect).toBe(false);
    expect(contract.graph.additionalAttachments).toBe(0);
    expect(contract.graph.additionalPasses).toBe(0);
  });

  it('labels RhiNull as structural-only and keeps the same authoring contract', () => {
    const contract = createPointsLinesLaneContract('direct', 'null');

    expect(contract.evidence).toBe('structural-only');
    expect(contract.authoring).toBe('shared');
    expect(contract.graph.additionalAttachments).toBe(0);
    expect(contract.graph.additionalPasses).toBe(0);
  });
});
