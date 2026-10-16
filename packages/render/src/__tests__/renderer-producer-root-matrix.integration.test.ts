import { describe, expect, it } from 'vitest';
import { createRendererProducerRootMatrix } from '../render-system';

describe('renderer producer root matrix', () => {
  it('enumerates the current baseline resource families with one owner each', () => {
    const matrix = createRendererProducerRootMatrix();

    expect(matrix.map((root) => root.kind)).toEqual([
      'backend-surface',
      'shader-material-pipeline',
      'mesh-texture-sampler',
      'render-scene',
      'gpu-driven',
      'feature',
      'external-source',
      'render-graph',
      'target-history',
      'observation-lease',
    ]);
    expect(new Set(matrix.map((root) => root.owner)).size).toBe(matrix.length);
    expect(matrix.every((root) => root.candidateScope === 'device-scope')).toBe(true);
  });

  it('separates visible roots from lazy non-visible work', () => {
    const matrix = createRendererProducerRootMatrix();
    const visible = matrix.filter((root) => root.visibility === 'visible-workset');
    const lazy = matrix.filter((root) => root.visibility === 'non-visible-lazy');

    expect(visible.length).toBeGreaterThan(0);
    expect(lazy.length).toBeGreaterThan(0);
    expect(lazy.every((root) => root.disabledWork === 'zero')).toBe(true);
  });
});
