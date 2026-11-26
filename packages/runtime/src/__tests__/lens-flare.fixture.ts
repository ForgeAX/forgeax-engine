import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import { halfFloat } from '@forgeax/engine-math';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Camera,
  LensFlare,
  type LensFlareData,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import {
  type attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  type ReplayReadbackResult,
  readbackImage,
  replayDeviceRequest,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
interface Image {
  readonly width: number;
  readonly height: number;
  readonly pixels: readonly number[];
}
const FLARE_PASSES = [
  'standard-lens-flare-prefilter',
  'standard-lens-flare-bokeh',
  'standard-lens-flare',
] as const;

function rgba(read: ReplayReadbackResult): Image {
  expect(read.format).toBe('rgba16float');
  const width = read.width ?? 0;
  const height = read.height ?? 0;
  const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
  const rowBytes = read.bytes.byteLength / height;
  expect(rowBytes).toBeGreaterThanOrEqual(width * 8);
  return {
    width,
    height,
    pixels: Array.from({ length: width * height * 4 }, (_, i) =>
      halfFloat.f16ToF32(
        data.getUint16(Math.floor(i / (width * 4)) * rowBytes + (i % (width * 4)) * 2, true),
      ),
    ),
  };
}
function bloomImage(read: ReplayReadbackResult): Image {
  expect(['rgba16float', 'rg11b10ufloat']).toContain(read.format);
  const { width, height, data } = readbackImage(read).unwrap();
  return { width, height, pixels: Array.from(data) };
}

const texel = (image: Image, x: number, y: number, c: number) =>
  image.pixels[
    (Math.min(image.height - 1, Math.max(0, y)) * image.width +
      Math.min(image.width - 1, Math.max(0, x))) *
      4 +
      c
  ] ?? NaN;
function bilinear(image: Image, u: number, v: number, c: number): number {
  const x = u * image.width - 0.5;
  const y = v * image.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  return (
    (texel(image, x0, y0, c) * (1 - fx) + texel(image, x0 + 1, y0, c) * fx) * (1 - fy) +
    (texel(image, x0, y0 + 1, c) * (1 - fx) + texel(image, x0 + 1, y0 + 1, c) * fx) * fy
  );
}
const GUARD_BAND = 1.25;
const disc = (x: number, y: number) => Math.max(0, Math.min(1, 1 - x * x - y * y)) ** 2;

/** Scalar ghost model over the real captured bokeh and optional accumulated Bloom. */
function compositeOracle(
  extent: Pick<Image, 'width' | 'height'>,
  bokeh: Image,
  flare: LensFlareData,
  bloom: Image | undefined,
  bloomIntensity: number,
): Image {
  const { width, height } = extent;
  const pixels: number[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = ((x + 0.5) / width) * 2 - 1;
      const py = ((y + 0.5) / height) * 2 - 1;
      const border = disc(px, py) * disc(px * 0.8, py * 0.8);
      for (let c = 0; c < 4; c++) {
        let value = bloom !== undefined && c < 3 ? texel(bloom, x, y, c) * bloomIntensity : 0;
        if (c < 3 && border > 0) {
          let sum = 0;
          for (let ghost = 0; ghost < 8; ghost++) {
            const scale = flare.ghostScales[ghost] ?? 0;
            if (Math.abs(scale) < 1e-4) continue;
            const u = px / (scale * 2 * GUARD_BAND) + 0.5;
            const v = py / (scale * 2 * GUARD_BAND) + 0.5;
            if (u < 0 || u > 1 || v < 0 || v > 1) continue;
            sum += (flare.ghostTints[ghost * 3 + c] ?? 0) * bilinear(bokeh, u, v, c);
          }
          value += sum * (flare.tint[c] ?? 0) * flare.intensity * border;
        }
        pixels.push(value);
      }
    }
  return { width, height, pixels };
}

function peakToBokehEnergy(image: Image): number {
  let peak = 0;
  let weight = 0;
  for (let i = 1; i < image.pixels.length; i += 4) {
    peak = Math.max(peak, image.pixels[i] ?? 0);
    weight += image.pixels[i] ?? 0;
  }
  return peak / weight;
}

/** Shared real renderer path: browser and Dawn execute the same assertions. */
export async function verifyLensFlare(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  screenshot?: (name: string) => Promise<void>,
  resize?: (width: number, height: number) => void,
  options: {
    readonly portable?: boolean;
    readonly whiteBalance?: boolean;
    readonly backend?: Parameters<typeof attachRecorder>[0];
    readonly replayCanvas?: Parameters<typeof webgpu.rhi.requestAdapter>[1];
  } = {},
) {
  // Seven sampled states plus the composition window still complete 60
  // frames without relying on the optional resize probe.
  const sampleFrames = Math.max(6, testQuality.staticFrames);
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          aspect: 4 / 3,
          fov: Math.PI / 3,
          near: 0.1,
          far: 50,
          tonemap: TONEMAP_ACES_FILMIC,
          temperature: options.whiteBalance ? 7200 : 6504,
          antialias: ANTIALIAS_NONE,
          bloom: 0,
        },
      },
    )
    .unwrap();
  const box = (x: number, y: number, z: number, size: number, color: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, z] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world)
              .create(createBoxGeometry(size, size, 0.1).unwrap())
              .unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              testAssets(world)
                .create(Materials.unlit([color, color, color, 1]))
                .unwrap(),
            ],
          },
        },
      )
      .unwrap();
  box(0, 0, -9, 30, 0.02);
  // Upper-left HDR source: every ghost lies on the line through the view center.
  box(-3, 2, -8, 0.5, 60);
  const lease = renderValue(renderer.attach(world));
  let completedFrames = 0;
  const draw = async (observe = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = await drawReadyFrame(
      renderer,
      { source: lease, geometryLane: 'direct' },
      observe ? ['linear-ldr'] : undefined,
    );
    completedFrames++;
    return receipt;
  };
  const readLive = async (receipt: Awaited<ReturnType<typeof draw>>): Promise<Image> => {
    const image = renderValue(
      await renderer.observe(receipt, { include: ['linear-ldr'] }),
    ).observations?.find((item) => item.domain === 'linear-ldr');
    if (!image) throw new Error('missing submitted linear-LDR pixels');
    const data = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    const { width, height, bytesPerRow } = image.metadata;
    return {
      width,
      height,
      pixels: Array.from({ length: width * height * 4 }, (_, i) =>
        halfFloat.f16ToF32(
          data.getUint16(Math.floor(i / (width * 4)) * bytesPerRow + (i % (width * 4)) * 2, true),
        ),
      ),
    };
  };
  const expectedPasses = [...FLARE_PASSES];
  const flarePasses = () =>
    renderer.inspect().perFramePassNames.filter((pass) => pass.startsWith('standard-lens-flare'));
  // Sum of the absolute RGB change inside a disc around screen offset (x, y).
  const energy = (image: Image, baseline: Image, x: number, y: number, radius = 0.12) => {
    let sum = 0;
    for (let py = 0; py < image.height; py++)
      for (let px = 0; px < image.width; px++) {
        const nx = ((px + 0.5) / image.width) * 2 - 1 - x;
        const ny = ((py + 0.5) / image.height) * 2 - 1 - y;
        if (nx * nx + ny * ny > radius * radius) continue;
        for (let c = 0; c < 3; c++)
          sum += Math.abs(texel(image, px, py, c) - texel(baseline, px, py, c));
      }
    return sum;
  };
  const reports: unknown[] = [];
  const images = new Map<string, Image>();
  try {
    let source = { x: 0, y: 0 };
    const bokehConcentration = new Map<string, number>();
    let composedPasses: readonly string[] = [];
    let defaultBokeh: readonly number[] | undefined;
    const verifyCapturedContribution = async (
      name: string,
      capture: EncodedTape,
      live: Image,
      data: LensFlareData,
      bloomIntensity: number,
      mirrored: number,
      control: number,
    ) => {
      const tape = decodeTape(capture.bytes).unwrap();
      const model = buildFrameModel(tape);
      const find = (marker: string) => {
        const work = model.works.find((item) =>
          item.pipeline.shaders.some((shader) => shader.source?.includes(marker)),
        );
        if (!work) throw new Error(`missing lens-flare work ${marker}`);
        return work;
      };
      const prefilter = find('params.control.x');
      const blur = find('2.39996323');
      const composite = find('fn ghost_radiance');
      const output = workOutputs(composite).find((item) => item.name === 'color0');
      if (output === undefined) throw new Error('missing half-resolution optical contribution');
      const consumerEntry = options.whiteBalance
        ? 'color_stage_fs'
        : options.portable
          ? 'fs_tone_glare'
          : 'fs_grade_bloom';
      const consumer = model.works.find((work) =>
        work.pipeline.shaders.some((stage) => stage.entryPoint === consumerEntry),
      );
      if (consumer === undefined)
        throw new Error(`missing optical contribution consumer ${consumerEntry}`);
      const contributionBinding = options.portable ? 3 : 4;
      expect(
        consumer.bindings.find((item) => item.binding === contributionBinding)?.resourceId,
      ).toBe(output.request.resourceId);
      expect(consumer.workIndex).toBeGreaterThan(composite.workIndex);
      expect(renderer.inspect().perFramePassNames).not.toContain('bloom-composite');
      expect(renderer.inspect().perFramePassNames).not.toContain('standard-lens-flare-apply');
      expect(prefilter.workIndex).toBeLessThan(blur.workIndex);
      expect(blur.workIndex).toBeLessThan(composite.workIndex);
      for (const work of [prefilter, blur, composite])
        expect(work.drawCall).toMatchObject({ kind: 'draw', vertexCount: 3, instanceCount: 1 });
      const replay = async (bytes: Uint8Array, label: string) => {
        const replayTape = decodeTape(bytes).unwrap();
        const backend = options.backend ?? webgpu;
        const adapter = (
          await backend.rhi.requestAdapter(undefined, options.replayCanvas)
        ).unwrap();
        const device = (
          await adapter.requestDevice(
            replayDeviceRequest(replayTape, adapter.features, adapter.limits),
          )
        ).unwrap();
        const session = (
          await openReplay(replayTape, { device, createShaderModule: backend.createShaderModule })
        ).unwrap();
        try {
          const bound = (binding: number) => {
            const entry = composite.bindings.find(
              (item) => item.groupIndex === 1 && item.binding === binding,
            );
            if (!entry?.resourceId) throw new Error(`missing composite binding ${binding}`);
            return entry.resourceId;
          };
          const inputs = bloomIntensity > 0 ? [2, 0, 3] : [2, 0];
          const reads = (
            await session.readAtWorks([
              output.request,
              ...inputs.map((binding) => ({
                resourceId: bound(binding),
                workIndex: composite.workIndex,
              })),
            ])
          ).unwrap();
          const [outputRead, uniform, bokehInput, bloomInput] = reads.map((read) => read.unwrap());
          if (!outputRead || !uniform || !bokehInput)
            throw new Error('missing optical contribution readback');
          expect(uniform.bytes.byteLength).toBe(160);
          expect(
            new DataView(uniform.bytes.buffer, uniform.bytes.byteOffset).getFloat32(8, true),
          ).toBe(bloomIntensity);
          const bokeh = rgba(bokehInput);
          const bloom = bloomInput === undefined ? undefined : bloomImage(bloomInput);
          await save(
            `${name}-${label}-bokeh.f32`,
            new Uint8Array(new Float32Array(bokeh.pixels).buffer),
          );
          if (bloom !== undefined)
            await save(
              `${name}-${label}-bloom.f32`,
              new Uint8Array(new Float32Array(bloom.pixels).buffer),
            );
          await save(
            `${name}-${label}-work.json`,
            new TextEncoder().encode(
              JSON.stringify(
                {
                  workIndex: composite.workIndex,
                  eventIndex: composite.eventIndex,
                  passIndex: composite.passIndex,
                  attachment: outputRead,
                  pipeline: composite.pipeline,
                  bindings: composite.bindings,
                  vertexBuffers: composite.vertexBuffers,
                  indexBuffer: composite.indexBuffer,
                },
                (key, value) => (key === 'bytes' ? undefined : value),
                2,
              ),
            ),
          );
          return { output: rgba(outputRead), bloom, bokeh };
        } finally {
          (await session.dispose()).unwrap();
        }
      };
      const replayed = await replay(capture.bytes, 'live');
      expect([replayed.bokeh.width, replayed.bokeh.height]).toEqual([
        Math.ceil((live.width * GUARD_BAND) / 8),
        Math.ceil((live.height * GUARD_BAND) / 8),
      ]);
      expect([replayed.output.width, replayed.output.height]).toEqual([
        Math.ceil(live.width / 2),
        Math.ceil(live.height / 2),
      ]);
      if (name === 'default') defaultBokeh = replayed.bokeh.pixels;
      if (bloomIntensity > 0) {
        expect(replayed.bloom).toBeDefined();
        expect(replayed.bokeh.pixels).toEqual(defaultBokeh);
      }
      const expected = compositeOracle(
        replayed.output,
        replayed.bokeh,
        data,
        replayed.bloom,
        bloomIntensity,
      );
      const bloomOnly = (i: number) => (replayed.bloom?.pixels[i] ?? 0) * bloomIntensity;
      let oracleMaxError = 0;
      let flareEnergy = 0;
      for (let i = 0; i < expected.pixels.length; i++) {
        const want = expected.pixels[i] ?? NaN;
        const got = replayed.output.pixels[i] ?? NaN;
        oracleMaxError = Math.max(
          oracleMaxError,
          Math.abs(got - want) / Math.max(1, Math.abs(want)),
        );
        if (i % 4 !== 3) flareEnergy += got - bloomOnly(i);
      }
      // Peak-to-energy ratio of the replayed HDR bokeh: a wider disc spreads
      // the same thresholded energy over more guard texels.
      bokehConcentration.set(name, peakToBokehEnergy(replayed.bokeh));
      if (name === 'wide-bokeh')
        expect(bokehConcentration.get(name)).toBeLessThan(
          (bokehConcentration.get('single-ghost') ?? 0) * 0.6,
        );
      expect(oracleMaxError).toBeLessThanOrEqual(0.01);
      expect(flareEnergy).toBeGreaterThan(1);
      const withoutDraw = (index: number) =>
        encodeTape(
          {
            ...tape,
            events: tape.events.map((event, eventIndex) =>
              eventIndex === index && event.kind === 'draw' ? { ...event, vertexCount: 0 } : event,
            ),
          },
          { compression: 'gzip' },
        ).unwrap();
      const missingBlur = withoutDraw(blur.eventIndex);
      const blurFalsified = await replay(missingBlur, 'missing-bokeh');
      // Clearing bokeh removes the ghosts while leaving the independently weighted Bloom.
      let missingBlurEnergy = 0;
      for (let i = 0; i < blurFalsified.output.pixels.length; i++)
        if (i % 4 !== 3)
          missingBlurEnergy += Math.abs((blurFalsified.output.pixels[i] ?? 0) - bloomOnly(i));
      expect(missingBlurEnergy).toBeLessThan((flareEnergy + bloomIntensity) * 1e-3);
      await save(`${name}-missing-bokeh.rhitape`, missingBlur);
      reports.push({
        name,
        digest: capture.digest,
        works: {
          prefilter: prefilter.workIndex,
          bokeh: blur.workIndex,
          composite: composite.workIndex,
        },
        unseeded: model.unseededResources,
        source,
        mirroredEnergy: mirrored,
        controlEnergy: control,
        oracleMaxRelativeError: oracleMaxError,
        bokehPeakToEnergy: bokehConcentration.get(name),
        flareEnergy,
        missingBokehEnergy: missingBlurEnergy,
        width: live.width,
        height: live.height,
        glareSize: [replayed.output.width, replayed.output.height],
        bloomIntensity,
        guardBand: [replayed.bokeh.width, replayed.bokeh.height],
        passes: renderer.inspect().perFramePassNames,
      });
    };
    for (const [name, parameters, bloomIntensity = 0] of [
      ['baseline', undefined],
      ['default', {}],
      ['tinted', { tint: [1, 0.15, 0.05] }],
      [
        'single-ghost',
        {
          tint: [1, 1, 1],
          ghostScales: [-1, 0, 0, 0, 0, 0, 0, 0],
          ghostTints: [1, 1, 1, ...new Array(21).fill(0)],
          intensity: 4,
        },
      ],
      ['wide-bokeh', { ghostScales: [-1, 0, 0, 0, 0, 0, 0, 0], bokehSize: 8 }],
      ['above-threshold', { threshold: 60000 }],
      ['zero', { intensity: 0 }],
      ['bloom-and-flare', {}, 0.5],
      ['stronger-bloom', {}, 1.25],
    ] as const) {
      world
        .set(camera, Camera, {
          bloom: bloomIntensity > 0 ? 1 : 0,
          bloomIntensity,
          bloomThreshold: 1,
        })
        .unwrap();
      if (name === 'bloom-and-flare') world.removeComponent(camera, LensFlare).unwrap();
      if (parameters !== undefined) {
        if (!world.hasComponent(camera, LensFlare))
          world.addComponent(camera, { component: LensFlare, data: {} }).unwrap();
        world.set(camera, LensFlare, parameters as Partial<LensFlareData>).unwrap();
      }
      for (let i = 0; i < sampleFrames; i++) await draw();
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = await draw(true);
      const live = await readLive(receipt);
      (await recorder.frameBoundary()).unwrap();
      const capture = (await pending).unwrap();
      await save(`${name}.rhitape`, compactTape(capture).bytes);
      await save(`${name}-live.f32`, new Uint8Array(new Float32Array(live.pixels).buffer));
      const displayBytes = Uint8Array.from(live.pixels, (value, index) => {
        const linear = Math.min(1, Math.max(0, value));
        const display =
          index % 4 === 3 || linear <= 0.0031308
            ? index % 4 === 3
              ? linear
              : linear * 12.92
            : 1.055 * linear ** (1 / 2.4) - 0.055;
        return Math.round(display * 255);
      });
      await save(`${name}.png`, encodePng(live.width, live.height, displayBytes));
      await screenshot?.(name);
      images.set(name, live);
      expect(errors).toEqual([]);
      const active = name !== 'baseline' && name !== 'zero';
      expect(flarePasses(), name).toEqual(active ? expectedPasses : []);
      const baseline = images.get('baseline');
      if (!baseline) throw new Error('missing baseline');
      if (name === 'baseline') {
        let weight = 0;
        let sx = 0;
        let sy = 0;
        for (let y = 0; y < live.height; y++)
          for (let x = 0; x < live.width; x++)
            if (texel(live, x, y, 0) > 0.9) {
              weight++;
              sx += ((x + 0.5) / live.width) * 2 - 1;
              sy += ((y + 0.5) / live.height) * 2 - 1;
            }
        expect(weight).toBeGreaterThan(4);
        source = { x: sx / weight, y: sy / weight };
        expect(source.x).toBeLessThan(-0.3);
        expect(source.y).toBeLessThan(-0.3);
      }
      const mirrored = energy(live, baseline, -source.x, -source.y);
      // A control on the perpendicular through the center sees no ghost.
      const control = energy(live, baseline, source.y * 0.8, -source.x * 0.8);
      const data = world.hasComponent(camera, LensFlare)
        ? world.get(camera, LensFlare).unwrap()
        : undefined;
      if (name === 'default' || name === 'tinted' || name === 'single-ghost') {
        expect(mirrored).toBeGreaterThan(0.5);
        expect(control).toBeLessThan(mirrored * 0.02);
        const ghost = data?.ghostScales[3] ?? 0;
        if (name === 'default')
          expect(energy(live, baseline, source.x * ghost, source.y * ghost)).toBeGreaterThan(0.2);
      }
      if (name === 'tinted') {
        let red = 0;
        let green = 0;
        for (let i = 0; i < live.pixels.length; i += 4) {
          red += (live.pixels[i] ?? 0) - (baseline.pixels[i] ?? 0);
          green += (live.pixels[i + 1] ?? 0) - (baseline.pixels[i + 1] ?? 0);
        }
        expect(red).toBeGreaterThan(green * 3);
      }
      if (name === 'above-threshold' || name === 'zero')
        expect(live.pixels).toEqual(baseline.pixels);
      for (let i = 3; i < live.pixels.length; i += 4)
        expect(live.pixels[i]).toBe(baseline.pixels[i]);
      if (!active || data === undefined || name === 'above-threshold') continue;
      await verifyCapturedContribution(
        name,
        capture,
        live,
        data,
        bloomIntensity,
        mirrored,
        control,
      );
    }
    // Composes with Bloom and TAA; the flare stays in the HDR chain before tone mapping.
    world.set(camera, LensFlare, { threshold: 8, intensity: 1 }).unwrap();
    world.set(camera, Camera, { bloom: 1, bloomIntensity: 0.5, antialias: ANTIALIAS_TAA }).unwrap();
    for (let i = 0; i < 8; i++) await draw();
    expect(renderer.inspect().temporal.mode).toBe('taa');
    const passes = renderer.inspect().perFramePassNames;
    const flareIndex = passes.indexOf('standard-lens-flare');
    const bloomIndex = passes.findLastIndex((pass) => pass.includes('bloom'));
    expect(bloomIndex).toBeGreaterThanOrEqual(0);
    expect(flareIndex).toBeGreaterThan(bloomIndex);
    const output = options.whiteBalance
      ? 'standard-exposure-white-balance'
      : options.portable
        ? 'output-transform'
        : 'standard-grade';
    expect(flareIndex).toBeLessThan(passes.indexOf(output));
    expect(passes).not.toContain('bloom-composite');
    composedPasses = passes;
    expect(errors).toEqual([]);
    if (resize) {
      resize(160, 96);
      world.set(camera, Camera, { aspect: 160 / 96 }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const resized = await readLive(await draw(true));
      expect([resized.width, resized.height]).toEqual([160, 96]);
      expect(resized.pixels.every(Number.isFinite)).toBe(true);
      expect(flarePasses()).toEqual(expectedPasses);
      await screenshot?.('resized');
    }
    world.removeComponent(camera, LensFlare).unwrap();
    for (let i = 0; i < 3; i++) await draw();
    expect(flarePasses()).toEqual([]);
    expect(errors).toEqual([]);
    expect(completedFrames).toBeGreaterThanOrEqual(60);
    await save(
      'report.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            completedFrames,
            bokehPeakToEnergy: Object.fromEntries(bokehConcentration),
            composedPasses,
            cases: reports,
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
