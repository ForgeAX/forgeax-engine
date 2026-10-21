import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RhiDevice, Texture, TextureFormat, TextureView } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';

const WIDTH = 9;
const HEIGHT = 9;
const SECONDARY_SIZE = 7;
const READBACK_ROW_BYTES = 256;
const HALF_BYTES_PER_PIXEL = 8;
const ATTACHMENT_READBACK_BYTES = READBACK_ROW_BYTES * HEIGHT;
const PINNED_BASELINE_SHA256 = '4a7a7c7def9cb860da2a92ad960aa6be1d41d6c6551e0e77093cd5d2cc99ea9d';
const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

const H = {
  zero: 0x0000,
  eighth: 0x3000,
  quarter: 0x3400,
  half: 0x3800,
  threeQuarter: 0x3a00,
  one: 0x3c00,
  two: 0x4000,
  four: 0x4400,
  negEighth: 0xb000,
  negQuarter: 0xb400,
  negOne: 0xbc00,
  negMotion: 0x9800,
  motion: 0x1800,
} as const;

type Surface = {
  readonly texture: Texture;
  readonly view: TextureView;
};

type ResolveParams = {
  readonly jitterX: number;
  readonly jitterY: number;
  readonly historyValid: boolean;
  readonly frameIndex: number;
  readonly hasSecondary: boolean;
};

type ResolveCase = {
  readonly name: string;
  readonly internalSize?: number;
  readonly secondarySourceSize?: { readonly width: number; readonly height: number };
  readonly secondaryRowsSize?: { readonly width: number; readonly height: number };
  readonly secondaryFormat?: 'r32float' | 'rgba8unorm';
  readonly currentCoverage?: Uint16Array;
  readonly currentColor: Uint16Array;
  readonly historyColor: Uint16Array;
  readonly currentTemporal: Uint16Array;
  readonly historyTemporal: Uint16Array;
  readonly historyStability: Uint8Array;
  readonly secondaryReactivity: Float32Array;
  readonly params: ResolveParams;
};

type Attachments = {
  readonly color: Uint8Array;
  readonly temporal: Uint8Array;
  readonly stability: Uint8Array;
};

type Pair = {
  readonly baseline: Attachments;
  readonly production: Attachments;
};

function rgbaGrid(
  sample: (x: number, y: number) => readonly [number, number, number, number],
): Uint16Array {
  const values = new Uint16Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      values.set(sample(x, y), (y * WIDTH + x) * 4);
    }
  }
  return values;
}

function temporalGrid(
  sample: (x: number, y: number) => readonly [number, number, number, number],
): Uint16Array {
  return rgbaGrid(sample);
}

function byteGrid(value: number): Uint8Array {
  return new Uint8Array(WIDTH * HEIGHT).fill(value);
}

function secondaryGrid(width = SECONDARY_SIZE, height = SECONDARY_SIZE): Float32Array {
  return new Float32Array(width * height);
}

function rgba8Reactivity(values: Float32Array): Uint8Array {
  const rgba = new Uint8Array(values.length * 4);
  values.forEach((value, index) => {
    rgba[index * 4] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    rgba[index * 4 + 3] = 255;
  });
  return rgba;
}

function constantColor(value: readonly [number, number, number, number]): Uint16Array {
  return rgbaGrid(() => value);
}

function constantTemporal(value: readonly [number, number, number, number]): Uint16Array {
  return temporalGrid(() => value);
}

function replaceRequired(source: string, from: string, to: string, label: string): string {
  const replaced = source.replace(from, to);
  if (replaced === source) throw new Error(`Missing pinned mutation anchor: ${label}`);
  return replaced;
}

function sourceWithoutImportPath(source: string): string {
  return source.replace(/^#define_import_path.*$/gm, '');
}

function createSurface(
  device: RhiDevice,
  label: string,
  width: number,
  height: number,
  format: TextureFormat,
  usage: number,
): Surface {
  const texture = device
    .createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      textureBindingViewDimension: '2d',
      usage,
    })
    .unwrap();
  return {
    texture,
    view: device.createTextureView(texture, { label: `${label}.view`, dimension: '2d' }).unwrap(),
  };
}

function upload(
  device: RhiDevice,
  surface: Surface,
  width: number,
  height: number,
  data: ArrayBufferView,
  bytesPerRow: number,
): void {
  device.queue
    .writeTexture(
      { texture: surface.texture },
      data,
      { bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    )
    .unwrap();
}

function outputPayload(bytes: Uint8Array, slot: number, bytesPerPixel: number): Uint8Array {
  const payload = new Uint8Array(WIDTH * HEIGHT * bytesPerPixel);
  const base = slot * ATTACHMENT_READBACK_BYTES;
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = base + y * READBACK_ROW_BYTES;
    payload.set(
      bytes.subarray(rowStart, rowStart + WIDTH * bytesPerPixel),
      y * WIDTH * bytesPerPixel,
    );
  }
  return payload;
}

function pixelHalfQuad(bytes: Uint8Array, x: number, y: number): number[] {
  const offset = (y * WIDTH + x) * HALF_BYTES_PER_PIXEL;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, HALF_BYTES_PER_PIXEL);
  return Array.from({ length: 4 }, (_, i) => view.getUint16(i * 2, true));
}

function differs(left: Uint8Array, right: Uint8Array): boolean {
  return left.length !== right.length || left.some((value, index) => value !== right[index]);
}

