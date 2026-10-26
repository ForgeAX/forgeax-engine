import { describe, expect, it } from 'vitest';
import type { DevKitAppOptions } from '../../plugin-build.js';
import { normalizePipelineLibrary } from '../pipeline-library-normalize.js';

type Manifest = NonNullable<DevKitAppOptions['pipelineLibrary']>;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
const manifest = (): Manifest => ({
  version: 1,
  backend: 'webgpu',
  shaders: [
    { code: 'shader', label: 'first' },
    { code: 'shader', label: 'alias' },
  ],
  bindGroupLayouts: [
    {
      label: 'first',
      entries: [
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        { binding: 0, visibility: 2, texture: { sampleType: 'float' } },
      ],
    },
    {
      label: 'alias',
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'float' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      ],
    },
  ],
  pipelineLayouts: [[0], [1]],
  renderPipelines: [0, 1].map((index) => ({
    label: `render ${index}`,
    layout: index,
    vertex: {
      module: index,
      entryPoint: 'vs',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      ],
    },
    fragment: { module: index, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  })),
  computePipelines: [0, 1].map((index) => ({
    label: `compute ${index}`,
    layout: index,
    compute: { module: index, entryPoint: 'cs', constants: { count: 4 } },
  })),
});

describe('build-time full pipeline recipe normalization', () => {
  it('folds label/index aliases, reindexes dependencies and preserves first order without mutation', () => {
    const original = manifest(),
      before = structuredClone(original),
      out = normalizePipelineLibrary(original);
    expect(out.shaders).toHaveLength(1);
    expect(out.bindGroupLayouts).toHaveLength(1);
    expect(out.pipelineLayouts).toEqual([[0]]);
    expect(out.renderPipelines).toHaveLength(1);
    expect(out.computePipelines).toHaveLength(1);
    expect(required(out.renderPipelines[0]).label).toBe('render 0');
    expect(required(out.computePipelines[0]).label).toBe('compute 0');
    expect(required(out.renderPipelines[0]).vertex.module).toBe(0);
    expect(required(out.renderPipelines[0]).fragment?.module).toBe(0);
    expect(original).toEqual(before);
    expect(normalizePipelineLibrary(out)).toBe(out);
  });
  it('preserves shader, entry, constants, vertex, attachment, blend, depth, sample and layout distinctions', () => {
    const base = manifest(),
      render = required(base.renderPipelines[0]);
    const fragment = render.fragment;
    if (fragment === undefined) throw new Error('Missing fixture fragment');
    const variants: Manifest['renderPipelines'][number][] = [
      render,
      { ...render, vertex: { ...render.vertex, entryPoint: 'other' } },
      { ...render, vertex: { ...render.vertex, constants: { quality: 1 } } },
      { ...render, vertex: { ...render.vertex, buffers: [] } },
      { ...render, fragment: { ...fragment, targets: [{ format: 'rgba16float' }] } },
      {
        ...render,
        fragment: {
          ...fragment,
          targets: [
            {
              format: 'rgba8unorm',
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'zero' },
              },
            },
          ],
        },
      },
      {
        ...render,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      },
      { ...render, multisample: { count: 4 } },
      { ...render, primitive: { cullMode: 'front' } },
      { ...render, layout: 'auto' },
      { ...render, layout: 2 },
      { ...render, vertex: { ...render.vertex, module: 2 } },
    ];
    const out = normalizePipelineLibrary({
      ...base,
      shaders: [...base.shaders, { code: 'other shader' }],
      bindGroupLayouts: [...base.bindGroupLayouts, { entries: [] }],
      pipelineLayouts: [...base.pipelineLayouts, [2]],
      renderPipelines: variants,
      computePipelines: [
        required(base.computePipelines[0]),
        { ...required(base.computePipelines[0]), compute: { module: 0 } },
        {
          ...required(base.computePipelines[0]),
          compute: { module: 0, entryPoint: 'cs', constants: { count: 8 } },
        },
      ],
    });
    expect(out.renderPipelines).toHaveLength(variants.length);
    expect(out.computePipelines).toHaveLength(3);
  });
  it('folds projected entries but retains every original-source alias for ordinary requests', () => {
    const original: Manifest = {
      ...manifest(),
      shaders: [{ code: 'original A' }, { code: 'original B' }, { code: 'shared closure' }],
      renderPipelines: [],
      computeEntryModules: [
        { module: 0, entryPoint: 'cs', specializedModule: 2 },
        { module: 1, entryPoint: 'cs', specializedModule: 2 },
      ],
    };
    const out = normalizePipelineLibrary(original);
    expect(out.computePipelines).toHaveLength(1);
    expect(out.computeEntryModules).toEqual(original.computeEntryModules);
    expect(out.shaders).toHaveLength(3);
    expect(() =>
      normalizePipelineLibrary({
        ...original,
        computeEntryModules: [
          ...(original.computeEntryModules ?? []),
          { module: 0, entryPoint: 'cs', specializedModule: 1 },
        ],
      }),
    ).toThrow(/Conflicting compute entry projection/);
    expect(() =>
      normalizePipelineLibrary({
        ...original,
        computePipelines: [{ layout: 'auto', compute: { module: 99 } }],
      }),
    ).toThrow(/shader/);
  });
  it('removes startup/background overlap by content while retaining distinct future variants', () => {
    const startup = normalizePipelineLibrary(manifest()),
      background = manifest();
    const distinct = {
      ...required(background.computePipelines[0]),
      compute: { ...required(background.computePipelines[0]).compute, constants: { count: 8 } },
    };
    const out = normalizePipelineLibrary(
      { ...background, computePipelines: [...background.computePipelines, distinct] },
      startup,
    );
    expect(out.renderPipelines).toHaveLength(0);
    expect(out.computePipelines).toHaveLength(1);
    expect(required(out.computePipelines[0]).compute.constants).toEqual({ count: 8 });
  });
  it('omits unused dependencies owned by completed startup, retaining unrelated and alias dependencies', () => {
    const base = manifest();
    const startup = normalizePipelineLibrary(base);
    const background: Manifest = {
      ...base,
      shaders: [...base.shaders, { code: 'future unused' }, { code: 'future used' }],
      bindGroupLayouts: [...base.bindGroupLayouts, { entries: [] }],
      pipelineLayouts: [...base.pipelineLayouts, [2]],
      renderPipelines: [],
      computePipelines: [
        ...base.computePipelines,
        { layout: 2, compute: { module: 3, entryPoint: 'cs' } },
      ],
    };
    const out = normalizePipelineLibrary(background, startup);
    expect(out.shaders.map((s) => s.code)).toEqual(['future unused', 'future used']);
    expect(out.bindGroupLayouts).toEqual([{ entries: [] }]);
    expect(out.pipelineLayouts).toEqual([[0]]);
    expect(out.computePipelines).toEqual([{ layout: 0, compute: { module: 1, entryPoint: 'cs' } }]);
    expect(normalizePipelineLibrary(out, startup)).toBe(out);
    const aliased = normalizePipelineLibrary(
      {
        ...background,
        computeEntryModules: [{ module: 0, entryPoint: 'later', specializedModule: 3 }],
      },
      startup,
    );
    expect(aliased.shaders.map((s) => s.code)).toEqual(['shader', 'future unused', 'future used']);
    expect(aliased.computeEntryModules).toEqual([
      { module: 0, entryPoint: 'later', specializedModule: 2 },
    ]);
    expect(background.shaders).toHaveLength(4);
  });
  it('does not apply a named entry projection to an omitted entry', () => {
    const out = normalizePipelineLibrary({
      ...manifest(),
      shaders: [{ code: 'original' }, { code: 'closure' }],
      renderPipelines: [],
      computePipelines: [0, 1].map((module) => ({ layout: 'auto', compute: { module } })),
      computeEntryModules: [{ module: 0, entryPoint: 'undefined', specializedModule: 1 }],
    });
    expect(out.computePipelines).toHaveLength(2);
  });
});
