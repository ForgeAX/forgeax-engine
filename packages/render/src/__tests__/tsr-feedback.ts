import type { BindGroup, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderPipelineFrame } from '../render-pipeline';
import { flickerTerms } from '../temporal/gpu';
import { TSR_ANALYSIS_FORMATS, TSR_PARAMS_BYTES } from '../tsr/layout';
import {
  createTsrProgram,
  createTsrRasterProgram,
  type TsrStage,
  tsrStageWorkgroupSize,
} from '../tsr/program';

const COMPUTE_STAGES: readonly TsrStage[] = [
  'dilate',
  'analyze',
  'resurrectGuide',
  'moire',
  'rejectFused',
  'spatial',
  'reconstruct',
];

const RASTER_STAGES: readonly TsrStage[] = [
  'dilate',
  'analyze',
  'resurrectGuide',
  'moireClamp',
  'moireMeasure',
  'moireUpdate',
  'moireHistory',
  'clamp',
  'measure',
  'resurrectClamp',
  'resurrectMeasure',
  'reject',
  'spatial',
  'reconstruct',
];

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

interface DrawOptions {
  readonly reactive?: number;
  readonly depth?: number;
  readonly motion?: number;
  readonly secondary?: number;
  readonly reset?: boolean;
  readonly deltaSeconds?: number;
  readonly exposure?: number;
  readonly opaquePixels?: readonly number[];
  readonly coverageReactive?: number;
  /** Per input pixel scene temporal tuples (x, y, z, w), overriding motion, depth and reactive. */
  readonly temporalPixels?: readonly number[];
  /** A resurrection source: the column-major current clip to snapshot clip matrix. */
  readonly clipToResurrectionClip?: readonly number[];
}