function makeCases(): readonly ResolveCase[] {
  const movingCurrent = rgbaGrid((x, y) => {
    switch ((x + y * 2) % 4) {
      case 0:
        return [H.one, H.zero, H.zero, H.one];
      case 1:
        return [H.zero, H.one, H.zero, H.one];
      case 2:
        return [H.zero, H.zero, H.one, H.one];
      default:
        return [H.half, H.half, H.half, H.one];
    }
  });
  const movingTemporal = constantTemporal([H.motion, H.negMotion, H.one, H.zero]);
  // Keep the patterned moving case above for the byte-parity matrix. This
  // impulse is reserved for the negative gate: at output pixel (4, 4), the
  // center remains black while the +x sample (5, 4) is the only red support.
  const movingImpulseCurrent = rgbaGrid((x, y) =>
    x === 5 && y === 4 ? [H.one, H.zero, H.zero, H.one] : [H.zero, H.zero, H.zero, H.one],
  );

  const settledCurrent = rgbaGrid((x, y) =>
    x === WIDTH - 3 && y === HEIGHT - 3
      ? [H.one, H.zero, H.zero, H.one]
      : [H.zero, H.zero, H.zero, H.one],
  );
  const settledTemporal = constantTemporal([H.zero, H.zero, H.one, H.zero]);

  const secondary = secondaryGrid();
  // Place a finite reactive sentinel and a NaN on the top edge at the target's
  // center columns. The baseline's y=-3 tap reaches them from secondary center
  // (3, 3), while the mutated y=-2 loop cannot reach that interior edge row
  // without clamping. The finite sentinel keeps this gate deterministic even
  // on a backend that canonicalizes NaN texture writes.
  secondary[3] = 1.0;
  secondary[4] = Number.NaN;

  const tieCurrentTemporal = constantTemporal([H.zero, H.zero, H.negOne, H.zero]);
  tieCurrentTemporal.set([H.zero, H.zero, H.four, H.zero], (4 * WIDTH + 4) * 4);
  tieCurrentTemporal.set([H.eighth, H.quarter, H.two, H.quarter], (3 * WIDTH + 3) * 4);
  tieCurrentTemporal.set([H.negEighth, H.negQuarter, H.two, H.threeQuarter], (5 * WIDTH + 5) * 4);
  tieCurrentTemporal.set([H.zero, H.zero, H.two, H.zero], (4 * WIDTH + 3) * 4);

  const stationaryHistory = constantColor([H.one, H.one, H.one, H.one]);
  const stationaryTemporal = constantTemporal([H.zero, H.zero, H.one, H.zero]);
  const zeroSecondary = secondaryGrid();

  const historyRejectCurrent = rgbaGrid((x, y) => [
    x % 3 === 0 ? H.one : H.zero,
    y % 3 === 0 ? H.one : H.zero,
    H.half,
    H.one,
  ]);
  // Keep the fragment safely above the exact half-UV boundary: interpolation
  // can otherwise center a 16-row source at row 7 instead of 8. Row 11 is
  // the source +3 edge; a 32-row copy still maps its window to rows 6..9.
  const resizeUpSource = secondaryGrid(SECONDARY_SIZE, 16);
  resizeUpSource[11 * SECONDARY_SIZE + 3] = 1;
  // A 32-row source centers at row 16. The old footprint includes row 14,
  // while the 16-row copy maps its center window to odd source rows only.
  const resizeDownSource = secondaryGrid(SECONDARY_SIZE, 32);
  resizeDownSource[14 * SECONDARY_SIZE + 3] = 1;
  const rgba8SameExtentSource = secondaryGrid();
  rgba8SameExtentSource[3 * SECONDARY_SIZE + 3] = 0.5;

  return [
    {
      name: 'moving-3x3-negative-jitter-image-edge',
      currentColor: movingCurrent,
      historyColor: constantColor([H.half, H.quarter, H.threeQuarter, H.one]),
      currentTemporal: movingTemporal,
      historyTemporal: constantTemporal([H.zero, H.zero, H.one, H.zero]),
      historyStability: byteGrid(0),
      secondaryReactivity: zeroSecondary,
      params: {
        jitterX: -0.28 / WIDTH,
        jitterY: 0.23 / HEIGHT,
        historyValid: true,
        frameIndex: 23,
        hasSecondary: false,
      },
    },
    {
      name: 'moving-3x3-unique-positive-x-impulse',
      currentColor: movingImpulseCurrent,
      historyColor: constantColor([H.one, H.zero, H.zero, H.one]),
      currentTemporal: movingTemporal,
      historyTemporal: constantTemporal([H.zero, H.zero, H.one, H.zero]),
      historyStability: byteGrid(0),
      secondaryReactivity: zeroSecondary,
      params: {
        jitterX: 0,
        jitterY: 0,
        historyValid: true,
        frameIndex: 23,
        hasSecondary: false,
      },
    },
    {
      name: 'settled-5x5-positive-jitter-image-edge',
      currentColor: settledCurrent,
      historyColor: stationaryHistory,
      currentTemporal: settledTemporal,
      historyTemporal: stationaryTemporal,
      // Age 32 enters the settled 5x5 path while leaving clipping responsive
      // enough that a missing +/-2 corner changes the stored color bytes.
      historyStability: byteGrid(31),
      secondaryReactivity: zeroSecondary,
      params: {
        jitterX: 0.27 / WIDTH,
        jitterY: -0.19 / HEIGHT,
        historyValid: true,
        frameIndex: 200,
        hasSecondary: false,
      },
    },
    {
      name: 'secondary-reactivity-7x7-nan-boundary',
      currentColor: constantColor([H.zero, H.zero, H.zero, H.one]),
      historyColor: stationaryHistory,
      currentTemporal: stationaryTemporal,
      historyTemporal: stationaryTemporal,
      historyStability: byteGrid(255),
      secondaryReactivity: secondary,
      params: {
        jitterX: 0,
        jitterY: 0,
        historyValid: true,
        frameIndex: 200,
        hasSecondary: true,
      },
    },
    {
      name: 'closest-depth-edge-equal-depth-tie-order',
      currentColor: constantColor([H.half, H.half, H.half, H.one]),
      historyColor: constantColor([H.threeQuarter, H.quarter, H.half, H.one]),
      currentTemporal: tieCurrentTemporal,
      historyTemporal: constantTemporal([H.zero, H.zero, H.two, H.zero]),
      historyStability: byteGrid(8),
      secondaryReactivity: zeroSecondary,
      params: {
        jitterX: 0,
        jitterY: 0,
        historyValid: true,
        frameIndex: 64,
        hasSecondary: false,
      },
    },
    {
      name: 'history-reject-positive-jitter-image-edge',
      currentColor: historyRejectCurrent,
      historyColor: stationaryHistory,
      currentTemporal: stationaryTemporal,
      historyTemporal: stationaryTemporal,
      historyStability: byteGrid(255),
      secondaryReactivity: zeroSecondary,
      params: {
        jitterX: 0.23 / WIDTH,
        jitterY: 0.23 / HEIGHT,
        historyValid: false,
        frameIndex: 128,
        hasSecondary: false,
      },
    },
    {
      name: 'secondary-reactivity-rgba8-to-r8-same-extent',
      secondaryFormat: 'rgba8unorm',
      currentColor: constantColor([H.zero, H.zero, H.zero, H.one]),
      historyColor: stationaryHistory,
      currentTemporal: stationaryTemporal,
      historyTemporal: stationaryTemporal,
      historyStability: byteGrid(255),
      secondaryReactivity: rgba8SameExtentSource,
      params: {
        jitterX: 0,
        jitterY: 0,
        historyValid: true,
        frameIndex: 200,
        hasSecondary: true,
      },
    },
    {
      name: 'secondary-reactivity-source-16-rows-32-edge-tap',
      secondarySourceSize: { width: SECONDARY_SIZE, height: 16 },
      secondaryRowsSize: { width: SECONDARY_SIZE, height: 32 },
      secondaryFormat: 'rgba8unorm',
      currentColor: constantColor([H.zero, H.zero, H.zero, H.one]),
      historyColor: stationaryHistory,
      currentTemporal: stationaryTemporal,
      historyTemporal: stationaryTemporal,
      historyStability: byteGrid(255),
      secondaryReactivity: resizeUpSource,
      params: {
        jitterX: 0,
        jitterY: 0.0001,
        historyValid: true,
        frameIndex: 200,
        hasSecondary: true,
      },
    },
    {
      name: 'secondary-reactivity-source-32-rows-16-edge-tap',
      secondarySourceSize: { width: SECONDARY_SIZE, height: 32 },
      secondaryRowsSize: { width: SECONDARY_SIZE, height: 16 },
      currentColor: constantColor([H.zero, H.zero, H.zero, H.one]),
      historyColor: stationaryHistory,
      currentTemporal: stationaryTemporal,
      historyTemporal: stationaryTemporal,
      historyStability: byteGrid(255),
      secondaryReactivity: resizeDownSource,
      params: {
        jitterX: 0,
        // Keep the 7x7 edge tap inside one producer texel, away from interpolation rounding.
        jitterY: 0.25 / 32,
        historyValid: true,
        frameIndex: 200,
        hasSecondary: true,
      },
    },
  ];
}

