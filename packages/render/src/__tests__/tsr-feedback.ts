import type { BindGroup, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createTsrProgram, createTsrRasterProgram } from '../tsr/program';

interface Surface {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly width: number;
  readonly height: number;
  readonly format: 'rgba16float' | 'rgba8unorm' | 'r32float';
}
export function half(value: number): number {
  const buffer = new ArrayBuffer(4);
  new Float32Array(buffer)[0] = value;
  const bits = new Uint32Array(buffer)[0] ?? 0;
  const exponent = ((bits >>> 23) & 255) - 127 + 15;
  if (exponent <= 0) return (bits >>> 31) << 15;
  return ((bits >>> 31) << 15) | (Math.min(exponent, 31) << 10) | ((bits >>> 13) & 1023);
}
export function unhalf(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >>> 10) & 31;
  return (
    sign *
    (exponent === 0
      ? (value & 1023) * 2 ** -24
      : (1 + (value & 1023) / 1024) * 2 ** (exponent - 15))
  );
}

/** Production programs, actual storage textures, ordered GPU feedback; no CPU reconstruction. */
export function tsrFeedback(
  device: RhiDevice,
  createShaderModule: NonNullable<
    RenderPipelineFrame['runtime']['immediateShaderModuleFactory']
  >['createShaderModule'],
  inputSize = 2,
  outputSize = 4,
  precision: 'compact' | 'fp16' = 'compact',
  execution: 'compute' | 'raster' = 'compute',
  secondaryFormat: 'rgba8unorm' | 'r32float' = 'rgba8unorm',
) {
  // Reference experiment changes formats only. Every dispatch still executes
  // the production source on a real GPU; no acceptance result is computed here.
  const programDevice =
    precision === 'compact'
      ? device
      : new Proxy(device, {
          get(target, key) {
            if (key === 'createRenderPipeline')
              return (descriptor: Parameters<RhiDevice['createRenderPipeline']>[0]) =>
                device.createRenderPipeline({
                  ...descriptor,
                  fragment:
                    descriptor.fragment === undefined
                      ? undefined
                      : {
                          ...descriptor.fragment,
                          targets: Array.from(descriptor.fragment.targets, (target) =>
                            target?.format === 'rgba8unorm'
                              ? { ...target, format: 'rgba16float' as const }
                              : target,
                          ),
                        },
                });
            if (key === 'createBindGroupLayout')
              return (descriptor: Parameters<RhiDevice['createBindGroupLayout']>[0]) =>
                device.createBindGroupLayout({
                  ...descriptor,
                  entries: Array.from(descriptor.entries, (entry) =>
                    entry.storageTexture?.format === 'rgba8unorm'
                      ? {
                          ...entry,
                          storageTexture: {
                            ...entry.storageTexture,
                            format: 'rgba16float' as const,
                          },
                        }
                      : entry,
                  ),
                });
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
  const compile: typeof createShaderModule = (descriptor) =>
    createShaderModule(
      precision === 'compact'
        ? descriptor
        : {
            ...descriptor,
            code: descriptor.code.replaceAll(
              'texture_storage_2d<rgba8unorm',
              'texture_storage_2d<rgba16float',
            ),
          },
    );
  const frame = {
    runtime: {
      device: programDevice,
      immediateShaderModuleFactory: { createShaderModule: compile },
    },
  } as unknown as RenderPipelineFrame;
  const native =
    execution === 'compute'
      ? [createTsrProgram(frame, true), createTsrProgram(frame, false)]
      : undefined;
  const raster =
    execution === 'raster'
      ? [createTsrRasterProgram(frame, true), createTsrRasterProgram(frame, false)]
      : undefined;
  const programs = native ?? raster ?? [];
  if (programs.length === 0) throw new Error('missing feedback execution');
  const surfaces: Surface[] = [];
  function surface(label: string, width: number, format: Surface['format']): Surface {
    if (precision === 'fp16') format = 'rgba16float';
    const texture = device
      .createTexture({
        label,
        size: { width, height: 1 },
        format,
        usage: 1 | 2 | 4 | (execution === 'compute' ? 8 : 16),
      })
      .unwrap();
    const result = {
      texture,
      view: device.createTextureView(texture, {}).unwrap(),
      width,
      height: 1,
      format,
    };
    surfaces.push(result);
    return result;
  }
  const color = surface('tsr-fixture-scene', inputSize, 'rgba16float');
  const opaque = surface('tsr-fixture-opaque', inputSize, 'rgba16float');
  const temporal = surface('tsr-fixture-scene-temporal', inputSize, 'rgba16float');
  const secondary = surface('tsr-fixture-secondary', outputSize, secondaryFormat);
  const decision = surface('tsr-fixture-rejection', inputSize, 'rgba16float');
  const coverage = surface('tsr-fixture-coverage', outputSize, 'rgba16float');
  const histories = [0, 1].map((i) => ({
    color: surface(`tsr-fixture-color-${i}`, outputSize, 'rgba16float'),
    temporal: surface(`tsr-fixture-temporal-${i}`, outputSize, 'rgba16float'),
    metadata: surface(`tsr-fixture-support-${i}`, outputSize, 'rgba8unorm'),
    guide: surface(`tsr-fixture-guide-${i}`, inputSize, 'rgba8unorm'),
    moire: surface(`tsr-fixture-moire-${i}`, inputSize, 'rgba16float'),
  }));
  const params = device
    .createBuffer({ label: 'tsr-fixture-params', size: 64, usage: 64 | 8 })
    .unwrap();
  let readIndex = 0,
    index = 0;
  function upload(target: Surface, pixels: readonly number[], _bytes = 2) {
    const bytes = target.format === 'r32float' ? 4 : target.format === 'rgba16float' ? 2 : 1;
    const channels = target.format === 'r32float' ? 1 : 4;
    const data =
      bytes === 4
        ? new Float32Array(pixels.filter((_, i) => i % 4 === 0))
        : bytes === 2
          ? new Uint16Array(pixels.map(half))
          : new Uint8Array(pixels.map((v) => Math.round(v * 255)));
    device.queue
      .writeTexture(
        { texture: target.texture },
        data,
        { bytesPerRow: target.width * channels * bytes, rowsPerImage: 1 },
        { width: target.width, height: 1 },
      )
      .unwrap();
  }
  function group(
    program: (typeof programs)[number],
    reads: Surface[],
    writes: Surface[],
  ): BindGroup {
    if (!program) throw new Error('missing production program');
    const n = reads.length;
    return device
      .createBindGroup({
        layout: program.layout,
        entries: [
          ...reads.map((s, binding) => ({
            binding,
            resource: { kind: 'textureView' as const, value: s.view },
          })),
          { binding: n, resource: { kind: 'sampler', value: program.sampler } },
          { binding: n + 1, resource: { kind: 'buffer', value: { buffer: params } } },
          ...(execution === 'compute' ? writes : []).map((s, i) => ({
            binding: n + 2 + i,
            resource: { kind: 'textureView' as const, value: s.view },
          })),
        ],
      })
      .unwrap();
  }
  function draw(
    pixels: readonly number[],
    options: {
      readonly reactive?: number;
      readonly depth?: number;
      readonly motion?: number;
      readonly secondary?: number;
      readonly reset?: boolean;
      readonly deltaSeconds?: number;
      readonly opaquePixels?: readonly number[];
      readonly coverageReactive?: number;
    } = {},
  ) {
    const old = histories[readIndex],
      next = histories[1 - readIndex];
    if (!old || !next) throw new Error('missing feedback history');
    upload(color, pixels);
    upload(
      opaque,
      (options.opaquePixels ?? pixels).map((v, i) =>
        i % 4 === 3 ? 1 : Math.log2(1 + Math.max(0, Math.min(65504, v))) / 16,
      ),
      1,
    );
    upload(
      temporal,
      Array.from({ length: inputSize }, () => [
        options.motion ?? 0,
        0,
        options.depth ?? 2,
        options.reactive ?? 0,
      ]).flat(),
    );
    upload(
      secondary,
      Array.from({ length: outputSize }, () => [options.secondary ?? 0, 0, 0, 0]).flat(),
      1,
    );
    if (options.coverageReactive !== undefined)
      upload(
        coverage,
        Array.from({ length: outputSize }, () => [
          options.motion ?? 0,
          0,
          options.depth ?? 2,
          options.coverageReactive ?? 0,
        ]).flat(),
      );
    const data = new ArrayBuffer(64),
      f = new Float32Array(data),
      u = new Uint32Array(data);
    f.set([0, 0, 0, 0, inputSize, 1, inputSize, 1]);
    u[8] = Number(index > 0 && !options.reset);
    u[9] = u[8] ?? 0;
    u[10] = index;
    u[11] = 1;
    u[12] = Number(options.coverageReactive !== undefined);
    f[13] = options.deltaSeconds ?? 1 / 60;
    device.queue.writeBuffer(params, 0, new Uint8Array(data)).unwrap();
    const inputs = [
      [
        color,
        temporal,
        old.guide,
        old.moire,
        old.temporal,
        opaque,
        options.coverageReactive === undefined ? temporal : coverage,
      ],
      [
        color,
        temporal,
        old.color,
        old.temporal,
        old.metadata,
        decision,
        secondary,
        options.coverageReactive === undefined ? temporal : coverage,
      ],
    ];
    const outputs = [
      [next.guide, next.moire, decision],
      [next.color, next.temporal, next.metadata],
    ];
    const encoder = device.createCommandEncoder().unwrap();
    for (let i = 0; i < 2; i++) {
      const program = programs[i],
        reads = inputs[i],
        writes = outputs[i];
      if (!program || !reads || !writes) throw new Error('missing feedback stage');
      const nativeProgram = native?.[i],
        rasterProgram = raster?.[i];
      if (nativeProgram) {
        const pass = encoder.beginComputePass({
          label: i === 0 ? 'tsr-analyze' : 'tsr-reconstruct',
        });
        pass.setPipeline(nativeProgram.pipeline);
        pass.setBindGroup(0, group(nativeProgram, reads, writes));
        pass.dispatchWorkgroups(Math.ceil((i === 0 ? inputSize : outputSize) / 8), 1, 1);
        pass.end();
      } else if (rasterProgram) {
        const pass = encoder.beginRenderPass({
          label: i === 0 ? 'tsr-analyze' : 'tsr-reconstruct',
          colorAttachments: writes.map((s) => ({
            view: s.view,
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          })),
        });
        pass.setPipeline(rasterProgram.pipeline);
        pass.setBindGroup(0, group(rasterProgram, reads, writes));
        pass.draw(3);
        pass.end();
      }
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    readIndex = 1 - readIndex;
    index++;
    return next;
  }
  async function read(target: Surface, bytes = target.format === 'rgba16float' ? 2 : 1) {
    const buffer = device.createBuffer({ size: 256, usage: 1 | 8 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyTextureToBuffer(
        { texture: target.texture },
        { buffer, bytesPerRow: 256, rowsPerImage: 1 },
        { width: target.width, height: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await buffer.mapAsync(1)).unwrap();
      const copied = mapped
        .getMappedRange()
        .unwrap()
        .slice(0, target.width * 4 * bytes);
      mapped.unmap();
      return bytes === 2
        ? Array.from(new Uint16Array(copied), unhalf)
        : Array.from(new Uint8Array(copied), (v) => v / 255);
    } finally {
      device.destroyBuffer(buffer).unwrap();
    }
  }
  return {
    draw,
    read,
    dispose() {
      for (const s of surfaces) device.destroyTexture(s.texture).unwrap();
      device.destroyBuffer(params).unwrap();
    },
  };
}
