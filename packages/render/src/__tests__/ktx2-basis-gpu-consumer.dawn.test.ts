import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  ktx2ColorSpace,
  parseKtx2,
  selectTranscodeTarget,
  transcodeBasis,
  transcodeKtx2,
} from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset, TranscodeCaps } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
} from '../../../codec/src/wasm/basis-types.js';
import { GpuResidencyCache } from '../device/gpu-residency.js';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage.js';

const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const ENCODER_WASM = new URL('../../../codec/pkg/encode/basis_encoder.wasm', import.meta.url);
const GPU_EVIDENCE_PATH = fileURLToPath(
  new URL('../../../../artifacts/format-tier1/ktx2-basis-gpu-evidence.json', import.meta.url),
);
const pkgBuilt = existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(ENCODER_WASM));
const FEATURE_ID = 'feat-20260812-format-classification-tier1';
const SOURCE_CODE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const AUTHORED_LDR_REFERENCE = Uint8Array.from(
  Array.from({ length: 4 * 4 }, () => [64, 128, 192, 255]).flat(),
);
const AUTHORED_HDR_REFERENCE = new Uint8Array(4 * 4 * 8);
for (let pixel = 0; pixel < 4 * 4; pixel += 1) {
  const view = new DataView(AUTHORED_HDR_REFERENCE.buffer, pixel * 8, 8);
  view.setUint16(0, 0, true);
  view.setUint16(2, 0, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0x3c00, true);
}

const capabilityArms = [
  [{ bc: false, etc2: false, astc: false }, 'rgba'],
  [{ bc: false, etc2: false, astc: true }, 'astc'],
  [{ bc: true, etc2: false, astc: false }, 'bc'],
  [{ bc: false, etc2: true, astc: false }, 'etc'],
  [{ bc: true, etc2: true, astc: true }, 'all'],
] as const;

type InputProfile = {
  readonly id: string;
  readonly container: 'ktx2' | 'basis';
  readonly model: 'etc1s' | 'uastc-ldr' | 'uastc-hdr';
  readonly colorSpace: 'srgb' | 'linear';
  readonly bytes: Uint8Array;
  readonly reference: Uint8Array;
  readonly referenceSource: string;
};

