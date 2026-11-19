import { expect, it } from 'vitest';
import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import {
  buffer,
  compute,
  program,
  read,
  storage,
  texture,
  view,
  write,
} from '../water/advanced-graph';
import { DISPERSIVE_QUERY_SHADER } from '../water/dispersive-ocean-shader';
import { dispersiveGpuFixture } from './dispersive-ocean-gpu.fixture';

it('reads exact wrapped original residual cells into one native r32float query tile', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const source = texture('query-source', 8, 8, 'rgba32float', 'query-source');
    if (source.kind !== 'graph-texture') throw new Error('Expected source texture');
    const resources: RenderFeatureResourceDeclaration[] = [
      {
        ...source,
        descriptor: {
          ...source.descriptor,
          usage: (source.descriptor.usage ?? 0) | GPUTextureUsage.COPY_DST,
        },
      },
      view('query-source-view', 'query-source'),
      texture('query-tile', 3, 4, 'r32float', 'query-tile'),
      view('query-tile-view', 'query-tile'),
      buffer('query-params', new Float32Array([7, 7, 8, 0, 3, 2, 0, 0])),
      program('query-program', DISPERSIVE_QUERY_SHADER, 'sampleQuery', [
        read(0),
        write(1, 'r32float'),
        storage(2),
      ]),
    ];
    await gpu.run(resources, []);
    const values = new Float32Array(8 * 8 * 4);
    for (let z = 0; z < 8; z++)
      for (let x = 0; x < 8; x++) values[(z * 8 + x) * 4] = (z * 8 + x - 32) / 16;
    gpu.write('query-source', values);
    const passes: RenderFeaturePassDeclaration[] = [];
    compute(
      resources,
      passes,
      'query-sample',
      'query-program',
      'sampleQuery',
      [
        { binding: 0, resource: 'query-source-view' },
        { binding: 1, resource: 'query-tile-view' },
        { binding: 2, resource: 'query-params' },
      ],
      3,
      2,
    );
    await gpu.run(resources, passes);
    expect(Array.from(await gpu.read('query-tile')).slice(0, 6)).toEqual([
      31 / 16,
      24 / 16,
      25 / 16,
      -25 / 16,
      -32 / 16,
      -31 / 16,
    ]);
    await gpu.run(
      resources.map((row) =>
        row.kind === 'buffer' && row.name === 'query-params'
          ? { ...row, data: new Float32Array([0, 4, 8, 2, 3, 2, 0, 0]) }
          : row,
      ),
      passes,
    );
    expect(Array.from(await gpu.read('query-tile'))).toEqual([
      31 / 16,
      24 / 16,
      25 / 16,
      -25 / 16,
      -32 / 16,
      -31 / 16,
      0,
      1 / 16,
      2 / 16,
      8 / 16,
      9 / 16,
      10 / 16,
    ]);
  } finally {
    gpu.dispose();
  }
});
