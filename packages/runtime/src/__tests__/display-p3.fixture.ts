import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { color } from '@forgeax/engine-math';
import {
  Camera,
  displayP3,
  Materials,
  MeshFilter,
  MeshRenderer,
  type OutputColorSpace,
  type OutputColorSpaceReport,
  type Renderer,
  srgb,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
  type WorkInspection,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };

export const DISPLAY_P3_SIZE = 64;
/** One 8-bit step of dither plus one of float rounding. */
export const DISPLAY_P3_EPSILON = 2;

export type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
type Rgb = readonly [number, number, number];

export interface Quadrant {
  readonly name: string;
  /** Colour space in which `encoded` is authored (sRGB transfer for both). */
  readonly authored: OutputColorSpace;
  readonly encoded: Rgb;
  readonly center: readonly [number, number];
  readonly pixel: readonly [number, number];
}

/** Top-left, top-right, bottom-left, bottom-right; the P3 pair lies outside Rec.709. */
export const QUADRANTS: readonly Quadrant[] = [
  {
    name: 'srgb-gray',
    authored: 'srgb',
    encoded: [0.5, 0.5, 0.5],
    center: [-1, 1],
    pixel: [16, 16],
  },
  {
    name: 'srgb-green',
    authored: 'srgb',
    encoded: [0.2, 0.7, 0.3],
    center: [1, 1],
    pixel: [48, 16],
  },
  {
    name: 'p3-green',
    authored: 'display-p3',
    encoded: [0.2, 0.8, 0.3],
    center: [-1, -1],
    pixel: [16, 48],
  },
  {
    name: 'p3-red',
    authored: 'display-p3',
    encoded: [0.9, 0.2, 0.1],
    center: [1, -1],
    pixel: [48, 48],
  },
];

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Linear Rec.709 working colour the material stores for a quadrant. */
export function linearWorking(quadrant: Quadrant): Rgb {
  const tuple =
    quadrant.authored === 'srgb' ? srgb([...quadrant.encoded]) : displayP3([...quadrant.encoded]);
  return [tuple[0] ?? 0, tuple[1] ?? 0, tuple[2] ?? 0];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Reference Output Transform in TS, derived from the same math SSOT as the WGSL block. */
export function expectedBytes(quadrant: Quadrant, output: OutputColorSpace): Rgb {
  const working = color.create(...linearWorking(quadrant));
  const gamut =
    output === 'display-p3' ? color.linearSrgbToLinearDisplayP3(color.create(), working) : working;
  const clipped = color.create(
    clamp01(gamut[0] ?? 0),
    clamp01(gamut[1] ?? 0),
    clamp01(gamut[2] ?? 0),
  );
  const encoded = color.linearToSrgb(color.create(), clipped);
  return [
    Math.round((encoded[0] ?? 0) * 255),
    Math.round((encoded[1] ?? 0) * 255),
    Math.round((encoded[2] ?? 0) * 255),
  ];
}

export function pixelAt(rgba: Uint8Array, [x, y]: readonly [number, number]): Rgb {
  const i = (y * DISPLAY_P3_SIZE + x) * 4;
  return [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0];
}

export function maxError(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Decode 8-bit Display-P3 bytes back into linear Rec.709 working colour. */
export function decodeDisplayP3Bytes(bytes: Rgb): Rgb {
  const linear = color.displayP3ToLinear(
    color.create(),
    color.create(bytes[0] / 255, bytes[1] / 255, bytes[2] / 255),
  );
  return [linear[0] ?? 0, linear[1] ?? 0, linear[2] ?? 0];
}

export interface PixelCheck {
  readonly name: string;
  readonly actual: Rgb;
  readonly expected: Rgb;
  readonly error: number;
}

export function checkPixels(rgba: Uint8Array, output: OutputColorSpace): PixelCheck[] {
  return QUADRANTS.map((quadrant) => {
    const actual = pixelAt(rgba, quadrant.pixel);
    const expected = expectedBytes(quadrant, output);
    return { name: quadrant.name, actual, expected, error: maxError(actual, expected) };
  });
}

function toRgba(bytes: Uint8Array, bytesPerRow: number, format: string | undefined): Uint8Array {
  const size = DISPLAY_P3_SIZE;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const src = y * bytesPerRow + x * 4;
      const dst = (y * size + x) * 4;
      rgba.set(bytes.subarray(src, src + 4), dst);
      if (format?.startsWith('bgra'))
        [rgba[dst], rgba[dst + 2]] = [rgba[dst + 2] ?? 0, rgba[dst] ?? 0];
    }
  return rgba;
}

export function createDisplayP3Scene(renderer: Renderer, errors: unknown[]) {
  const world = new World();
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  for (const quadrant of QUADRANTS) {
    const [r, g, b] = linearWorking(quadrant);
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([r, g, b, 1]));
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [quadrant.center[0], quadrant.center[1], 0], scale: [1.9, 1.9, 0.5] },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          top: 2,
          bottom: -2,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: 0,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  const draw = async () => {
    propagateTransforms(world);
    world.update(1 / 60).unwrap();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    return receipt;
  };
  const readFinal = async () => {
    if (!renderer.requestObservation) throw new Error('observation unavailable');
    value(renderer.requestObservation(['final-display']));
    const receipt = await draw();
    const observations = value(
      await renderer.observe(receipt, { include: ['final-display'] }),
    ).observations;
    const live = observations?.find((item) => item.domain === 'final-display');
    if (live?.domain !== 'final-display') throw new Error('missing final-display observation');
    return {
      rgba: toRgba(live.bytes, live.metadata.bytesPerRow, live.metadata.format),
      colorSpace: live.colorSpace,
    };
  };
  return {
    world,
    draw,
    readFinal,
    dispose() {
      unsubscribe();
      lease.dispose();
    },
  };
}