type GpuCell = {
  readonly source: string;
  readonly guid: string;
  readonly arm: string;
  readonly selected: string;
  readonly selection: 'selected' | 'fallback';
  readonly colorSpace: string;
  readonly status: 'pass' | 'unsupported' | 'error';
  readonly error?: { readonly code: string; readonly expected: string; readonly hint: string };
  readonly readbackBytes?: number;
  readonly normalized: {
    readonly status: 'pass' | 'unsupported' | 'error';
    readonly maxAbsError: number | null;
    readonly threshold: number;
    readonly verdict: 'pass' | 'unsupported' | 'error';
    readonly error?: { readonly code: string; readonly expected: string; readonly hint: string };
  };
  readonly reference: {
    readonly source: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
};

let inputs: readonly InputProfile[] = [];

beforeAll(async () => {
  if (!pkgBuilt) return;
  mkdirSync(dirname(GPU_EVIDENCE_PATH), { recursive: true });
  const encode = async (mode: 'etc1s' | 'uastc-ldr' | 'uastc-hdr'): Promise<Uint8Array> => {
    const result = await basisEncode(
      mode === 'uastc-hdr' ? AUTHORED_HDR_REFERENCE : AUTHORED_LDR_REFERENCE,
      {
        mode,
        width: 4,
        height: 4,
        srgb: mode !== 'uastc-hdr',
        perceptual: mode !== 'uastc-hdr',
        uastcSupercompression: mode === 'uastc-ldr',
        mipGen: false,
      },
    );
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const encoderFactory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const encoderModule = await encoderFactory({ locateFile: () => ENCODER_WASM.href });
  encoderModule.initializeBasis();
  const encoder = new encoderModule.BasisEncoder();
  let rawBasis: Uint8Array;
  try {
    encoder.setSliceSourceImage(0, AUTHORED_LDR_REFERENCE, 4, 4, 0);
    encoder.setCreateKTX2File(false);
    encoder.setFormatMode(encoderModule.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setPerceptual(false);
    encoder.setMipGen(false);
    const output = new Uint8Array(1 << 20);
    const length = encoder.encode(output);
    if (length <= 0) throw new Error('raw Basis encode failed');
    rawBasis = output.slice(0, length);
  } finally {
    encoder.delete();
  }
  inputs = [
    {
      id: 'ktx2-etc1s',
      container: 'ktx2',
      model: 'etc1s',
      colorSpace: 'srgb',
      bytes: await encode('etc1s'),
      reference: AUTHORED_LDR_REFERENCE,
      referenceSource: 'format-tier1-authored-4x4-rgba8-pattern-v1',
    },
    {
      id: 'ktx2-uastc-ldr',
      container: 'ktx2',
      model: 'uastc-ldr',
      colorSpace: 'srgb',
      bytes: await encode('uastc-ldr'),
      reference: AUTHORED_LDR_REFERENCE,
      referenceSource: 'format-tier1-authored-4x4-rgba8-pattern-v1',
    },
    {
      id: 'ktx2-uastc-hdr',
      container: 'ktx2',
      model: 'uastc-hdr',
      colorSpace: 'linear',
      bytes: await encode('uastc-hdr'),
      reference: AUTHORED_HDR_REFERENCE,
      referenceSource: 'format-tier1-authored-4x4-rgba16-pattern-v1',
    },
    {
      id: 'basis-uastc-ldr',
      container: 'basis',
      model: 'uastc-ldr',
      colorSpace: 'srgb',
      bytes: rawBasis,
      reference: AUTHORED_LDR_REFERENCE,
      referenceSource: 'format-tier1-authored-4x4-rgba8-pattern-v1',
    },
  ];
});

function guidFor(inputIndex: number, armIndex: number): string {
  return `40000000-0000-4000-8000-${String(inputIndex * 5 + armIndex + 1).padStart(12, '0')}`;
}

function referenceFor(input: InputProfile): GpuCell['reference'] {
  return {
    source: input.referenceSource,
    sha256: createHash('sha256').update(input.reference).digest('hex'),
    byteLength: input.reference.byteLength,
  };
}

function normalizedComparison(
  input: InputProfile,
  actual: Uint8Array | undefined,
  _format: string,
): GpuCell['normalized'] {
  const threshold = 0.05;
  if (actual === undefined) {
    return {
      status: 'unsupported',
      maxAbsError: null,
      threshold,
      verdict: 'unsupported',
      error: structuredError(
        'normalized-readback-unavailable',
        'the selected or fallback cell provides normalized RGBA8 GPU readback',
        'preserve the cell as unsupported when the device cannot sample the selected texture format',
      ),
    };
  }
  if (actual.byteLength !== input.reference.byteLength) {
    return {
      status: 'error',
      maxAbsError: null,
      threshold,
      verdict: 'error',
      error: structuredError(
        'normalized-reference-size-mismatch',
        'normalized image and source reference have the same byte length',
        `normalized=${actual.byteLength},reference=${input.reference.byteLength}`,
      ),
    };
  }
  let maxAbsError = 0;
  let observed = '';
  if (input.model === 'uastc-hdr') {
    const actualView = new DataView(actual.buffer, actual.byteOffset, actual.byteLength);
    const referenceView = new DataView(
      input.reference.buffer,
      input.reference.byteOffset,
      input.reference.byteLength,
    );
    observed = `; actualFirst=${[0, 2, 4, 6].map((offset) => halfToNumber(actualView.getUint16(offset, true))).join(',')}`;
    // UASTC HDR transcodes through RGB-only BC6H semantics; alpha is not preserved.
    for (let pixelOffset = 0; pixelOffset < actual.byteLength; pixelOffset += 8) {
      for (const channelOffset of [0, 2, 4]) {
        const offset = pixelOffset + channelOffset;
        maxAbsError = Math.max(
          maxAbsError,
          Math.abs(
            halfToNumber(actualView.getUint16(offset, true)) -
              halfToNumber(referenceView.getUint16(offset, true)),
          ),
        );
      }
    }
  } else {
    for (let index = 0; index < actual.byteLength; index += 1) {
      maxAbsError = Math.max(
        maxAbsError,
        Math.abs((actual[index] ?? 0) - (input.reference[index] ?? 0)) / 255,
      );
    }
  }
  const status = maxAbsError <= threshold ? 'pass' : 'error';
  return {
    status,
    maxAbsError,
    threshold,
    verdict: status,
    ...(status === 'error'
      ? {
          error: structuredError(
            'normalized-image-max-error',
            `normalized image maxAbsError <= ${threshold}`,
            `observed maxAbsError=${maxAbsError}${observed}`,
          ),
        }
      : {}),
  };
}

function halfToNumber(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function structuredError(code: string, expected: string, hint: string) {
  return { code, expected, hint };
}

function requiredCompressionFeature(format: string): GPUFeatureName | undefined {
  if (format.startsWith('bc')) return 'texture-compression-bc';
  if (format.startsWith('etc2')) return 'texture-compression-etc2';
  if (format.startsWith('astc')) return 'texture-compression-astc';
  return undefined;
}

async function textureFor(
  input: InputProfile,
  caps: TranscodeCaps,
): Promise<
  | { readonly ok: true; readonly texture: TextureAsset; readonly selected: GPUTextureFormat }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly expected: string; readonly hint: string };
    }
> {
  const selected = selectTranscodeTarget(
    { model: input.model, srgb: input.colorSpace === 'srgb', channels: 'rgba' },
    caps,
  );
  if (input.container === 'ktx2') {
    const parsed = await parseKtx2(input.bytes);
    if (!parsed.ok)
      return {
        ok: false,
        error: structuredError(parsed.error.code, 'real KTX2 parses', parsed.error.hint),
      };
    const colorSpace = ktx2ColorSpace(parsed.value);
    if (colorSpace !== input.colorSpace) {
      return {
        ok: false,
        error: structuredError(
          'image-color-space-mismatch',
          'DFD color space matches source Meta',
          'preserve the KTX2 DFD transfer function',
        ),
      };
    }
    const transcoded = await transcodeKtx2(parsed.value, selected);
    if (!transcoded.ok)
      return {
        ok: false,
        error: structuredError(
          transcoded.error.code,
          'real KTX2 transcodes to selected target',
          transcoded.error.hint,
        ),
      };
    const mip = transcoded.value.mips[0];
    if (mip === undefined)
      return {
        ok: false,
        error: structuredError(
          'transcode-failed',
          'real KTX2 returns mip 0',
          'keep the source mip chain intact',
        ),
      };
    return {
      ok: true,
      selected,
      texture: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: mip.width, height: mip.height } },
        format: selected,
        data: mip.data,
        colorSpace: input.colorSpace,
        mips: { kind: 'none' },
      },
    };
  }
  const transcoded = await transcodeBasis(input.bytes, selected);
  if (!transcoded.ok)
    return {
      ok: false,
      error: structuredError(
        transcoded.error.code,
        'real Basis transcodes to selected target',
        transcoded.error.hint,
      ),
    };
  const mip = transcoded.value.mips[0];
  if (mip === undefined)
    return {
      ok: false,
      error: structuredError(
        'transcode-failed',
        'real Basis returns mip 0',
        'keep the source mip chain intact',
      ),
    };
  return {
    ok: true,
    selected,
    texture: {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: mip.width, height: mip.height } },
      format: selected,
      data: mip.data,
      colorSpace: input.colorSpace,
      mips: { kind: 'none' },
    },
  };
}

