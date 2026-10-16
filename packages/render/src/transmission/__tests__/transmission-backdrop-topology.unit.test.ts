import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import {
  addTransmissionBackdropPasses,
  resolveTransmissionBackdropTopology,
  type TransmissionBackdropTopologyInput,
} from '../backdrop';

function topology(
  overrides: Partial<TransmissionBackdropTopologyInput> = {},
): TransmissionBackdropTopologyInput {
  return {
    demand: { activeCount: 1, needsRoughMips: false },
    sourceSampleCount: 1,
    ...overrides,
  };
}

describe('TransmissionBackdrop typed topology', () => {
  it('keeps the demand-off path exact zero', () => {
    expect(
      resolveTransmissionBackdropTopology({
        demand: { activeCount: 0, needsRoughMips: false },
        sourceSampleCount: 4,
      }),
    ).toEqual({
      active: false,
      sourceSampleCount: 4,
      copyCount: 0,
      mipCount: 0,
      submitCount: 1,
      aliasCount: 0,
      phases: [],
    });
  });

  it('places one resolved copy before transmission and ordinary transparent work', () => {
    expect(resolveTransmissionBackdropTopology(topology()).phases).toEqual([
      'opaque-resolve',
      'transmission-backdrop-copy',
      'transmission-forward',
      'transparent',
      'temporal',
    ]);
    expect(resolveTransmissionBackdropTopology(topology())).toMatchObject({
      active: true,
      copyCount: 1,
      mipCount: 0,
    });
  });

  it('adds only shared raster mip work for rough transmission', () => {
    expect(
      resolveTransmissionBackdropTopology(
        topology({ demand: { activeCount: 2, needsRoughMips: true } }),
      ),
    ).toMatchObject({
      active: true,
      copyCount: 1,
      mipCount: 1,
      phases: [
        'opaque-resolve',
        'transmission-backdrop-copy',
        'transmission-backdrop-mip',
        'transmission-forward',
        'transparent',
        'temporal',
      ],
    });
  });

  it('never creates a second submission or aliases the backdrop source', () => {
    const result = resolveTransmissionBackdropTopology(topology({ sourceSampleCount: 4 }));

    expect(result).toMatchObject({ sourceSampleCount: 4, submitCount: 1, aliasCount: 0 });
  });

  it('rejects rough mips without a renderer-owned sampling encoder', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const source = createRenderPipelineTarget(graph, 'opaque-resolved', {
      format: 'rgba16float',
      size: 'surface',
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = addTransmissionBackdropPasses({
      graph,
      source: source.value,
      demand: { activeCount: 1, needsRoughMips: true },
      copySize: { width: 8, height: 4 },
      surfaceSize: { width: 8, height: 4 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'resource-descriptor-invalid',
      detail: {
        resourceLabel: 'transmission-backdrop',
        field: 'roughMipEncoder',
        actual: 'missing',
      },
    });
    expect(result.error.expected).toContain('fullscreen/downsample owner');
    expect(result.error.hint).toContain('encodeRoughMip');
  });
});