export function outputReport(renderer: Renderer): OutputColorSpaceReport {
  return renderer.inspect().output.colorSpace;
}

const json = (data: unknown) => new TextEncoder().encode(JSON.stringify(data, null, 2));

export interface JourneyResult {
  readonly report: OutputColorSpaceReport;
  readonly rgba: Uint8Array;
  readonly checks: readonly PixelCheck[];
}

/**
 * A static scene through the production World -> Renderer path, then one observed
 * frame whose bytes must match the reference transform of the effective
 * colour space. `effective` is what the surface actually honoured.
 */
export async function runDisplayP3Journey(
  renderer: Renderer,
  effective: OutputColorSpace,
  save: Save,
  prefix: string,
): Promise<JourneyResult> {
  const errors: unknown[] = [];
  const scene = createDisplayP3Scene(renderer, errors);
  try {
    for (let i = 0; i < testQuality.staticFrames; i++) await scene.draw();
    const report = outputReport(renderer);
    expect(report.effective).toBe(effective);
    const { rgba, colorSpace } = await scene.readFinal();
    expect(colorSpace).toBe(effective);
    const checks = checkPixels(rgba, effective);
    await save(`${prefix}.rgba`, rgba);
    await save(
      `${prefix}.json`,
      json({ report, observationColorSpace: colorSpace, checks, errors }),
    );
    for (const check of checks)
      expect(check.error, check.name).toBeLessThanOrEqual(DISPLAY_P3_EPSILON);
    expect(errors).toEqual([]);
    return { report, rgba, checks };
  } finally {
    scene.dispose();
  }
}

/**
 * The falsifier: a P3 surface image must NOT match the sRGB reference on the
 * wide-gamut quadrants (and the neutral stays identical), and P3 bytes decode
 * back to the authored working colour.
 */
export function falsifyDisplayP3(rgba: Uint8Array) {
  const wrongGamut = checkPixels(rgba, 'srgb');
  const roundTrip = QUADRANTS.map((quadrant) => {
    const decoded = decodeDisplayP3Bytes(pixelAt(rgba, quadrant.pixel));
    const working = linearWorking(quadrant);
    return {
      name: quadrant.name,
      decoded,
      working,
      error: Math.max(...decoded.map((v, i) => Math.abs(v - (working[i] ?? 0)))),
    };
  });
  const wide = wrongGamut.filter((check) => check.name.startsWith('p3-'));
  for (const check of wide) expect(check.error, check.name).toBeGreaterThan(8 * DISPLAY_P3_EPSILON);
  const neutral = wrongGamut.find((check) => check.name === 'srgb-gray');
  expect(neutral?.error).toBeLessThanOrEqual(DISPLAY_P3_EPSILON);
  // P3-authored colours re-encode to their authored 8-bit values.
  for (const quadrant of QUADRANTS.filter((q) => q.authored === 'display-p3')) {
    const authored = quadrant.encoded.map((v) => Math.round(v * 255)) as unknown as Rgb;
    expect(maxError(pixelAt(rgba, quadrant.pixel), authored), quadrant.name).toBeLessThanOrEqual(
      DISPLAY_P3_EPSILON,
    );
  }
  for (const entry of roundTrip) expect(entry.error, entry.name).toBeLessThan(0.02);
  return { wrongGamut, roundTrip };
}

/** Runtime reconfiguration: switch the same renderer to sRGB and back. */
export async function switchOutputColorSpace(
  renderer: Renderer,
  wide: OutputColorSpace,
  save: Save,
) {
  const errors: unknown[] = [];
  const scene = createDisplayP3Scene(renderer, errors);
  const steps: {
    target: OutputColorSpace;
    report: OutputColorSpaceReport;
    checks: PixelCheck[];
  }[] = [];
  try {
    for (const target of ['srgb', wide] as const) {
      value(renderer.setOutputColorSpace(target));
      for (let i = 0; i < 3; i++) await scene.draw();
      const report = outputReport(renderer);
      expect(report.requested).toBe(target);
      const { rgba, colorSpace } = await scene.readFinal();
      expect(colorSpace).toBe(report.effective);
      const checks = checkPixels(rgba, report.effective);
      for (const check of checks)
        expect(check.error, `${target}:${check.name}`).toBeLessThanOrEqual(DISPLAY_P3_EPSILON);
      steps.push({ target, report, checks });
    }
    // Closed union guard: invalid values are structured errors, not silent.
    const invalid = renderer.setOutputColorSpace('rec2020' as OutputColorSpace);
    expect(invalid.ok).toBe(false);
    expect(errors).toEqual([]);
    await save('switch.json', json({ steps, invalid: invalid.ok ? null : invalid.error }));
    return steps;
  } finally {
    scene.dispose();
  }
}

