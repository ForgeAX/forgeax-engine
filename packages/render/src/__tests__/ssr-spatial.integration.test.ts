import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { CommandBuffer, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { admitSsrSpatial } from '../ssr/admission';
import { addSsrSpatialPasses } from '../ssr/graph';

const WIDTH = 5;
const HEIGHT = 3;

type Frame = { readonly encoder: RhiCommandEncoder };

class RecordingNullQueue extends RhiNullQueue {
  submitCount = 0;
  submitted: readonly CommandBuffer[] = [];

  override submit(commandBuffers: readonly CommandBuffer[]) {
    this.submitCount += 1;
    this.submitted = commandBuffers;
    return super.submit(commandBuffers);
  }
}

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

function createDevice(queue: RecordingNullQueue): RhiNullDevice {
  return new RhiNullDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

describe('SSR spatial RhiNull integration', () => {
  it('executes the admitted odd-size topology once through one finish and submit', async () => {
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

    const pyramid = addDepthPyramidPasses(graph, { depth, width: WIDTH, height: HEIGHT });
    expect(pyramid.ok).toBe(true);
    if (!pyramid.ok) return;
    const projected = addSsrSpatialPasses(graph, {
      admission: admittedAdmission(),
      width: WIDTH,
      height: HEIGHT,
      depth,
      normal,
      scene,
      fallback,
      currentTemporal,
      depthPyramid: pyramid.value.pyramid,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const queue = new RecordingNullQueue();
    const device = createDevice(queue);
    const compiled = graph.compile({ device, surfaceSize: { width: WIDTH, height: HEIGHT } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const encoder = device.createCommandEncoder({ label: 'ssr-spatial-rhinull-frame' });
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    const executed = compiled.value.execute({ encoder: encoder.value });
    expect(executed.ok).toBe(true);
    const finished = encoder.value.finish();
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    const submitted = device.queue.submit([finished.value]);
    expect(submitted.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    expect(queue.submitCount).toBe(1);
    expect(queue.submitted).toHaveLength(1);
    expect(device.framePassNames).toEqual([
      'seed-inputs',
      'depth-pyramid-seed',
      'depth-pyramid-reduce-chain',
      'ssr-trace',
    ]);
    expect(compiled.value.inspect().resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'depth-pyramid', format: 'r32float' }),
        expect.objectContaining({ label: 'ssr-trace', format: 'rgba16float' }),
      ]),
    );
    expect(projected.value.trace).toMatchObject({
      resolution: 'half',
      coarseSteps: 48,
      refineSteps: 5,
    });
    expect((await compiled.value.retire()).ok).toBe(true);
  });
});
