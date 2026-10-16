import type { Result, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { RenderBundleCache } from '../../../render/src/record/render-bundle-cache';
import { buildFrameModel } from '../../../rhi-debug/src/frame-model';
import { decodeTape } from '../../../rhi-debug/src/protocol/codec';
import { readbackTexturePixels } from '../../../rhi-debug/src/readback';
import { attachRecorder } from '../../../rhi-debug/src/recorder/session';
import { openReplay } from '../../../rhi-debug/src/replay/session';

function value<T>(result: Result<T, { readonly code: string; readonly hint: string }>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
  return result.value;
}
const code = `
@group(0) @binding(0) var<uniform> color: vec4f;
@vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return color; }
`;

/** A cache must not turn a native out-of-bounds slice error into an empty binding. */
export async function runInvalidBundleOffsetFixture() {
  const adapter = value(await backend.rhi.requestAdapter());
  const device = value(await adapter.requestDevice());
  const texture = value(device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x10 }));
  const view = value(device.createTextureView(texture, {}));
  const layout = value(device.createBindGroupLayout({ entries: [] }));
  const group = value(device.createBindGroup({ layout, entries: [] }));
  try {
    for (const cached of [false, true]) {
      const encoder = value(device.createCommandEncoder());
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      });
      const record = (target: RhiRenderPassEncoder) =>
        target.setBindGroup(0, group, new Uint32Array([0]), 1, 1);
      try {
        expect(() => {
          if (cached)
            new RenderBundleCache({ colorFormats: ['rgba8unorm'] }).encode(device, pass, record);
          else record(pass);
        }).toThrow();
      } finally {
        pass.end();
      }
    }
  } finally {
    value(device.destroyTexture(texture));
  }
}

/** Shared real Browser/Dawn case: cached commands, live buffer data, fresh replay. */
export async function runRenderBundleFixture(warmupFrames = 60) {
  const recorder = value(attachRecorder(backend));
  const adapter = value(await recorder.backend.rhi.requestAdapter());
  const device = value(await adapter.requestDevice());
  const texture = value(
    device.createTexture({ size: [32, 32], format: 'rgba8unorm', usage: 0x11 }),
  );
  const view = value(device.createTextureView(texture, {}));
  const vertices = value(device.createBuffer({ size: 24, usage: 0x28 }));
  value(device.queue.writeBuffer(vertices, 0, new Float32Array([-1, -1, 3, -1, -1, 3])));
  const indices = value(device.createBuffer({ size: 8, usage: 0x18 }));
  value(device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0])));
  const uniform = value(device.createBuffer({ size: 512, usage: 0x48 }));
  value(device.queue.writeBuffer(uniform, 256, new Float32Array([1, 0, 0, 1])));
  const indirect = value(device.createBuffer({ size: 40, usage: 0x108 }));
  value(device.queue.writeBuffer(indirect, 0, new Uint32Array([3, 1, 0, 0, 0, 3, 1, 0, 0, 0])));
  const bgl = value(
    device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 2,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
      ],
    }),
  );
  const group = value(
    device.createBindGroup({
      layout: bgl,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: uniform, offset: 0, size: 16 } },
        },
      ],
    }),
  );
  const layout = value(device.createPipelineLayout({ bindGroupLayouts: [bgl] }));
  const shader = value(await recorder.backend.createShaderModule(device, { code }));
  const pipeline = value(
    device.createRenderPipeline({
      layout,
      vertex: {
        module: shader,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    }),
  );
  const cache = new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
  const offsets = new Uint32Array([0, 256, 0]);
  let count = 3;
  const record = (pass: RhiRenderPassEncoder) => {
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertices, 0, 24);
    pass.setIndexBuffer(indices, 'uint16', 0, 6);
    pass.setBindGroup(0, group, offsets, 1, 1);
    pass.draw(count, 1, 0, 0);
    pass.drawIndexed(count, 1, 0, 0, 0);
    pass.drawIndirect(indirect, 0);
    pass.drawIndexedIndirect(indirect, 20);
  };
  const frame = async (cached = true) => {
    const encoder = value(device.createCommandEncoder());
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    if (cached) cache.encode(device, pass, record);
    else record(pass);
    pass.end();
    value(device.queue.submit([value(encoder.finish())]));
    await device.queue.onSubmittedWorkDone();
  };
  try {
    for (let i = 0; i < warmupFrames; i++) await frame();
    const red = await readbackTexturePixels(device, texture, 32, 32);
    expect(Array.from(red.slice(0, 4))).toEqual([255, 0, 0, 255]);
    // The bundle still references the same uniform; no re-record is necessary.
    value(device.queue.writeBuffer(uniform, 256, new Float32Array([0, 1, 0, 1])));
    offsets[0] = 999;
    offsets[2] = 999;
    const captured = recorder.captureFrame();
    value(await recorder.frameBoundary());
    await frame();
    value(await recorder.frameBoundary());
    const artifact = value(await captured);
    const tape = value(decodeTape(artifact.bytes));
    const model = buildFrameModel(tape);
    expect(model.works).toHaveLength(4);
    expect(tape.events.filter((e) => e.kind === 'resetRenderState')).toHaveLength(2);
    expect(
      tape.events.filter((e) => e.kind === 'setBindGroup').map((e) => e.dynamicOffsets),
    ).toEqual([[256]]);
    expect(model.unseededResources).toHaveLength(0);
    const green = await readbackTexturePixels(device, texture, 32, 32);
    expect(Array.from(green.slice(0, 4))).toEqual([0, 255, 0, 255]);
    await frame(false);
    const direct = await readbackTexturePixels(device, texture, 32, 32);
    expect(direct).toEqual(green);
    const replayAdapter = value(await backend.rhi.requestAdapter());
    const replayDevice = value(await replayAdapter.requestDevice());
    const replay = value(
      await openReplay(tape, {
        device: replayDevice,
        createShaderModule: backend.createShaderModule,
      }),
    );
    try {
      for (let index = 0; index < model.works.length; index++) {
        const inspection = value(
          await replay.inspectWork(index, ['pipeline', 'bindings', 'pixels']),
        );
        expect(inspection.pipeline).toBeDefined();
        expect(inspection.bindings?.length).toBe(1);
        expect(inspection.attachment?.bytes).toEqual(green);
      }
    } finally {
      value(await replay.dispose());
    }
    // Falsifier: all draws become empty; stale cached commands must not survive.
    count = 0;
    value(device.queue.writeBuffer(indirect, 0, new Uint32Array(10)));
    await frame();
    await frame();
    const empty = await readbackTexturePixels(device, texture, 32, 32);
    expect(Array.from(empty.slice(0, 4))).toEqual([0, 0, 0, 255]);
    return {
      artifact,
      green,
      backendKind: device.caps.backendKind,
      frames: 65,
      works: model.works.length,
    };
  } finally {
    value(await recorder.dispose());
    for (const buffer of [vertices, indices, uniform, indirect])
      value(device.destroyBuffer(buffer));
    value(device.destroyTexture(texture));
  }
}