async function runPair(
  device: RhiDevice,
  baselineSource: string,
  productionSource: string,
  testCase: ResolveCase,
): Promise<Pair> {
  const internalSize = testCase.internalSize ?? WIDTH;
  const secondarySourceSize = testCase.secondarySourceSize ?? {
    width: SECONDARY_SIZE,
    height: SECONDARY_SIZE,
  };
  const secondaryRowsSize = testCase.secondaryRowsSize ?? secondarySourceSize;
  const secondaryFormat = testCase.secondaryFormat ?? 'r32float';
  const secondaryRowsFormat = secondaryFormat === 'rgba8unorm' ? 'r8unorm' : 'r32float';
  const sourceUsage = GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING;
  const outputUsage = GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT;
  const colorSampler = device
    .createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    })
    .unwrap();
  const temporalSampler = device
    .createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'nearest',
      minFilter: 'nearest',
    })
    .unwrap();

  const currentColor = createSurface(
    device,
    'taa-equivalence-current-color',
    internalSize,
    internalSize,
    'rgba16float',
    sourceUsage,
  );
  const historyColor = createSurface(
    device,
    'taa-equivalence-history-color',
    WIDTH,
    HEIGHT,
    'rgba16float',
    sourceUsage,
  );
  const historyTemporal = createSurface(
    device,
    'taa-equivalence-history-temporal',
    WIDTH,
    HEIGHT,
    'rgba16float',
    sourceUsage,
  );
  const currentTemporal = createSurface(
    device,
    'taa-equivalence-current-temporal',
    internalSize,
    internalSize,
    'rgba16float',
    sourceUsage,
  );
  const currentCoverage = createSurface(
    device,
    'taa-equivalence-current-coverage',
    WIDTH,
    HEIGHT,
    'rgba16float',
    sourceUsage,
  );
  const historyStability = createSurface(
    device,
    'taa-equivalence-history-stability',
    WIDTH,
    HEIGHT,
    'r8unorm',
    sourceUsage,
  );
  const secondaryReactivity = createSurface(
    device,
    'taa-equivalence-secondary-reactivity',
    secondarySourceSize.width,
    secondarySourceSize.height,
    secondaryFormat,
    sourceUsage,
  );
  const baselineOutputs = [
    createSurface(
      device,
      'taa-equivalence-baseline-color',
      WIDTH,
      HEIGHT,
      'rgba16float',
      outputUsage,
    ),
    createSurface(
      device,
      'taa-equivalence-baseline-temporal',
      WIDTH,
      HEIGHT,
      'rgba16float',
      outputUsage,
    ),
    createSurface(
      device,
      'taa-equivalence-baseline-stability',
      WIDTH,
      HEIGHT,
      'r8unorm',
      outputUsage,
    ),
  ] as const;
  const productionOutputs = [
    createSurface(
      device,
      'taa-equivalence-production-color',
      WIDTH,
      HEIGHT,
      'rgba16float',
      outputUsage,
    ),
    createSurface(
      device,
      'taa-equivalence-production-temporal',
      WIDTH,
      HEIGHT,
      'rgba16float',
      outputUsage,
    ),
    createSurface(
      device,
      'taa-equivalence-production-stability',
      WIDTH,
      HEIGHT,
      'r8unorm',
      outputUsage,
    ),
  ] as const;
  // Sources that declare the row entry consume their Renderer row copy.
  const secondaryRows = createSurface(
    device,
    'taa-equivalence-secondary-rows',
    secondaryRowsSize.width,
    secondaryRowsSize.height,
    secondaryRowsFormat,
    outputUsage | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  const surfaces: readonly Surface[] = [
    secondaryRows,
    currentColor,
    historyColor,
    historyTemporal,
    currentTemporal,
    currentCoverage,
    historyStability,
    secondaryReactivity,
    ...baselineOutputs,
    ...productionOutputs,
  ];
  const params = device
    .createBuffer({
      label: 'taa-equivalence-params',
      size: 32,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      label: 'taa-equivalence-readback',
      size: ATTACHMENT_READBACK_BYTES * 6,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  try {
    upload(
      device,
      currentColor,
      internalSize,
      internalSize,
      testCase.currentColor,
      internalSize * 8,
    );
    upload(device, historyColor, WIDTH, HEIGHT, testCase.historyColor, WIDTH * 8);
    upload(device, historyTemporal, WIDTH, HEIGHT, testCase.historyTemporal, WIDTH * 8);
    upload(
      device,
      currentTemporal,
      internalSize,
      internalSize,
      testCase.currentTemporal,
      internalSize * 8,
    );
    upload(device, historyStability, WIDTH, HEIGHT, testCase.historyStability, WIDTH);
    upload(
      device,
      currentCoverage,
      WIDTH,
      HEIGHT,
      testCase.currentCoverage ?? testCase.historyTemporal,
      WIDTH * 8,
    );
    upload(
      device,
      secondaryReactivity,
      secondarySourceSize.width,
      secondarySourceSize.height,
      secondaryFormat === 'rgba8unorm'
        ? rgba8Reactivity(testCase.secondaryReactivity)
        : testCase.secondaryReactivity,
      secondarySourceSize.width * 4,
    );
    const payload = new ArrayBuffer(32);
    new Float32Array(payload).set([testCase.params.jitterX, testCase.params.jitterY]);
    const words = new Uint32Array(payload);
    words[2] = Number(testCase.params.historyValid);
    words[3] = testCase.params.frameIndex;
    words[4] = Number(testCase.params.hasSecondary);
    words[5] = Number(testCase.currentCoverage !== undefined);
    words[6] = 1;
    device.queue.writeBuffer(params, 0, new Uint8Array(payload)).unwrap();

    const inputLayout = device
      .createBindGroupLayout({
        label: 'taa-equivalence-input-layout',
        entries: [
          ...[0, 2, 9].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
          })),
          ...[4, 6, 10, 11, 12].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
          })),
          ...[1, 3].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' as const },
          })),
          ...[5, 7].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'non-filtering' as const },
          })),
          {
            binding: 8,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' as const },
          },
        ],
      })
      .unwrap();
    const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pipelineLayout = device
      .createPipelineLayout({ bindGroupLayouts: [emptyLayout, inputLayout] })
      .unwrap();
    const rowsLayout = device
      .createBindGroupLayout({
        label: 'taa-equivalence-rows-layout',
        entries: [
          {
            binding: 10,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const rowsPipelineLayout = device
      .createPipelineLayout({ bindGroupLayouts: [emptyLayout, rowsLayout] })
      .unwrap();
    const createPipeline = device.createRenderPipelineAsync?.bind(device);
    if (createPipeline === undefined)
      throw new Error('Dawn requires validated async render pipelines');
    const makePipeline = async (source: string, label: string) => {
      const module = createShaderModuleImmediate(device, {
        label,
        code: sourceWithoutImportPath(source),
      }).unwrap();
      const rows = source.includes('fn fs_secondary_reactivity_rows')
        ? (
            await createPipeline({
              label: `${label}-rows-pipeline`,
              layout: rowsPipelineLayout,
              vertex: { module, entryPoint: 'vs_main', buffers: [] },
              fragment: {
                module,
                entryPoint: 'fs_secondary_reactivity_rows',
                targets: [{ format: secondaryRowsFormat }],
              },
              primitive: { topology: 'triangle-list' },
            })
          ).unwrap()
        : undefined;
      const resolve = (
        await createPipeline({
          label: `${label}-pipeline`,
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'vs_main', buffers: [] },
          fragment: {
            module,
            entryPoint: 'fs_main',
            targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'r8unorm' }],
          },
          primitive: { topology: 'triangle-list' },
        })
      ).unwrap();
      return { rows, resolve };
    };
    const baselinePipeline = await makePipeline(baselineSource, 'taa-equivalence-baseline');
    const productionPipeline = await makePipeline(productionSource, 'taa-equivalence-production');
    const makeInputGroup = (secondary: TextureView, source: TextureView) =>
      device
        .createBindGroup({
          label: 'taa-equivalence-input-group',
          layout: inputLayout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: currentColor.view } },
            { binding: 1, resource: { kind: 'sampler', value: colorSampler } },
            { binding: 2, resource: { kind: 'textureView', value: historyColor.view } },
            { binding: 3, resource: { kind: 'sampler', value: colorSampler } },
            { binding: 4, resource: { kind: 'textureView', value: historyTemporal.view } },
            { binding: 5, resource: { kind: 'sampler', value: temporalSampler } },
            { binding: 6, resource: { kind: 'textureView', value: currentTemporal.view } },
            { binding: 7, resource: { kind: 'sampler', value: temporalSampler } },
            { binding: 8, resource: { kind: 'buffer', value: { buffer: params } } },
            { binding: 9, resource: { kind: 'textureView', value: historyStability.view } },
            { binding: 10, resource: { kind: 'textureView', value: secondary } },
            // Ordinary TAA does not allocate an output-domain coverage target.
            // The production resolve still declares the stable binding and uses
            // this current-temporal fallback while hasCurrentCoverage is zero.
            {
              binding: 11,
              resource: {
                kind: 'textureView',
                value:
                  testCase.currentCoverage === undefined
                    ? currentTemporal.view
                    : currentCoverage.view,
              },
            },
            { binding: 12, resource: { kind: 'textureView', value: source } },
          ],
        })
        .unwrap();
    const rawInputGroup = makeInputGroup(secondaryReactivity.view, secondaryReactivity.view);
    const rowsInputGroup = makeInputGroup(secondaryRows.view, secondaryReactivity.view);
    const emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
    const rowsGroup = device
      .createBindGroup({
        layout: rowsLayout,
        entries: [
          { binding: 10, resource: { kind: 'textureView', value: secondaryReactivity.view } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder({ label: 'taa-equivalence-pair' }).unwrap();
    const fullscreen = (
      pipeline: typeof baselinePipeline.resolve,
      group: typeof rowsGroup,
      outputs: readonly Surface[],
    ) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: outputs.map(({ view }) => ({
          view,
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, emptyGroup);
      pass.setBindGroup(1, group);
      pass.draw(3, 1, 0, 0);
      pass.end();
    };
    const draw = (pipeline: typeof baselinePipeline, outputs: readonly Surface[]) => {
      if (pipeline.rows === undefined) {
        fullscreen(pipeline.resolve, rawInputGroup, outputs);
        return;
      }
      fullscreen(pipeline.rows, rowsGroup, [secondaryRows]);
      fullscreen(pipeline.resolve, rowsInputGroup, outputs);
    };
    draw(baselinePipeline, baselineOutputs);
    draw(productionPipeline, productionOutputs);
    const allOutputs = [...baselineOutputs, ...productionOutputs];
    allOutputs.forEach((output, slot) => {
      encoder.copyTextureToBuffer(
        { texture: output.texture },
        {
          buffer: readback,
          offset: slot * ATTACHMENT_READBACK_BYTES,
          bytesPerRow: READBACK_ROW_BYTES,
          rowsPerImage: HEIGHT,
        },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
    });
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return {
      baseline: {
        color: outputPayload(bytes, 0, 8),
        temporal: outputPayload(bytes, 1, 8),
        stability: outputPayload(bytes, 2, 1),
      },
      production: {
        color: outputPayload(bytes, 3, 8),
        temporal: outputPayload(bytes, 4, 8),
        stability: outputPayload(bytes, 5, 1),
      },
    };
  } finally {
    device.destroyBuffer(params).unwrap();
    device.destroyBuffer(readback).unwrap();
    for (const surface of surfaces) device.destroyTexture(surface.texture).unwrap();
  }
}

describe('TAA neighborhood equivalence on Dawn', () => {
  it.skipIf(!dawnReady)(
    'preserves all MRT bytes with Renderer-selected native and reduced geometry',
    async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const selected = replaceRequired(
        source,
        `  // The Renderer binds output geometry or current internal geometry here once.
  return textureLoad(currentOutputTemporal, pixel, 0);`,
        `  if (params.hasOutputTemporal != 0u) {
    return textureLoad(currentOutputTemporal, pixel, 0);
  }
  return textureLoad(currentTemporal, pixel, 0);`,
        'original per-sample texture selection',
      );
      const branched = replaceRequired(
        selected,
        'let temporalDimensions = vec2<i32>(textureDimensions(currentOutputTemporal));',
        'let temporalDimensions = select(vec2<i32>(textureDimensions(currentTemporal)), vec2<i32>(textureDimensions(currentOutputTemporal)), params.hasOutputTemporal != 0u);',
        'original geometry dimensions',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const testCase = makeCases()[3];
      if (testCase === undefined) throw new Error('missing stationary case');
      const coverage = temporalGrid((x, y) => {
        if ((x === 1 && y === 1) || (x === 3 && y === 3))
          return [H.negMotion, H.motion, H.half, H.eighth];
        if ((x === 7 && y === 7) || (x === 5 && y === 5))
          return [H.motion, H.negMotion, H.half, H.quarter];
        if (x === 0 || y === HEIGHT - 1) return [H.zero, H.zero, H.one, H.zero];
        return [H.zero, H.zero, H.negOne, H.one];
      });
      for (const internalSize of [4, 6, 7]) {
        for (const age of [64, 128]) {
          const pair = await runPair(device, branched, source, {
            ...testCase,
            internalSize,
            currentCoverage: coverage,
            currentColor: Uint16Array.from({ length: internalSize * internalSize * 4 }, (_, i) =>
              i % 4 === 3 ? H.one : i % 3 === 0 ? H.quarter : H.threeQuarter,
            ),
            currentTemporal: Uint16Array.from(
              { length: internalSize * internalSize * 4 },
              (_, i) => (i % 4 === 2 ? H.negOne : H.zero),
            ),
            historyStability: byteGrid(age),
            secondaryReactivity: secondaryGrid(),
            params: { ...testCase.params, hasSecondary: false },
          });
          for (const attachment of ['color', 'temporal', 'stability'] as const)
            expect(
              Array.from(pair.production[attachment]),
              `${internalSize}/${age}/${attachment}`,
            ).toEqual(Array.from(pair.baseline[attachment]));
        }
      }
    },
  );
  it.skipIf(!dawnReady).each(['initial', 'background', 'disocclusion'] as const)(
    'preserves all three attachments when skipping rejected history work (%s)',
    async (reason) => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const start = source.indexOf('  // Rejected history contributes neither');
      const end = source.indexOf('  let history = sampleTaaHistory', start);
      if (start < 0 || end < 0) throw new Error('missing rejected-history fast path');
      const fullWork = source.slice(0, start) + source.slice(end);
      const testCase = makeCases()[0];
      if (!testCase) throw new Error('missing rejection case');
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      for (const internalSize of [4, WIDTH]) {
        const pair = await runPair(device, fullWork, source, {
          ...testCase,
          internalSize,
          currentColor: new Uint16Array(internalSize * internalSize * 4).fill(H.one),
          currentTemporal: new Uint16Array(internalSize * internalSize * 4).fill(H.one),
          currentCoverage: constantTemporal([
            H.zero,
            H.zero,
            reason === 'background' ? H.negOne : H.one,
            H.zero,
          ]),
          historyTemporal: constantTemporal([
            H.zero,
            H.zero,
            reason === 'disocclusion' ? H.negOne : H.one,
            H.zero,
          ]),
          historyStability: byteGrid(170),
          secondaryReactivity: secondaryGrid(),
          params: {
            ...testCase.params,
            historyValid: reason !== 'initial',
            hasSecondary: false,
            jitterX: 0,
            jitterY: 0,
          },
        });
        for (const attachment of ['color', 'temporal', 'stability'] as const)
          expect(Array.from(pair.production[attachment])).toEqual(
            Array.from(pair.baseline[attachment]),
          );
        expect(Array.from(pair.production.stability)).toEqual(Array(WIDTH * HEIGHT).fill(0));
      }
    },
  );
  it
    .skipIf(!dawnReady)
    .each(
      [4, WIDTH].flatMap((internalSize) =>
        [H.zero, H.motion].map((priorMotion) => ({ internalSize, priorMotion })),
      ),
    )(
    'uses local stationary age after a late stop (size=$internalSize, prior motion=$priorMotion)',
    async ({ internalSize, priorMotion }) => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const testCase = makeCases()[0];
      if (!testCase) throw new Error('missing stationary case');
      const prefixStart = source.indexOf('  if (length(temporal.xy) < 1e-5 && temporal.w == 0.0');
      const prefixEnd = source.indexOf('  // Depth is a disocclusion gate', prefixStart);
      if (prefixStart < 0 || prefixEnd < 0) throw new Error('missing local-age recovery');
      const legacy = source.slice(0, prefixStart) + source.slice(prefixEnd);
      const pair = await runPair(device, legacy, source, {
        ...testCase,
        internalSize,
        currentColor: Uint16Array.from({ length: internalSize * internalSize * 4 }, (_, i) =>
          i % 4 === 3 || Math.floor(i / 4) % 4 === 1 ? H.one : H.zero,
        ),
        ...(internalSize < WIDTH
          ? { currentCoverage: constantTemporal([H.zero, H.zero, H.one, H.zero]) }
          : {}),
        currentTemporal: constantTemporal([H.zero, H.zero, H.one, H.zero]),
        historyColor: constantColor([H.half, H.half, H.half, H.one]),
        historyTemporal: constantTemporal([priorMotion, H.zero, H.one, H.zero]),
        historyStability: byteGrid(0),
        params: {
          ...testCase.params,
          frameIndex: 200,
          jitterX: 0,
          jitterY: 0,
          historyValid: true,
          hasSecondary: false,
        },
      });
      // Independent Karis recurrence: current 0, history .5, local sample count
      // one gives weight .5 and result .2. Global frame 200 must not give .95.
      const value = pixelHalfQuad(pair.production.color, 4, 4)[0];
      expect(value).toBeGreaterThanOrEqual(0x3265);
      expect(value).toBeLessThanOrEqual(0x3267);
      expect(pixelHalfQuad(pair.baseline.color, 4, 4)[0]).toBeGreaterThan(0x3700);
    },
  );

  it.skipIf(!dawnReady)(
    'integrates the actual reduced jitter sample without pre-spreading its footprint',
    async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const bilinear = replaceRequired(
        source,
        'let current = textureLoad(currentColor, sourcePixel, 0);',
        'let current = textureSampleLevel(currentColor, currentSampler, currentUv, 0.0);',
        'TAAU pre-spread falsifier',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const testCase = makeCases()[3];
      if (!testCase) throw new Error('missing stationary case');
      const currentColor = Uint16Array.from({ length: 4 * 4 * 4 }, (_, i) =>
        i % 4 === 3 || (i % 4 === 0 && Math.floor(i / 4) % 4 >= 2) ? H.one : H.zero,
      );
      const pair = await runPair(device, bilinear, source, {
        ...testCase,
        internalSize: 4,
        currentColor,
        currentCoverage: constantTemporal([H.zero, H.zero, H.one, H.zero]),
        currentTemporal: new Uint16Array(4 * 4 * 4),
        params: { ...testCase.params, historyValid: false, hasSecondary: false },
      });
      expect(pixelHalfQuad(pair.production.color, 4, 4)).toEqual([H.one, H.zero, H.zero, H.one]);
      expect(pixelHalfQuad(pair.baseline.color, 4, 4)).toEqual([H.half, H.zero, H.zero, H.one]);
    },
  );
  it.skipIf(!dawnReady)(
    'does not prefilter native textured current before integration',
    async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const filtered = replaceRequired(
        source,
        'let current = textureLoad(currentColor, sourcePixel, 0);',
        'let current = textureSampleLevel(currentColor, currentSampler, currentUv, 0.0);',
        'native texture prefilter falsifier',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const testCase = makeCases()[0];
      if (!testCase) throw Error('missing native case');
      const pair = await runPair(device, filtered, source, {
        ...testCase,
        currentColor: rgbaGrid((x) => [x >= 5 ? H.one : H.zero, H.zero, H.zero, H.one]),
        params: {
          ...testCase.params,
          historyValid: false,
          hasSecondary: false,
          jitterX: 0.25 / WIDTH,
          jitterY: 0,
        },
      });
      expect(pixelHalfQuad(pair.production.color, 4, 4)).toEqual([H.zero, H.zero, H.zero, H.one]);
      expect(pixelHalfQuad(pair.baseline.color, 4, 4)).toEqual([H.quarter, H.zero, H.zero, H.one]);
    },
  );
  it.skipIf(!dawnReady)(
    'retains thin-line history inside reconstruction support and rejects absent coverage',
    async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const testCase = makeCases()[3];
      if (testCase === undefined) throw new Error('missing stationary case');
      const coverage = temporalGrid((x, y) =>
        x === 5 && y === 4 ? [H.zero, H.zero, H.one, H.zero] : [H.zero, H.zero, H.negOne, H.one],
      );
      const pair = await runPair(device, source, source, {
        ...testCase,
        internalSize: 4,
        currentCoverage: coverage,
        currentColor: new Uint16Array(4 * 4 * 4).fill(H.one),
        currentTemporal: Uint16Array.from({ length: 4 * 4 * 4 }, (_, i) =>
          i % 4 === 2 ? H.negOne : H.zero,
        ),
        historyStability: byteGrid(64),
        secondaryReactivity: secondaryGrid(),
        params: { ...testCase.params, hasSecondary: false },
      });
      expect(pair.production.stability[4 * WIDTH + 4]).toBe(65);
      expect(pair.production.stability[0]).toBe(0);
      expect(pair.production.stability[4 * WIDTH + 1]).toBe(0);
    },
  );
  it.skipIf(!dawnReady).each([4, 6, 7])(
    'reads spatially varying output-domain stability with a %s/9 internal lattice',
    async (internalSize) => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const testCase = makeCases()[3];
      if (testCase === undefined) throw new Error('missing stationary case');
      const ages = Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => i);
      const pair = await runPair(device, source, source, {
        ...testCase,
        internalSize,
        historyStability: ages,
        secondaryReactivity: secondaryGrid(),
        params: { ...testCase.params, hasSecondary: false },
      });
      expect(
        Array.from(pair.production.stability),
        'each output pixel must advance its own reprojected age',
      ).toEqual(Array.from(ages, (age) => age + 1));
    },
  );

  it.skipIf(!dawnReady)(
    'matches pinned pre-optimization bounds with identical reconstruction and blend policy on all three MRT attachments',
    async () => {
      const productionSource = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const baselineSource = readFileSync(
        resolve(import.meta.dirname, 'fixtures/taa-resolve-pinned-baseline.wgsl'),
        'utf8',
      );
      const baselineBody = baselineSource.split('\n').slice(4).join('\n');
      // Isolate neighborhood optimization from intentional reconstruction and
      // Three r184 blend-policy changes. The dedicated behavior GPU test owns
      // the motion equation; both sides here use it while the pinned bounds and
      // their falsifiers stay immutable.
      let pairedBaseline = replaceRequired(
        baselineSource,
        'let current = textureSampleLevel(currentColor, currentSampler, currentUv, 0.0);',
        'let sourcePixel = clamp(vec2<i32>(currentUv * vec2<f32>(dimensions)), vec2<i32>(0), dimensions - vec2<i32>(1));\n  let current = textureLoad(currentColor, sourcePixel, 0);',
        'shared point reconstruction',
      );

      const motionHelper = productionSource.match(/fn taaMotionCurrentWeight\([\s\S]*?\n}/)?.[0];
      if (motionHelper === undefined) throw new Error('Missing production motion policy');
      pairedBaseline += `\n${motionHelper}\n`;
      pairedBaseline = replaceRequired(
        pairedBaseline,
        'let velocityFactor = 1.0 - clamp(length(temporal.xy) * 64.0, 0.0, 1.0);',
        'let velocityFactor = select(1.0, 1.0 - taaMotionCurrentWeight(temporal.xy, vec2<f32>(dimensions), false), length(temporal.xy) > 1e-7);',
        'shared native motion policy',
      );
      pairedBaseline = replaceRequired(
        pairedBaseline,
        'let historyWeight = progressiveWeight * reactiveFactor * velocityFactor;',
        'let historyWeight = min(progressiveWeight, velocityFactor) * reactiveFactor;',
        'shared motion-history composition',
      );

      pairedBaseline = replaceRequired(
        pairedBaseline,
        'let progressiveWeight = taaAccumulationWeight(params.temporalFrameIndex, steadyWeight);',
        `var progressiveWeight = taaAccumulationWeight(params.temporalFrameIndex, steadyWeight);
  if (length(temporal.xy) < 1e-5 && temporal.w == 0.0 && stableAge < TAA_STABILITY_FRAMES) {
    progressiveWeight = min(progressiveWeight, taaAccumulationWeight(u32(max(stableAge, 1.0)), steadyWeight));
  }`,
        'shared local stop accumulation policy',
      );

      expect(createHash('sha256').update(baselineBody).digest('hex')).toBe(PINNED_BASELINE_SHA256);
      const deviceResult = await rhi.requestAdapter();
      expect(deviceResult.ok).toBe(true);
      if (!deviceResult.ok) return;
      const deviceResultValue = await deviceResult.value.requestDevice();
      expect(deviceResultValue.ok).toBe(true);
      if (!deviceResultValue.ok) return;
      const device = deviceResultValue.value;
      for (const testCase of makeCases()) {
        const pair = await runPair(device, pairedBaseline, productionSource, testCase);
        for (const attachment of ['color', 'temporal', 'stability'] as const) {
          expect(
            Array.from(pair.production[attachment]),
            `${testCase.name}/${attachment} must match pinned baseline`,
          ).toEqual(Array.from(pair.baseline[attachment]));
        }
        if (testCase.name === 'closest-depth-edge-equal-depth-tie-order') {
          expect(pixelHalfQuad(pair.production.temporal, 4, 4)).toEqual([
            H.eighth,
            H.quarter,
            H.two,
            H.quarter,
          ]);
        }
        if (testCase.name === 'secondary-reactivity-7x7-nan-boundary') {
          expect(pixelHalfQuad(pair.production.color, 4, 4)).toEqual([
            H.zero,
            H.zero,
            H.zero,
            H.one,
          ]);
        }
        if (
          testCase.name === 'secondary-reactivity-source-16-rows-32-edge-tap' ||
          testCase.name === 'secondary-reactivity-source-32-rows-16-edge-tap'
        ) {
          expect(pixelHalfQuad(pair.production.color, 4, 4)).toEqual([
            H.zero,
            H.zero,
            H.zero,
            H.one,
          ]);
        }
      }
    },
  );

  it.skipIf(!dawnReady)(
    'falsifies resized row copies evaluated on a different physical texel lattice',
    async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../../shader/src/taa-resolve.wgsl'),
        'utf8',
      );
      const wrongLattice = replaceRequired(
        source,
        'params.hasSecondaryRows != 0u && all(size == sourceSize)',
        'params.hasSecondaryRows != 0u',
        'physical row lattice guard',
      );
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      for (const name of [
        'secondary-reactivity-source-16-rows-32-edge-tap',
        'secondary-reactivity-source-32-rows-16-edge-tap',
      ]) {
        const testCase = makeCases().find((candidate) => candidate.name === name);
        if (testCase === undefined) throw new Error(`Missing resize case: ${name}`);
        const pair = await runPair(device, source, wrongLattice, testCase);
        expect(pixelHalfQuad(pair.baseline.color, 4, 4), name).toEqual([
          H.zero,
          H.zero,
          H.zero,
          H.one,
        ]);
        expect(differs(pair.baseline.color, pair.production.color), name).toBe(true);
      }
    },
  );

  it.skipIf(!dawnReady)(
    'falsifies omitted neighborhood taps, secondary boundaries, depth tie order, and history rejection on the GPU',
    async () => {
      const baselineSource = readFileSync(
        resolve(import.meta.dirname, 'fixtures/taa-resolve-pinned-baseline.wgsl'),
        'utf8',
      );
      const deviceResult = await rhi.requestAdapter();
      expect(deviceResult.ok).toBe(true);
      if (!deviceResult.ok) return;
      const deviceResultValue = await deviceResult.value.requestDevice();
      expect(deviceResultValue.ok).toBe(true);
      if (!deviceResultValue.ok) return;
      const device = deviceResultValue.value;
      const cases = makeCases();
      const caseNamed = (name: string): ResolveCase => {
        const testCase = cases.find((candidate) => candidate.name === name);
        if (testCase === undefined) throw new Error(`missing TAA falsifier case: ${name}`);
        return testCase;
      };
      const mutations: readonly [string, ResolveCase, string][] = [
        [
          'moving 3x3 tap',
          caseNamed('moving-3x3-unique-positive-x-impulse'),
          replaceRequired(
            baselineSource,
            'if (!settled && (any(abs(delta) > vec2<i32>(1)) || all(delta == vec2<i32>(0)))) {',
            'if (!settled && (any(abs(delta) > vec2<i32>(1)) || all(delta == vec2<i32>(0)) || (delta.x == 1 && delta.y == 0))) {',
            'moving tap',
          ),
        ],
        [
          'settled 5x5 corner',
          caseNamed('settled-5x5-positive-jitter-image-edge'),
          replaceRequired(
            baselineSource,
            'if (!settled && (any(abs(delta) > vec2<i32>(1)) || all(delta == vec2<i32>(0)))) {',
            'if ((!settled && (any(abs(delta) > vec2<i32>(1)) || all(delta == vec2<i32>(0)))) || (settled && all(delta == vec2<i32>(2, 2)))) {',
            'settled corner',
          ),
        ],
        [
          'secondary 7x7 boundary',
          caseNamed('secondary-reactivity-7x7-nan-boundary'),
          replaceRequired(
            baselineSource,
            'for (var y = -3; y <= 3; y++) {',
            'for (var y = -2; y <= 3; y++) {',
            'secondary boundary',
          ),
        ],
        [
          'depth equal tie order',
          caseNamed('closest-depth-edge-equal-depth-tie-order'),
          replaceRequired(
            baselineSource,
            'if (candidate.z >= 0.0 && (closest.z < 0.0 || candidate.z < closest.z)) {',
            'if (candidate.z >= 0.0 && (closest.z < 0.0 || candidate.z <= closest.z)) {',
            'depth tie',
          ),
        ],
        [
          'history reject',
          caseNamed('history-reject-positive-jitter-image-edge'),
          replaceRequired(
            baselineSource,
            'params.historyValid == 0u',
            'params.historyValid == 999u',
            'history reject',
          ),
        ],
      ];
      for (const [label, testCase, omittedSource] of mutations) {
        const pair = await runPair(device, baselineSource, omittedSource, testCase);
        const changed = (['color', 'temporal', 'stability'] as const).some((attachment) =>
          differs(pair.baseline[attachment], pair.production[attachment]),
        );
        expect(changed, `${label} omission must change a real GPU attachment`).toBe(true);
      }
    },
  );
});
