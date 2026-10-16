import { describe, expect, it } from 'vitest';
import { RenderGraph } from '@forgeax/engine-render-graph';

const caps = { compute: true, storageBuffer: true } as never;

describe('domain graph integration', () => {
  it('keeps a legal linear HDR path RHI-pure', () => {
    const graph = new RenderGraph();
    graph.addColorTarget('hdr-source', {
      format: 'rgba16float',
      size: { w: 1, h: 1 },
      domain: 'linear-hdr',
    } as never);
    graph.addColorTarget('hdr-destination', {
      format: 'rgba16float',
      size: { w: 1, h: 1 },
      domain: 'linear-hdr',
    } as never);
    graph.addPass('hdr-seed', { reads: [], writes: ['hdr-source'] });
    graph.addPass('hdr-copy', {
      reads: ['hdr-source'],
      writes: ['hdr-destination'],
      colorConnections: [{ source: 'hdr-source', destination: 'hdr-destination' }],
    } as never);

    const result = graph.compile({ backendKind: 'null', caps });
    expect(result.ok).toBe(true);
  });

  it('does not allow a format-only graph to stand in for a domain', () => {
    const graph = new RenderGraph();
    graph.addColorTarget('source', {
      format: 'rgba8unorm',
      size: { w: 1, h: 1 },
    });
    graph.addColorTarget('destination', {
      format: 'rgba8unorm',
      size: { w: 1, h: 1 },
    });
    graph.addPass('source-seed', { reads: [], writes: ['source'] });
    graph.addPass('blend', {
      reads: ['source'],
      writes: ['destination'],
      colorConnections: [{ source: 'source', destination: 'destination' }],
    } as never);

    const result = graph.compile({ backendKind: 'null', caps });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing color domain');
    expect(result.error.code).toBe('missing-color-domain');
  });
});