/**
 * RHI Debug: capture one P3 frame, confirm the tape carries the surface colour
 * space, replay on a fresh device, read the Output Transform uniform, and
 * compare replayed output pixels with the live observation.
 */
export async function captureDisplayP3(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  replayDevices: GPUDevice[],
) {
  const errors: unknown[] = [];
  const scene = createDisplayP3Scene(renderer, errors);
  try {
    for (let i = 0; i < 4; i++) await scene.draw();
    if (!renderer.requestObservation) throw new Error('observation unavailable');
    value(renderer.requestObservation(['final-display']));
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await scene.draw();
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    await save('frame.rhitape', capture.bytes);
    const observations = value(
      await renderer.observe(receipt, { include: ['final-display'] }),
    ).observations;
    const live = observations?.find((item) => item.domain === 'final-display');
    if (live?.domain !== 'final-display') throw new Error('missing live final-display');
    const liveRgba = toRgba(live.bytes, live.metadata.bytesPerRow, live.metadata.format);
    const tape = decodeTape(capture.bytes).unwrap();
    const canvasColorSpace = (tape.header.rhiCaps as { canvasColorSpace?: string })
      .canvasColorSpace;
    expect(canvasColorSpace).toBe('display-p3');
    const model = buildFrameModel(tape);
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const rawReplayDevice = webgpu._internal_getRawDevice(device);
    if (rawReplayDevice === undefined) throw new Error('replay WebGPU device unavailable');
    // The caller releases this borrowed device after the live Renderer is done.
    replayDevices.push(rawReplayDevice);
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      let output: { workIndex: number; colorId: string; inspected: WorkInspection } | undefined;
      for (const work of [...model.works].reverse()) {
        const colorId = work.attachments?.colorViewHandleIds[0];
        if (colorId == null) continue;
        const candidate = (
          await replay.inspectWork(work.workIndex, ['pipeline', 'bindings'])
        ).unwrap();
        const fragment = candidate.pipeline?.shaders.find((shader) => shader.stage === 'fragment');
        if (fragment?.source?.includes('LINEAR_SRGB_TO_LINEAR_DISPLAY_P3')) {
          output = { workIndex: work.workIndex, colorId, inspected: candidate };
          break;
        }
      }
      if (output === undefined) throw new Error('no Output Transform work in tape');
      const inspected = output.inspected;
      const binding = inspected.bindings?.find(
        (entry) => entry.groupIndex === 1 && entry.binding === 2,
      );
      if (binding?.resourceId == null) throw new Error('TonemapParams binding missing');
      const offset = (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0);
      const uniform = (
        await replay.readResourceAtWork(binding.resourceId, output.workIndex, { offset, size: 32 })
      ).unwrap();
      const view = new DataView(uniform.bytes.buffer, uniform.bytes.byteOffset, 32);
      const params = {
        exposure: view.getFloat32(0, true),
        whitePoint: view.getFloat32(4, true),
        mode: view.getUint32(8, true),
        ditherEnabled: view.getFloat32(12, true),
        outputGamut: view.getUint32(16, true),
      };
      expect(params.outputGamut).toBe(1);
      const replayed = (await replay.readResourceAtWork(output.colorId, output.workIndex)).unwrap();
      const bytesPerRow = replayed.bytes.byteLength / DISPLAY_P3_SIZE;
      const replayRgba = toRgba(replayed.bytes, bytesPerRow, replayed.format);
      let maxPixelError = 0;
      for (let i = 0; i < liveRgba.length; i++)
        if (i % 4 !== 3)
          maxPixelError = Math.max(
            maxPixelError,
            Math.abs((liveRgba[i] ?? 0) - (replayRgba[i] ?? 0)),
          );
      expect(maxPixelError).toBeLessThanOrEqual(1);
      await save('replay.rgba', replayRgba);
      await save('live.rgba', liveRgba);
      const report = {
        digest: capture.digest,
        canvasColorSpace,
        canvasFormat: (tape.header.rhiCaps as { canvasFormat?: string }).canvasFormat,
        outputWorkIndex: output.workIndex,
        tonemapParams: params,
        bindings: inspected.bindings,
        replayFormat: replayed.format,
        maxPixelError,
        errors,
      };
      await save('rhi-debug.json', json(report));
      expect(errors).toEqual([]);
      return { report, liveRgba, replayRgba };
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    scene.dispose();
  }
}