function encodeOpaqueFlickerLuma(pixels: readonly number[], exposure: number): number[] {
  const smcs = (c: number) => {
    const safe = Math.max(0, Math.min(65504, c * exposure));
    const g = safe / (safe + 0.17);
    return g * g;
  };
  const out: number[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    const mean = (smcs(pixels[i] ?? 0) + smcs(pixels[i + 1] ?? 0) + smcs(pixels[i + 2] ?? 0)) / 3;
    out.push(Math.sqrt(mean), 0, 0, 1);
  }
  return out;
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
  const activeStages = execution === 'compute' ? COMPUTE_STAGES : RASTER_STAGES;
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
      ? activeStages.map((stage) => createTsrProgram(frame, stage))
      : undefined;
  const raster =
    execution === 'raster'
      ? activeStages.map((stage) => createTsrRasterProgram(frame, stage))
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
  const opaque = surface('tsr-fixture-opaque', inputSize, TSR_ANALYSIS_FORMATS.opaque);
  const temporal = surface('tsr-fixture-scene-temporal', inputSize, 'rgba16float');
  const secondary = surface('tsr-fixture-secondary', outputSize, secondaryFormat);
  const decision = surface('tsr-fixture-rejection', inputSize, TSR_ANALYSIS_FORMATS.decision);
  const coverage = surface('tsr-fixture-coverage', outputSize, 'rgba16float');
  const resurrectionGuide = surface('tsr-fixture-resurrection-guide', inputSize, 'rgba16float');
  const resurrectionColor = surface('tsr-fixture-resurrection-color', outputSize, 'rgba16float');
  const resurrectionMetadata = surface(
    'tsr-fixture-resurrection-support',
    outputSize,
    'rgba8unorm',
  );
  const dilated = surface('tsr-fixture-dilated', inputSize, TSR_ANALYSIS_FORMATS.dilated);
  const dilateEdge = surface('tsr-fixture-dilate-edge', inputSize, TSR_ANALYSIS_FORMATS.dilateEdge);
  const decimate = surface('tsr-fixture-decimate', inputSize, TSR_ANALYSIS_FORMATS.decimate);
  const resurrected = surface('tsr-fixture-resurrected', inputSize, 'rgba16float');
  const resurrectedInput = surface(
    'tsr-fixture-resurrected-clamped-input',
    inputSize,
    'rgba16float',
  );
  const resurrectedHistory = surface(
    'tsr-fixture-resurrected-clamped-history',
    inputSize,
    'rgba16float',
  );
  const resurrectedEnergy = surface('tsr-fixture-resurrected-energy', inputSize, 'rgba16float');
  const resurrectedDelta = surface('tsr-fixture-resurrected-delta', inputSize, 'rgba16float');
  const inputGcs = surface('tsr-fixture-input-gcs', inputSize, 'rgba16float');
  const historyGcs = surface('tsr-fixture-history-gcs', inputSize, 'rgba16float');
  const clampedInput = surface('tsr-fixture-clamped-input', inputSize, 'rgba16float');
  const clampedHistory = surface('tsr-fixture-clamped-history', inputSize, 'rgba16float');
  const clampEnergy = surface('tsr-fixture-clamp-energy', inputSize, 'rgba16float');
  const clampDelta = surface('tsr-fixture-clamp-delta', inputSize, 'rgba16float');
  const spatial = surface('tsr-fixture-spatial', inputSize, TSR_ANALYSIS_FORMATS.spatial);
  const reprojectedMoire = surface(
    'tsr-fixture-reprojected-moire',
    inputSize,
    TSR_ANALYSIS_FORMATS.moire,
  );
  const moireField = surface('tsr-fixture-moire-field', inputSize, 'rgba16float');
  const moireRaw = surface('tsr-fixture-moire-raw', inputSize, 'rgba16float');
  const moireUpdate = surface('tsr-fixture-moire-update', inputSize, 'rgba16float');
  const moireError = surface('tsr-fixture-moire-error', inputSize, 'rgba16float');
  const histories = [0, 1].map((i) => ({
    color: surface(`tsr-fixture-color-${i}`, outputSize, 'rgba16float'),
    temporal: surface(`tsr-fixture-temporal-${i}`, outputSize, 'rgba16float'),
    metadata: surface(`tsr-fixture-support-${i}`, outputSize, 'rgba8unorm'),
    guide: surface(`tsr-fixture-guide-${i}`, inputSize, TSR_ANALYSIS_FORMATS.guide),
    moire: surface(`tsr-fixture-moire-${i}`, inputSize, TSR_ANALYSIS_FORMATS.moire),
  }));
  const params = device
    .createBuffer({ label: 'tsr-fixture-params', size: TSR_PARAMS_BYTES, usage: 64 | 8 })
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
          : new Uint8Array(pixels.map((v) => Math.max(0, Math.min(255, Math.round(v * 255)))));
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
  function uploadInputs(pixels: readonly number[], options: DrawOptions) {
    const exposure = options.exposure ?? 1;
    upload(color, pixels);
    upload(opaque, encodeOpaqueFlickerLuma(options.opaquePixels ?? pixels, exposure), 1);
    upload(
      temporal,
      options.temporalPixels ??
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
  }
  function writeParams(options: DrawOptions) {
    const data = new ArrayBuffer(TSR_PARAMS_BYTES),
      f = new Float32Array(data),
      u = new Uint32Array(data);
    f.set([0, 0, 0, 0, inputSize, 1, inputSize, 1]);
    f[14] = outputSize;
    f[15] = 1;
    u[8] = Number(index > 0 && !options.reset);
    u[9] = u[8] ?? 0;
    u[10] = index;
    u[11] = 1;
    u[12] = Number(options.coverageReactive !== undefined);
    f[13] = options.deltaSeconds ?? 1 / 60;
    // Perspective pixel radius (UE WorldDepthToPixelWorldRadius.x): a fixed small angle for the rig.
    f[16] = 0.001;
    const flicker = flickerTerms(f[13] ?? 0, inputSize);
    f[20] = flicker.invThreshold;
    f[21] = flicker.invMaxParallax;
    f[22] = options.exposure ?? 1;
    // A static camera: identity clip-to-previous-clip matrices and clip.w = view depth.
    for (const base of [24, 40]) for (let i = 0; i < 4; i++) f[base + i * 5] = 1;
    f.set([0, 0.1, -1, 0], 56);
    for (let i = 0; i < 4; i++) f[60 + i * 5] = 1;
    if (options.clipToResurrectionClip !== undefined) {
      f.set(options.clipToResurrectionClip, 60);
      u[76] = 1;
    }
    device.queue.writeBuffer(params, 0, new Uint8Array(data)).unwrap();
  }
  function draw(pixels: readonly number[], options: DrawOptions = {}) {
    const old = histories[readIndex],
      next = histories[1 - readIndex];
    if (!old || !next) throw new Error('missing feedback history');
    uploadInputs(pixels, options);
    writeParams(options);
    const analyzeReads = [
      color,
      dilated,
      old.guide,
      old.moire,
      old.temporal,
      options.coverageReactive === undefined ? temporal : coverage,
      dilateEdge,
    ];
    const reconstructReads = [
      color,
      dilated,
      old.color,
      old.temporal,
      old.metadata,
      decision,
      secondary,
      options.coverageReactive === undefined ? temporal : coverage,
      spatial,
      resurrectionColor,
      resurrectionMetadata,
      dilateEdge,
    ];
    const inputs: Surface[][] =
      execution === 'compute'
        ? [
            [temporal],
            analyzeReads,
            [dilated, resurrectionGuide],
            [opaque, reprojectedMoire, color, historyGcs, dilateEdge],
            [inputGcs, historyGcs, moireError, decimate, resurrected],
            [color, decision],
            reconstructReads,
          ]
        : [
            [temporal],
            analyzeReads,
            [dilated, resurrectionGuide],
            [opaque, reprojectedMoire, color],
            [moireField],
            [moireRaw, moireField, reprojectedMoire],
            [moireUpdate, moireField, reprojectedMoire, historyGcs, dilateEdge],
            [inputGcs, historyGcs],
            [inputGcs, clampedInput, clampedHistory, moireError],
            [inputGcs, resurrected],
            [inputGcs, resurrectedInput, resurrectedHistory],
            [
              inputGcs,
              historyGcs,
              clampEnergy,
              clampDelta,
              decimate,
              resurrected,
              resurrectedEnergy,
              resurrectedDelta,
            ],
            [color, decision],
            reconstructReads,
          ];
    const outputs: Surface[][] =
      execution === 'compute'
        ? [
            [dilated, dilateEdge],
            [inputGcs, historyGcs, reprojectedMoire, decimate],
            [resurrected],
            [next.moire, moireError],
            [next.guide, decision],
            [spatial],
            [next.color, next.temporal, next.metadata],
          ]
        : [
            [dilated, dilateEdge],
            [inputGcs, historyGcs, reprojectedMoire, decimate],
            [resurrected],
            [moireField],
            [moireRaw],
            [moireUpdate],
            [next.moire, moireError],
            [clampedInput, clampedHistory],
            [clampEnergy, clampDelta],
            [resurrectedInput, resurrectedHistory],
            [resurrectedEnergy, resurrectedDelta],
            [next.guide, decision],
            [spatial],
            [next.color, next.temporal, next.metadata],
          ];
    const encoder = device.createCommandEncoder().unwrap();
    for (let i = 0; i < activeStages.length; i++) {
      const stageName = activeStages[i];
      const program = programs[i],
        reads = inputs[i],
        writes = outputs[i];
      if (!stageName || !program || !reads || !writes) throw new Error('missing feedback stage');
      const nativeProgram = native?.[i],
        rasterProgram = raster?.[i];
      if (nativeProgram) {
        const wgSize = tsrStageWorkgroupSize(stageName);
        const pass = encoder.beginComputePass({
          label: `tsr-${stageName}`,
        });
        pass.setPipeline(nativeProgram.pipeline);
        pass.setBindGroup(0, group(nativeProgram, reads, writes));
        pass.dispatchWorkgroups(
          Math.ceil((i < activeStages.length - 1 ? inputSize : outputSize) / wgSize),
          1,
          1,
        );
        pass.end();
      } else if (rasterProgram) {
        const pass = encoder.beginRenderPass({
          label: `tsr-${stageName}`,
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
    /** Upload the persistent snapshot guide a resurrection reads. */
    uploadResurrectionGuide: (pixels: readonly number[]) => upload(resurrectionGuide, pixels),
    /** Upload the persistent snapshot color and stability metadata a resurrection reads. */
    uploadResurrectionHistory: (color: readonly number[], metadata: readonly number[]) => {
      upload(resurrectionColor, color);
      upload(resurrectionMetadata, metadata);
    },
    /** Dilate/decimate/rejection intermediates of the latest draw. */
    stages: {
      inputGcs,
      historyGcs,
      resurrected,
      dilated,
      dilateEdge,
      decimate,
      decision,
      spatial,
      reprojectedMoire,
      moireField,
      moireRaw,
      moireUpdate,
      moireError,
    },
    dispose() {
      for (const s of surfaces) device.destroyTexture(s.texture).unwrap();
      device.destroyBuffer(params).unwrap();
    },
  };
}
