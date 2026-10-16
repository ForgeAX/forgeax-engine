import { describe, expect, it } from 'vitest';
import { MaterialHmrGraph } from '../hmr.js';

describe('MaterialHmrGraph', () => {
  it('replaces an importers dependency set instead of retaining stale edges', () => {
    const graph = new MaterialHmrGraph();

    graph.record('/shaders/material.wgsl', ['/shaders/common.wgsl']);
    graph.replace('/shaders/material.wgsl', ['/shaders/brdf.wgsl']);

    expect(graph.collect('/shaders/common.wgsl')).toEqual([]);
    expect(graph.collect('/shaders/brdf.wgsl')).toEqual(['/shaders/material.wgsl']);
  });
});
