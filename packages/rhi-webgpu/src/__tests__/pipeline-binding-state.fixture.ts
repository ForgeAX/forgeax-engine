import type { Buffer, RenderPipeline, Result, RhiRenderCommands } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { makeRhiDevice } from '../device';
import { createShaderModule } from '../index';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Native pixels and validation, including a changed middle group layout. */
export async function runPipelineBindingState() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('WebGPU adapter unavailable');
  const raw = await adapter.requestDevice();
  const device = makeRhiDevice(raw).device;
  const buffers: Buffer[] = [];
  const uniform = (data: number[]) => {
    const buffer = value(device.createBuffer({ size: 16, usage: 0x48 }));
    buffers.push(buffer);
    value(device.queue.writeBuffer(buffer, 0, new Float32Array(data)));
    return buffer;
  };
  const sharedLayout = value(
    device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 3,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
      ],
    }),
  );
  const materialLayouts = [1, 2].map((count) =>
    value(
      device.createBindGroupLayout({
        entries: Array.from({ length: count }, (_, binding) => ({
          binding,
          visibility: 3,
          buffer: { type: 'uniform' as const, minBindingSize: 16 },
        })),
      }),
    ),
  );
  const camera = value(
    device.createBindGroup({
      layout: sharedLayout,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: uniform([1, 1, 0, 0]), size: 16 } },
        },
      ],
    }),
  );
  const mesh = value(
    device.createBindGroup({
      layout: sharedLayout,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: uniform([0, 0, 0, 0]), size: 16 } },
        },
      ],
    }),
  );
  const materials = materialLayouts.map((layout, index) =>
    value(
      device.createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer' as const,
              value: { buffer: uniform(index === 0 ? [-0.5, 0, 1, 0] : [0.5, 0, 0, 1]), size: 16 },
            },
          },
          ...(index === 0
            ? []
            : [
                {
                  binding: 1,
                  resource: {
                    kind: 'buffer' as const,
                    value: { buffer: uniform([0, 0, 0, 0]), size: 16 },
                  },
                },
              ]),
        ],
      }),
    ),
  );
  const pipelines: RenderPipeline[] = [];
  for (let index = 0; index < 2; index++) {
    const materialLayout = materialLayouts[index];
    if (materialLayout === undefined) throw Error('Missing fixture material layout');
    const shader = value(
      await createShaderModule(device, {
        code: `
@group(0) @binding(0) var<uniform> camera: vec4f;
@group(1) @binding(0) var<uniform> material: vec4f;
${index === 0 ? '' : '@group(1) @binding(1) var<uniform> extra: vec4f;'}
@group(2) @binding(0) var<uniform> mesh: vec4f;
@vertex fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let shift = material.xy + mesh.xy ${index === 0 ? '' : '+ extra.xy'};
  return vec4f((p[vertex] * vec2f(.4,.8) + shift) * camera.xy, 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(material.zw, mesh.z, 1); }`,
      }),
    );
    pipelines.push(
      value(
        device.createRenderPipeline({
          layout: value(
            device.createPipelineLayout({
              bindGroupLayouts: [sharedLayout, materialLayout, sharedLayout],
            }),
          ),
          vertex: { module: shader, entryPoint: 'vs', buffers: [] },
          fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        }),
      ),
    );
  }
  const target = value(device.createTexture({ size: [16, 16], format: 'rgba8unorm', usage: 0x11 }));
  const view = value(device.createTextureView(target, {}));
  const readback = value(device.createBuffer({ size: 4096, usage: 0x9 }));
  buffers.push(readback);
  const render = async (bundle: boolean, rebindShared: boolean, staleMaterial = false) => {
    raw.pushErrorScope('validation');
    const command = value(device.createCommandEncoder());
    const pass = command.beginRenderPass({
      colorAttachments: [
        { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    });
    const draw = (commands: RhiRenderCommands) => {
      let sharedSet = false;
      for (const index of [0, 1, 0]) {
        const pipeline = pipelines[index],
          material = materials[staleMaterial ? 0 : index];
        if (pipeline === undefined || material === undefined) throw Error('Missing fixture draw');
        commands.setPipeline(pipeline);
        if (rebindShared || !sharedSet) {
          commands.setBindGroup(0, camera, [0]);
          commands.setBindGroup(2, mesh, [0]);
          sharedSet = true;
        }
        commands.setBindGroup(1, material);
        commands.draw(6);
      }
    };
    if (bundle) {
      const encoder = value(device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] }));
      draw(encoder);
      value(pass.executeBundles([value(encoder.finish())]));
    } else draw(pass);
    pass.end();
    command.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      { width: 16, height: 16, depthOrArrayLayers: 1 },
    );
    value(device.queue.submit([value(command.finish())]));
    await device.queue.onSubmittedWorkDone();
    const error = await raw.popErrorScope();
    if (staleMaterial) {
      expect(error).not.toBeNull();
      return [];
    }
    expect(error).toBeNull();
    const mapped = value(await readback.mapAsync(GPUMapMode.READ));
    const bytes = Array.from(new Uint8Array(value(mapped.getMappedRange()).slice(0)));
    mapped.unmap();
    expect(bytes.slice(10 * 256 + 3 * 4, 10 * 256 + 3 * 4 + 4)).toEqual([255, 0, 0, 255]);
    expect(bytes.slice(10 * 256 + 11 * 4, 10 * 256 + 11 * 4 + 4)).toEqual([0, 255, 0, 255]);
    return bytes;
  };
  try {
    const baseline = await render(false, true);
    expect(await render(false, false)).toEqual(baseline);
    expect(await render(true, false)).toEqual(baseline);
    await render(false, false, true);
  } finally {
    for (const buffer of buffers) value(device.destroyBuffer(buffer));
    value(device.destroyTexture(target));
    await raw.queue.onSubmittedWorkDone();
    raw.destroy();
  }
}
