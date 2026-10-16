import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { admitSsrSpatial } from '../ssr/admission';
import { addSsrSpatialPasses } from '../ssr/graph';

type Frame = { readonly encoder: RhiCommandEncoder };

function admittedAdmission() {
  return admitSsrSpatial({
    camera: {
      projection: 'perspective',
      near: 0.1,
      far: 100,
      screenSpaceReflection: { maxDistance: 40, thickness: 0.2, maxRoughness: 0.6 },
    },
    environment: {
      lane: 'deferred',
      m0: { status: 'admitted' },
      sceneInputs: true,
      temporal: true,
      reflectionFallback: true,
      capabilities: {
        compute: true,
        storageTexture: true,
        rgba16floatRenderable: true,
        r32floatSampledStorage: true,
      },
    },
  });
}

function input(
  graph: RenderGraphBuilder<Frame>,
  label: string,
  format: 'rgba16float' | 'r32float' | 'r32uint',
) {
  const texture = graph.createTexture(label, { format, size: { width: 5, height: 3 } }).unwrap();
  return graph.view(texture, { label: `${label}.view` }).unwrap();
}

describe('SSR typed spatial graph', () => {
  it('declares one ordered graph with per-mip accesses and no synthetic composition passes', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const depth = input(graph, 'scene-depth', 'r32float');
    const normal = input(graph, 'gbuffer-normal', 'r32uint');
    const scene = input(graph, 'scene-color', 'rgba16float');
    const fallback = input(graph, 'reflection-fallback', 'rgba16float');
    const currentTemporal = input(graph, 'scene-temporal', 'rgba16float');
    const initialized = graph.addComputePass('seed-inputs', {
      accesses: [
        { resource: depth, usage: 'storage-write' },
        { resource: normal, usage: 'storage-write' },
        { resource: scene, usage: 'storage-write' },
        { resource: fallback, usage: 'storage-write' },
        { resource: currentTemporal, usage: 'storage-write' },
      ],
      encode: () => undefined,
    });
    expect(initialized.ok).toBe(true);

    const pyramid = addDepthPyramidPasses(graph, { depth, width: 5, height: 3 });
    expect(pyramid.ok).toBe(true);
    if (!pyramid.ok) return;
    const result = addSsrSpatialPasses(graph, {
      admission: admittedAdmission(),
      width: 5,
      height: 3,
      depth,
      normal,
      scene,
      fallback,
      currentTemporal,
      depthPyramid: pyramid.value.pyramid,
    });
    expect(result).toMatchObject({ ok: true, value: { enabled: true } });
    if (!result.ok) return;

    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 5, height: 3 } }).unwrap();
    const info = compiled.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toEqual([
      'seed-inputs',
      'depth-pyramid-seed',
      'depth-pyramid-reduce-chain',
      'ssr-trace',
    ]);
    expect(info.resources.map((resource) => resource.label)).toEqual(
      expect.arrayContaining(['depth-pyramid', 'ssr-trace', 'ssr-hit-reactivity']),
    );
    expect(info.passes.find((pass) => pass.name === 'ssr-trace')?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'scene-temporal', usage: 'sampled-read' },
        { resource: 'depth-pyramid', usage: 'sampled-read' },
        { resource: 'ssr-hit-reactivity', usage: 'storage-write' },
      ]),
    );
    expect(
      info.passes.find((pass) => pass.name === 'depth-pyramid-reduce-chain')?.accesses,
    ).toEqual([
      { resource: 'depth-pyramid', usage: 'sampled-read' },
      { resource: 'depth-pyramid', usage: 'storage-write' },
    ]);
    expect(
      info.resources.find((resource) => resource.label === 'depth-pyramid')?.descriptor,
    ).toMatchObject({
      format: 'r32float',
      mipLevelCount: 2,
    });
    expect(names.indexOf('depth-pyramid-reduce-chain')).toBeLessThan(names.indexOf('ssr-trace'));
    await compiled.retire();
  });
});

describe('SSR spatial graph inputs', () => {
  it('rejects an admitted trace without the shared depth pyramid', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const result = addSsrSpatialPasses(graph, {
      admission: admittedAdmission(),
      width: 5,
      height: 3,
      depth: input(graph, 'scene-depth', 'r32float'),
      normal: input(graph, 'gbuffer-normal', 'r32uint'),
      scene: input(graph, 'scene-color', 'rgba16float'),
      fallback: input(graph, 'reflection-fallback', 'rgba16float'),
      currentTemporal: input(graph, 'scene-temporal', 'rgba16float'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).toContain('depthPyramid');
  });
});
