import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { GraphBuffer, RenderGraphFrame } from '../types';

it('allocates only the public Result when admitting imported resources and their pass', () => {
  const graph = new RenderGraphBuilder<RenderGraphFrame>();
  const results: GraphBuffer[] = [];
  const creates = vi.spyOn(Object, 'create');
  try {
    for (let index = 0; index < 1200; index++) {
      results.push(
        graph
          .importBuffer(`mesh-${index}`, { size: 16, usage: 0x0020 }, () => {
            throw new Error('declaration must not resolve imports');
          })
          .unwrap(),
      );
    }
    const resourceResults = creates.mock.results.filter(
      (result) => result.type === 'return' && result.value?.ok === true,
    ).length;
    creates.mockClear();
    graph
      .addComputePass('draw-inputs', {
        accesses: results.map((resource) => ({ resource, usage: 'vertex-read' })),
        encode: () => undefined,
      })
      .unwrap();
    const passResults = creates.mock.results.filter(
      (result) => result.type === 'return' && result.value?.ok === true,
    ).length;
    expect({ resourceResults, passResults }).toEqual({ resourceResults: 1200, passResults: 1 });
  } finally {
    creates.mockRestore();
  }
});

it('does not allocate an intermediate success Result for every compiled resource access', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const build = (count: number) => {
    const graph = new RenderGraphBuilder<RenderGraphFrame>();
    const buffers = Array.from({ length: 128 }, (_, index) =>
      graph
        .importBuffer(`mesh-${index}`, { size: 16, usage: 0x0020 }, () => {
          throw new Error('compilation must not resolve imports');
        })
        .unwrap(),
    );
    graph
      .addComputePass('draw-inputs', {
        accesses: buffers.slice(0, count).map((resource) => ({ resource, usage: 'vertex-read' })),
        encode: () => undefined,
      })
      .unwrap();
    return graph;
  };
  const sparse = build(1);
  const full = build(128);
  const creates = vi.spyOn(Object, 'create');
  let sparseCompiled: ReturnType<typeof sparse.compile> | undefined;
  let fullCompiled: ReturnType<typeof full.compile> | undefined;
  try {
    const successes = () =>
      creates.mock.results.filter((result) => result.type === 'return' && result.value?.ok === true)
        .length;
    sparseCompiled = sparse.compile({ device, surfaceSize: { width: 16, height: 16 } });
    const sparseResults = successes();
    creates.mockClear();
    fullCompiled = full.compile({ device, surfaceSize: { width: 16, height: 16 } });
    const fullResults = successes();
    expect(fullCompiled.unwrap().inspect().passes[0]?.accesses).toHaveLength(128);
    expect(fullResults).toBe(sparseResults);
  } finally {
    creates.mockRestore();
    if (sparseCompiled?.ok) await sparseCompiled.value.retire();
    if (fullCompiled?.ok) await fullCompiled.value.retire();
  }
});
