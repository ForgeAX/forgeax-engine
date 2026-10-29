import { halfFloat } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  tapeDigest,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { addAutoExposureExposurePass } from '../pipeline/standard-output/auto-exposure/gpu';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';
import { whiteBalanceCases } from './white-balance-reference.fixture';

function decode(bytes: Uint8Array): number[] {
  return Array.from(new Uint16Array(bytes.slice(0, 8).buffer), halfFloat.f16ToF32);
}

/** Exercise the production graph, capture its draws and compare live/replay HDR pixels. */
export async function captureWhiteBalance() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const nativeDevice = recorder.backend.unwrapDeviceForSurface(device).unwrap();
  const raw = webgpu._internal_getRawDevice(nativeDevice);
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const createModule = recorder.backend.createShaderModuleImmediate;
  assert(createModule);
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const live: number[][] = [];
  try {
    for (const sample of whiteBalanceCases) {
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const input = createRenderPipelineTarget(graph, `${sample.name}.input`, {
        size: 'surface',
        format: 'rgba16float',
      }).unwrap();
      const output = createRenderPipelineTarget(graph, `${sample.name}.output`, {
        size: 'surface',
        format: 'rgba16float',
      }).unwrap();
      graph
        .addRasterPass('source', {
          accesses: [{ resource: input.view, usage: 'color-attachment' }],
          colorAttachments: [
            {
              view: input.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [...sample.rgb, 0.75],
            },
          ],
          encode() {},
        })
        .unwrap();
      const candidate = device.createBuffer({ size: 16, usage: 0x88 }).unwrap();
      device.queue.writeBuffer(candidate, 0, new Float32Array([sample.exposure, 1, 1, 1])).unwrap();
      const imported = graph
        .importBuffer('candidate', { size: 16, usage: 0x88 }, () => candidate)
        .unwrap();
      addAutoExposureExposurePass(
        { graph } as Parameters<typeof addAutoExposureExposurePass>[0],
        input,
        output,
        sample.exposure === 1
          ? undefined
          : ({ candidate: imported } as Parameters<typeof addAutoExposureExposurePass>[3]),
        sample,
      ).unwrap();
      const staging = device.createBuffer({ size: 256, usage: 9 }).unwrap();
      graph
        .addCopyPass('readback', {
          accesses: [{ resource: output.view, usage: 'copy-src' }],
          encode: ({ encoder, resources }) =>
            encoder.copyTextureToBuffer(
              { texture: resources.texture(output.texture).unwrap() },
              { buffer: staging, bytesPerRow: 256, rowsPerImage: 1 },
              { width: 1, height: 1, depthOrArrayLayers: 1 },
            ),
        })
        .unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        compiled
          .execute({
            encoder,
            runtime: {
              device,
              immediateShaderModuleFactory: {
                createShaderModule: (descriptor: { code: string; label?: string }) =>
                  createModule(device, descriptor),
              },
            },
          } as unknown as RenderPipelineFrame)
          .unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const mapped = (await staging.mapAsync(1)).unwrap();
        live.push(decode(new Uint8Array(mapped.getMappedRange().unwrap())));
        mapped.unmap();
      } finally {
        (await compiled.retire()).unwrap();
        device.destroyBuffer(staging).unwrap();
        device.destroyBuffer(candidate).unwrap();
      }
    }
    (await recorder.frameBoundary()).unwrap();
    const { bytes } = (await capture).unwrap();
    const tape = decodeTape(bytes).unwrap();
    const model = buildFrameModel(tape);
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    const replayed: number[][] = [];
    const inputs: number[][] = [];
    const candidates: number[] = [];
    try {
      const plans = model.works.map((work) => {
        const output = workOutputs(work).find((entry) => entry.name === 'color0');
        assert(output);
        const source = work.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 0,
        )?.resourceId;
        assert(source);
        const candidate = work.bindings.find(
          (binding) => binding.groupIndex === 1 && binding.binding === 0,
        )?.resourceId;
        return {
          work,
          ids: [output.request.resourceId, source, ...(candidate ? [candidate] : [])],
        };
      });
      const reads = (
        await replay.readAtWorks(
          plans.flatMap(({ work, ids }) =>
            ids.map((resourceId) => ({ resourceId, workIndex: work.workIndex })),
          ),
        )
      ).unwrap();
      let cursor = 0;
      const next = () => {
        const read = reads[cursor++];
        assert(read);
        return read.unwrap().bytes;
      };
      for (const plan of plans) {
        replayed.push(decode(next()));
        inputs.push(decode(next()));
        if (plan.ids.length === 3) {
          const data = next();
          candidates.push(
            new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(0, true),
          );
        }
      }
    } finally {
      (await replay.dispose()).unwrap();
      webgpu.disposeDevice(fresh);
    }
    return {
      bytes,
      digest: tapeDigest(bytes),
      live,
      replayed,
      inputs,
      candidates,
      errors,
      works: model.works.map((work) => ({
        workIndex: work.workIndex,
        pipeline: work.pipeline,
        bindings: work.bindings,
      })),
      unseededResources: model.unseededResources,
    };
  } finally {
    (await recorder.dispose()).unwrap();
    webgpu.disposeDevice(nativeDevice);
  }
}

export function verifyWhiteBalance(evidence: Awaited<ReturnType<typeof captureWhiteBalance>>) {
  expect(evidence.errors).toEqual([]);
  expect(evidence.works).toHaveLength(whiteBalanceCases.length);
  expect(evidence.replayed).toEqual(evidence.live);
  expect(evidence.inputs).toEqual(whiteBalanceCases.map((sample) => [...sample.rgb, 0.75]));
  expect(evidence.candidates).toEqual([2]);
  for (const [index, sample] of whiteBalanceCases.entries()) {
    const actual = evidence.live[index];
    assert(actual);
    expect(actual[3]).toBe(0.75);
    for (const [channel, expected] of sample.expected.entries()) {
      // Half-float target rounding; much smaller than the original color-space error.
      expect(Math.abs((actual[channel] ?? Number.NaN) - expected), sample.name).toBeLessThan(0.004);
    }
  }
}
