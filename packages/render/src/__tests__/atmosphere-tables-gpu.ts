import { halfFloat } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { writeAtmosphereUniform } from '../environment/uniform';
import { atmosphereVisibilityLayout } from '../environment/visibility';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { earthAtmosphere } from './atmosphere-fixture';
import type { ModuleFactory } from './portable-kernel-expansion-gpu';

/** Read every production LUT texel from the actual GPU; no CPU rendering substitute. */
export async function runAtmosphereTables(
  device: RhiDevice,
  factory: ModuleFactory,
  source: string,
  execution: 'compute' | 'fragment',
) {
  const uniform = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 0x48 }).unwrap();
  const values = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  values.set([0, -0.6, 0.8], 16);
  values.set([100000, 100000, 100000], 20);
  values.set([0, 1, 0], 24);
  writeAtmosphereUniform(values, 292, earthAtmosphere, 96000);
  device.queue.writeBuffer(uniform, 0, values).unwrap();
  const module = factory({ code: source }).unwrap();
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
  const shadow = device
    .createTexture({
      format: 'depth32float',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      usage: 0x14,
    })
    .unwrap();
  const white = device
    .createTexture({ format: 'rgba8unorm', size: { width: 1, height: 1 }, usage: 0x14 })
    .unwrap();
  const visibility = device
    .createBindGroup({
      layout: atmosphereVisibilityLayout(device),
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'textureView',
            value: device.createTextureView(shadow, { dimension: '2d-array' }).unwrap(),
          },
        },
        {
          binding: 1,
          resource: {
            kind: 'sampler',
            value: device.createSampler({ compare: 'greater-equal' }).unwrap(),
          },
        },
        {
          binding: 2,
          resource: { kind: 'textureView', value: device.createTextureView(white, {}).unwrap() },
        },
        { binding: 3, resource: { kind: 'sampler', value: sampler } },
        {
          binding: 4,
          resource: { kind: 'buffer', value: { buffer: uniform, size: VIEW_UNIFORM_BYTES } },
        },
      ],
    })
    .unwrap();
  const targets = [
    { name: 'transmittance', width: 256, height: 64 },
    { name: 'multiple_scattering', width: 32, height: 32 },
    { name: 'sky_view', width: 192, height: 208 },
  ].map((stage) => {
    const texture = device
      .createTexture({
        format: 'rgba16float',
        size: { width: stage.width, height: stage.height },
        usage: execution === 'compute' ? 0x0d : 0x15,
      })
      .unwrap();
    return { ...stage, texture, view: device.createTextureView(texture, {}).unwrap() };
  });
  let length = 0;
  const layouts = targets.map((stage) => {
    const row = Math.ceil((stage.width * 8) / 256) * 256;
    const offset = length;
    length += row * stage.height;
    return { row, offset };
  });
  const readback = device.createBuffer({ size: length, usage: 9 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    for (const [index, stage] of targets.entries()) {
      const inputs = targets.slice(0, index);
      const stageFlag = execution === 'compute' ? 4 : 2;
      const layout = device
        .createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: stageFlag,
              buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
            },
            ...inputs.map((_, i) => ({
              binding: i + 1,
              visibility: stageFlag,
              texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
            })),
            ...(index > 0
              ? [{ binding: 3, visibility: stageFlag, sampler: { type: 'filtering' as const } }]
              : []),
            ...(execution === 'compute'
              ? [
                  {
                    binding: 4,
                    visibility: 4,
                    storageTexture: {
                      access: 'write-only' as const,
                      format: 'rgba16float' as const,
                      viewDimension: '2d' as const,
                    },
                  },
                ]
              : []),
          ],
        })
        .unwrap();
      const pipelineLayout = device
        .createPipelineLayout({
          bindGroupLayouts: [
            layout,
            ...(stage.name === 'sky_view' ? [atmosphereVisibilityLayout(device)] : []),
          ],
        })
        .unwrap();
      const group = device
        .createBindGroup({
          layout,
          entries: [
            {
              binding: 0,
              resource: { kind: 'buffer', value: { buffer: uniform, size: VIEW_UNIFORM_BYTES } },
            },
            ...inputs.map((input, i) => ({
              binding: i + 1,
              resource: { kind: 'textureView' as const, value: input.view },
            })),
            ...(index > 0
              ? [{ binding: 3, resource: { kind: 'sampler' as const, value: sampler } }]
              : []),
            ...(execution === 'compute'
              ? [{ binding: 4, resource: { kind: 'textureView' as const, value: stage.view } }]
              : []),
          ],
        })
        .unwrap();
      if (execution === 'compute') {
        const pipeline = device
          .createComputePipeline({
            layout: pipelineLayout,
            compute: { module, entryPoint: `atmosphere_${stage.name}` },
          })
          .unwrap();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        if (stage.name === 'sky_view') pass.setBindGroup(1, visibility);
        pass.dispatchWorkgroups(stage.width / 8, stage.height / 8, 1);
        pass.end();
      } else {
        const pipeline = device
          .createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'atmosphere_tables_vs', buffers: [] },
            fragment: {
              module,
              entryPoint: `atmosphere_${stage.name}_fragment`,
              targets: [{ format: 'rgba16float' }],
            },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: stage.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        if (stage.name === 'sky_view') pass.setBindGroup(1, visibility);
        pass.draw(3);
        pass.end();
      }
    }
    for (const [index, stage] of targets.entries()) {
      const layout = layouts[index];
      if (layout === undefined) throw new Error('missing readback layout');
      encoder.copyTextureToBuffer(
        { texture: stage.texture },
        {
          buffer: readback,
          bytesPerRow: layout.row,
          offset: layout.offset,
          rowsPerImage: stage.height,
        },
        { width: stage.width, height: stage.height, depthOrArrayLayers: 1 },
      );
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    return targets.map((stage, index) => {
      const layout = layouts[index];
      if (layout === undefined) throw new Error('missing mapped layout');
      const data = new DataView(bytes);
      return {
        name: stage.name,
        width: stage.width,
        height: stage.height,
        values: Float32Array.from({ length: stage.width * stage.height * 4 }, (_, channel) => {
          const pixel = Math.floor(channel / 4),
            x = pixel % stage.width,
            y = Math.floor(pixel / stage.width);
          return halfFloat.f16ToF32(
            data.getUint16(layout.offset + y * layout.row + x * 8 + (channel % 4) * 2, true),
          );
        }),
      };
    });
  } finally {
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(uniform).unwrap();
    for (const target of targets) device.destroyTexture(target.texture).unwrap();
    device.destroyTexture(shadow).unwrap();
    device.destroyTexture(white).unwrap();
  }
}