async function readbackTexture(
  device: RhiDevice,
  texture: TextureAsset,
  gpuTexture: { readonly handle: Texture },
): Promise<Uint8Array> {
  const width = texture.shape.extent.width;
  const height = texture.shape.extent.height;
  const hdr = texture.format === 'rgba16float' || texture.format.startsWith('bc6h');
  const outputFormat: GPUTextureFormat = hdr ? 'rgba16float' : 'rgba8unorm-srgb';
  const outputBytesPerPixel = hdr ? 8 : 4;
  const shader = await createShaderModule(device, {
    label: 'ktx2-basis-normalize',
    code: `
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

@vertex fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vertex], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = vec2f(textureDimensions(source_texture));
  return textureSampleLevel(source_texture, source_sampler, position.xy / dimensions, 0.0);
}
`,
  });
  if (!shader.ok) throw new Error(`${shader.error.code}:${shader.error.hint}`);
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 0x2, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
    ],
  });
  if (!layout.ok) throw new Error(`${layout.error.code}:${layout.error.hint}`);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok)
    throw new Error(`${pipelineLayout.error.code}:${pipelineLayout.error.hint}`);
  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout.value as never,
    vertex: { module: shader.value as never, entryPoint: 'vs', buffers: [] },
    fragment: {
      module: shader.value as never,
      entryPoint: 'fs',
      targets: [{ format: outputFormat }],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipeline.ok) throw new Error(`${pipeline.error.code}:${pipeline.error.hint}`);
  const sourceView = device.createTextureView(gpuTexture.handle, {});
  if (!sourceView.ok) throw new Error(`${sourceView.error.code}:${sourceView.error.hint}`);
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
  if (!sampler.ok) throw new Error(`${sampler.error.code}:${sampler.error.hint}`);
  const bindings = device.createBindGroup({
    layout: layout.value,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: sourceView.value } },
      { binding: 1, resource: { kind: 'sampler', value: sampler.value } },
    ],
  });
  if (!bindings.ok) throw new Error(`${bindings.error.code}:${bindings.error.hint}`);
  const normalizedTexture = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: outputFormat,
    usage: 0x10 | 0x01,
  } as never);
  if (!normalizedTexture.ok)
    throw new Error(`${normalizedTexture.error.code}:${normalizedTexture.error.hint}`);
  const normalizedView = device.createTextureView(normalizedTexture.value, {});
  if (!normalizedView.ok)
    throw new Error(`${normalizedView.error.code}:${normalizedView.error.hint}`);
  const readback = device.createBuffer({
    size: 256 * height,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  if (!readback.ok) throw new Error(`${readback.error.code}:${readback.error.hint}`);
  const encoder = device.createCommandEncoder({ label: 'ktx2-basis-gpu-readback' });
  if (!encoder.ok) throw new Error(`${encoder.error.code}:${encoder.error.hint}`);
  const pass = encoder.value.beginRenderPass({
    colorAttachments: [
      {
        view: normalizedView.value as never,
        loadOp: 'clear',
        clearValue: [0, 0, 0, 0],
        storeOp: 'store',
      },
    ],
  });
  pass.setPipeline(pipeline.value);
  pass.setBindGroup(0, bindings.value);
  pass.draw(3, 1, 0, 0);
  pass.end();
  encoder.value.copyTextureToBuffer(
    { texture: normalizedTexture.value },
    {
      buffer: readback.value,
      offset: 0,
      bytesPerRow: 256,
      rowsPerImage: height,
    },
    { width, height, depthOrArrayLayers: 1 },
  );
  const command = encoder.value.finish();
  if (!command.ok) throw new Error(`${command.error.code}:${command.error.hint}`);
  const submitted = device.queue.submit([command.value]);
  if (!submitted.ok) throw new Error(`${submitted.error.code}:${submitted.error.hint}`);
  await device.queue.onSubmittedWorkDone();
  const mapped = await readback.value.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
  if (!mapped.ok) throw new Error(`${mapped.error.code}:${mapped.error.hint}`);
  const range = mapped.value.getMappedRange();
  if (!range.ok) throw new Error(`${range.error.code}:${range.error.hint}`);
  const mappedBytes = new Uint8Array(range.value);
  const bytes = new Uint8Array(width * height * outputBytesPerPixel);
  for (let row = 0; row < height; row += 1) {
    bytes.set(
      mappedBytes.subarray(row * 256, row * 256 + width * outputBytesPerPixel),
      row * width * outputBytesPerPixel,
    );
  }
  mapped.value.unmap();
  return bytes;
}

describe.skipIf(!pkgBuilt)('KTX2/Basis real GPU texture consumer matrix', () => {
  it('executes every real input and capability arm through GPU residency and readback', async () => {
    const adapter = await rhi.requestAdapter();
    if (!adapter.ok) {
      await writeFile(
        GPU_EVIDENCE_PATH,
        `${JSON.stringify({ schemaVersion: 'format-tier1-ktx2-gpu/1', featureId: FEATURE_ID, sourceCodeSha: SOURCE_CODE_SHA, status: 'blocked', rows: [], reason: structuredError(adapter.error.code, adapter.error.expected, adapter.error.hint) }, null, 2)}\n`,
        'utf8',
      );
      // biome-ignore lint/suspicious/noConsole: the real-device refusal is the matrix evidence
      console.log(
        JSON.stringify({
          status: 'blocked',
          reason: structuredError(adapter.error.code, adapter.error.expected, adapter.error.hint),
        }),
      );
      return;
    }
    const supportedCompressionFeatures = [
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
    ].filter((feature): feature is GPUFeatureName =>
      adapter.value.features.has(feature as GPUFeatureName),
    );
    const deviceResult = await adapter.value.requestDevice({
      requiredFeatures: supportedCompressionFeatures,
    });
    if (!deviceResult.ok) {
      await writeFile(
        GPU_EVIDENCE_PATH,
        `${JSON.stringify({ schemaVersion: 'format-tier1-ktx2-gpu/1', featureId: FEATURE_ID, sourceCodeSha: SOURCE_CODE_SHA, status: 'blocked', rows: [], reason: structuredError(deviceResult.error.code, deviceResult.error.expected, deviceResult.error.hint) }, null, 2)}\n`,
        'utf8',
      );
      // biome-ignore lint/suspicious/noConsole: the real-device refusal is the matrix evidence
      console.log(
        JSON.stringify({
          status: 'blocked',
          reason: structuredError(
            deviceResult.error.code,
            deviceResult.error.expected,
            deviceResult.error.hint,
          ),
        }),
      );
      return;
    }
    const device = deviceResult.value;
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device as never,
      undefined,
      (source, pod) => {
        if ('resolveAsset' in source) throw new Error('This fixture only allocates World assets');
        return ok(source.allocSharedRef('EquirectAsset', pod));
      },
      device.caps,
    );
    const rows: GpuCell[] = [];
    const world = new World();
    for (const [inputIndex, input] of inputs.entries()) {
      for (const [armIndex, [caps, arm]] of capabilityArms.entries()) {
        const guid = guidFor(inputIndex, armIndex);
        const selected = selectTranscodeTarget(
          { model: input.model, srgb: input.colorSpace === 'srgb', channels: 'rgba' },
          caps,
        );
        const selection = selected.startsWith('rgba') ? 'fallback' : 'selected';
        const reference = referenceFor(input);
        const result = await textureFor(input, caps);
        if (!result.ok) {
          rows.push({
            source: input.id,
            guid,
            arm,
            selected,
            selection,
            colorSpace: input.colorSpace,
            status: 'error',
            error: result.error,
            normalized: normalizedComparison(input, undefined, selected),
            reference,
          });
          continue;
        }
        const requiredFeature = requiredCompressionFeature(result.selected);
        if (requiredFeature !== undefined && !device.features.has(requiredFeature)) {
          const error = structuredError(
            'gpu-texture-format-feature-unavailable',
            `the physical GPU device exposes ${requiredFeature}`,
            `the ${arm} capability arm remains transcode-proven but cannot be sampled on this device`,
          );
          rows.push({
            source: input.id,
            guid,
            arm,
            selected,
            selection,
            colorSpace: input.colorSpace,
            status: 'unsupported',
            error,
            normalized: normalizedComparison(input, undefined, selected),
            reference,
          });
          continue;
        }
        const registry = new AssetRegistry({} as never);
        const parsedGuid = AssetGuid.parse(guid);
        if (!parsedGuid.ok) throw new Error('GPU matrix GUID construction failed');
        const catalog = registry.catalog(parsedGuid.value, result.texture);
        if (!catalog.ok) throw new Error(`GPU matrix catalog failed: ${catalog.error.code}`);
        const loaded = await registry.loadByGuid<TextureAsset>(parsedGuid.value);
        if (!loaded.ok) throw new Error(`GPU matrix loadByGuid failed: ${loaded.error.code}`);
        const handle = world.allocSharedRef('TextureAsset', loaded.value);
        const resident = store.ensureResident(handle, loaded.value);
        if (!resident.ok) {
          rows.push({
            source: input.id,
            guid,
            arm,
            selected,
            selection,
            colorSpace: input.colorSpace,
            status: 'unsupported',
            error: structuredError(
              resident.error.code,
              resident.error.expected,
              resident.error.hint,
            ),
            normalized: normalizedComparison(input, undefined, selected),
            reference,
          });
          continue;
        }
        const gpuTexture = store._getTextureGpuTexture(handle);
        if (gpuTexture === undefined) throw new Error('GPU matrix residency returned no texture');
        try {
          const readback = await readbackTexture(device, loaded.value, gpuTexture);
          const readbackBytes = readback.some((value) => value !== 0) ? readback.length : 0;
          const normalized = normalizedComparison(input, readback, result.texture.format);
          const status =
            readbackBytes > 0 && normalized.status === 'pass'
              ? 'pass'
              : normalized.status === 'unsupported'
                ? 'unsupported'
                : 'error';
          rows.push({
            source: input.id,
            guid,
            arm,
            selected,
            selection,
            colorSpace: input.colorSpace,
            status,
            readbackBytes,
            normalized,
            reference,
            ...(readbackBytes > 0 && normalized.status === 'pass'
              ? {}
              : {
                  error: structuredError(
                    readbackBytes === 0
                      ? 'readback-empty'
                      : (normalized.error?.code ?? 'normalized-image-not-proven'),
                    readbackBytes === 0
                      ? 'GPU texture readback contains uploaded source data'
                      : 'source/reference normalized image maxAbsError is within AC-06 threshold',
                    readbackBytes === 0
                      ? 'inspect the texture upload and copy path'
                      : (normalized.error?.hint ?? 'inspect the normalized image comparison'),
                  ),
                }),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          rows.push({
            source: input.id,
            guid,
            arm,
            selected,
            selection,
            colorSpace: input.colorSpace,
            status: 'unsupported',
            error: structuredError(
              'gpu-texture-consumer-refused',
              'the actual device accepts the selected texture format and copy path',
              detail,
            ),
            normalized: normalizedComparison(input, undefined, selected),
            reference,
          });
        }
      }
    }
    store.destroyAll();
    await writeFile(
      GPU_EVIDENCE_PATH,
      `${JSON.stringify({ schemaVersion: 'format-tier1-ktx2-gpu/1', featureId: FEATURE_ID, generatedAt: new Date().toISOString(), sourceCodeSha: SOURCE_CODE_SHA, status: 'complete', rows }, null, 2)}\n`,
      'utf8',
    );
    // biome-ignore lint/suspicious/noConsole: the twenty-cell matrix is the GPU evidence
    console.log(JSON.stringify({ status: 'complete', rows }));
    expect(rows).toHaveLength(20);
    expect(rows.filter((row) => row.status === 'error')).toEqual([]);
    expect(
      rows
        .filter((row) => row.status === 'unsupported')
        .every((row) => row.error?.code === 'gpu-texture-format-feature-unavailable'),
    ).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.source.length > 0 &&
          row.guid.length > 0 &&
          row.selected.length > 0 &&
          row.colorSpace.length > 0,
      ),
    ).toBe(true);
    expect(rows.every((row) => ['pass', 'unsupported', 'error'].includes(row.status))).toBe(true);
    expect(rows.every((row) => row.normalized?.status !== undefined)).toBe(true);
    expect(
      rows
        .filter((row) => row.normalized?.status !== 'pass')
        .every((row) => row.error?.code !== undefined && row.normalized?.error?.hint !== undefined),
    ).toBe(true);
  });
});
