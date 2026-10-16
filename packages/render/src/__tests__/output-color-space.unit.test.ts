import { readFileSync } from 'node:fs';
import { color } from '@forgeax/engine-math';
import type { CanvasConfiguration, RhiCanvasContext, RhiDevice } from '@forgeax/engine-rhi';
import { ok, RhiError } from '@forgeax/engine-rhi';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { displayP3, srgb } from '../materials';
import {
  isOutputColorSpace,
  OUTPUT_GAMUT_CODE,
  OUTPUT_GAMUT_WGSL_BEGIN,
  OUTPUT_GAMUT_WGSL_END,
  observeDisplayP3Configuration,
  renderOutputGamutWgsl,
} from '../output-color-space';
import { configureSurface } from '../render-system';
import { tonemapParams } from '../render-system-extract';

const webGpuDevice = {
  limits: { maxStorageBuffersPerShaderStage: 8 },
  caps: { backendKind: 'webgpu', storageBuffer: true },
} as unknown as RhiDevice;

function context(options: {
  readonly rejectWide?: boolean;
  readonly report?: (configured: CanvasConfiguration) => CanvasConfiguration | undefined;
}) {
  let last: CanvasConfiguration | undefined;
  const configure = vi.fn((configuration: CanvasConfiguration) => {
    if (options.rejectWide === true && configuration.colorSpace === 'display-p3') {
      return {
        ok: false as const,
        error: new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'supported colorSpace',
          hint: 'test rejection',
        }),
      };
    }
    last = configuration;
    return ok(undefined);
  });
  const value = {
    configure,
    getConfiguration: () =>
      last === undefined ? undefined : (options.report ?? ((configured) => configured))(last),
    presentationProof: { descriptor: true, acquisition: true, validation: true },
  } as unknown as RhiCanvasContext;
  return { value, configure };
}

describe('output color space SSOT', () => {
  it('keeps the checked-in WGSL gamut block generated from the math primaries', () => {
    const source = readFileSync(
      new URL('../../../shader/src/output-encoding.wgsl', import.meta.url),
      'utf8',
    );
    const begin = source.indexOf(OUTPUT_GAMUT_WGSL_BEGIN);
    const end = source.indexOf(OUTPUT_GAMUT_WGSL_END);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(source.slice(begin, end + OUTPUT_GAMUT_WGSL_END.length)).toBe(renderOutputGamutWgsl());
  });

  it('emits the row-major SSOT matrix as WGSL columns', () => {
    const block = renderOutputGamutWgsl();
    const m = color.LINEAR_SRGB_TO_LINEAR_DISPLAY_P3;
    const firstColumn = block.match(
      /LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 : mat3x3<f32> = mat3x3<f32>\(\n {2}vec3<f32>\(([^)]*)\)/,
    );
    const values = firstColumn?.[1]?.split(',').map(Number);
    expect(values).toHaveLength(3);
    expect(values?.[0]).toBeCloseTo(m[0] as number, 7);
    expect(values?.[1]).toBeCloseTo(m[3] as number, 7);
    expect(values?.[2]).toBeCloseTo(m[6] as number, 7);
  });

  it('packs the output gamut into the 32-byte TonemapParams layout with sRGB as zero', () => {
    expect(TONEMAP_PARAMS_LAYOUT.byteSize).toBe(32);
    expect(TONEMAP_PARAMS_LAYOUT.outputGamutOffset).toBe(16);
    expect(OUTPUT_GAMUT_CODE).toEqual({ srgb: 0, 'display-p3': 1 });
    const bytes = tonemapParams({
      exposure: 1,
      whitePoint: 1,
      tonemap: 'aces-filmic',
    } as Parameters<typeof tonemapParams>[0]);
    expect(bytes.byteLength).toBe(32);
    expect(
      new DataView(bytes.buffer).getUint32(TONEMAP_PARAMS_LAYOUT.outputGamutOffset, true),
    ).toBe(OUTPUT_GAMUT_CODE.srgb);
  });

  it('guards the closed union', () => {
    expect(isOutputColorSpace('srgb')).toBe(true);
    expect(isOutputColorSpace('display-p3')).toBe(true);
    expect(isOutputColorSpace('rec2020')).toBe(false);
    expect(isOutputColorSpace(undefined)).toBe(false);
  });

  it('authors Display P3 material colors as linear Rec.709 that round-trips', () => {
    expect(displayP3([1, 1, 1])).toEqual(srgb([1, 1, 1]).map((v) => expect.closeTo(v, 6)));
    const red = displayP3([1, 0, 0, 0.5]);
    expect(red[1]).toBeLessThan(0);
    expect(red[3]).toBe(0.5);
    const p3 = color.linearSrgbToLinearDisplayP3(color.create(), color.create(...red.slice(0, 3)));
    expect(p3[0]).toBeCloseTo(1, 5);
    expect(p3[1]).toBeCloseTo(0, 5);
    expect(p3[2]).toBeCloseTo(0, 5);
  });
});

describe('Display P3 surface negotiation', () => {
  it('omits colorSpace for sRGB exactly as before', () => {
    const { value, configure } = context({});
    const result = configureSurface(value, webGpuDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result).toEqual(ok({ status: 'applied', requested: 'srgb', effective: 'srgb' }));
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0]?.[0]).not.toHaveProperty('colorSpace');
  });

  it('applies display-p3 only when getConfiguration echoes it', () => {
    const { value, configure } = context({});
    const result = configureSurface(
      value,
      webGpuDevice,
      'bgra8unorm',
      'bgra8unorm-srgb',
      'display-p3',
    );
    expect(result).toEqual(
      ok({ status: 'applied', requested: 'display-p3', effective: 'display-p3' }),
    );
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0]?.[0]).toMatchObject({ colorSpace: 'display-p3' });
  });

  it('reports a structured fallback and reconfigures sRGB when the backend drops colorSpace', () => {
    const { value, configure } = context({
      report: ({ colorSpace: _dropped, ...rest }) => rest as CanvasConfiguration,
    });
    const result = configureSurface(
      value,
      webGpuDevice,
      'bgra8unorm',
      'bgra8unorm-srgb',
      'display-p3',
    );
    expect(result.ok && result.value).toMatchObject({
      status: 'fallback',
      requested: 'display-p3',
      effective: 'srgb',
      fallback: {
        code: 'canvas-color-space-unsupported',
        detail: { requested: 'display-p3', observed: 'color-space-absent' },
      },
    });
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure.mock.calls[1]?.[0]).not.toHaveProperty('colorSpace');
  });

  it('reports configure-rejected with the backend error code', () => {
    const { value, configure } = context({ rejectWide: true });
    const result = configureSurface(
      value,
      webGpuDevice,
      'bgra8unorm',
      'bgra8unorm-srgb',
      'display-p3',
    );
    expect(result.ok && result.value).toMatchObject({
      status: 'fallback',
      fallback: { detail: { observed: 'configure-rejected', reported: 'webgpu-runtime-error' } },
    });
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('classifies every observed configuration shape', () => {
    expect(observeDisplayP3Configuration(undefined)).toMatchObject({
      fallback: { detail: { observed: 'configuration-absent' } },
    });
    expect(observeDisplayP3Configuration({ colorSpace: 'srgb' })).toMatchObject({
      fallback: { detail: { observed: 'color-space-mismatch', reported: 'srgb' } },
    });
    expect(observeDisplayP3Configuration({ colorSpace: 'display-p3' })).toEqual({
      status: 'applied',
      requested: 'display-p3',
      effective: 'display-p3',
    });
  });
});
