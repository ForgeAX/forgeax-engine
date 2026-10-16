import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { admitSsrSpatial } from '../ssr/admission';
import { addSsrSpatialPasses } from '../ssr/graph';

const WIDTH = 5;
const HEIGHT = 3;

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
  const texture = graph
    .createTexture(label, {
      format,
      size: { width: WIDTH, height: HEIGHT },
    })
    .unwrap();
  return graph.view(texture, { label: `${label}.view` }).unwrap();
}

describe('Depth pyramid + SSR spatial Browser WebGPU gate', () => {
  it('probes the real format/BGL chain and submits the odd-size spatial topology', async () => {
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;
    const deviceResult = await adapterResult.value.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device = deviceResult.value;

    const formatReceipt = await device.probeTextureFormatCapability();
    expect(formatReceipt.ok).toBe(true);
    if (!formatReceipt.ok) return;
    expect(formatReceipt.value).toMatchObject({
      profile: 'r32float-mip-sampled-storage',
      verdict: 'admitted',
      evidence: 'real',
    });
    expect(formatReceipt.value.stages.map((stage) => stage.stage)).toEqual([
      'texture-create',
      'mip-view',
      'sampled-storage-bind-group',
      'pipeline-bind',
      'finish',
      'submit',
      'completion',
      'readback',
    ]);
    expect(formatReceipt.value.readback?.byteLength).toBeGreaterThan(0);

    const graph = new RenderGraphBuilder<Frame>();
    const depth = input(graph, 'scene-depth', 'r32float');
    const normal = input(graph, 'gbuffer-normal', 'r32uint');
    const scene = input(graph, 'scene-color', 'rgba16float');
    const fallback = input(graph, 'reflection-fallback', 'rgba16float');
    const currentTemporal = input(graph, 'scene-temporal', 'rgba16float');
    const seeded = graph.addComputePass('seed-inputs', {
      accesses: [
        { resource: depth, usage: 'storage-write' },
        { resource: normal, usage: 'storage-write' },
        { resource: scene, usage: 'storage-write' },
        { resource: fallback, usage: 'storage-write' },
        { resource: currentTemporal, usage: 'storage-write' },
      ],
      encode: () => undefined,
    });
    expect(seeded.ok).toBe(true);
    const depthPyramid = addDepthPyramidPasses(graph, { depth, width: WIDTH, height: HEIGHT });
    expect(depthPyramid.ok).toBe(true);
    if (!depthPyramid.ok) return;
    const projected = addSsrSpatialPasses(graph, {
      admission: admittedAdmission(),
      depthPyramid: depthPyramid.value.pyramid,
      width: WIDTH,
      height: HEIGHT,
      depth,
      normal,
      scene,
      fallback,
      currentTemporal,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const compiled = graph.compile({ device, surfaceSize: { width: WIDTH, height: HEIGHT } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const encoder = device.createCommandEncoder({ label: 'ssr-spatial-browser-frame' });
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    expect(compiled.value.execute({ encoder: encoder.value }).ok).toBe(true);
    const finished = encoder.value.finish();
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(device.queue.submit([finished.value]).ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    const info = compiled.value.inspect();
    expect(info.passes.map((pass) => pass.name)).toEqual([
      'seed-inputs',
      'depth-pyramid-seed',
      'depth-pyramid-reduce-chain',
      'ssr-trace',
    ]);
    expect(
      info.resources.find((resource) => resource.label === 'depth-pyramid')?.descriptor,
    ).toMatchObject({
      format: 'r32float',
      width: Math.floor(WIDTH / 2),
      height: Math.floor(HEIGHT / 2),
      mipLevelCount: 2,
    });
    console.info(
      `[ssr-spatial-browser] ${JSON.stringify({
        backend: device.caps.backendKind,
        formatProfile: formatReceipt.value.profile,
        stages: formatReceipt.value.stages.map((stage) => stage.stage),
        passNames: info.passes.map((pass) => pass.name),
        structuralOnly: true,
      })}`,
    );
    expect((await compiled.value.retire()).ok).toBe(true);
  });
});
