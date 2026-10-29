import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
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
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  type ReplayReadbackResult,
  replayDeviceRequest,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
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

/** Independent Unreal-model composite oracle over the replayed scene and bokeh inputs. */
function compositeOracle(scene: Image, bokeh: Image, flare: LensFlareData): Image {
  const pixels: number[] = [];
  for (let y = 0; y < scene.height; y++)
    for (let x = 0; x < scene.width; x++) {
      const px = ((x + 0.5) / scene.width) * 2 - 1;
      const py = ((y + 0.5) / scene.height) * 2 - 1;
      const border = disc(px, py) * disc(px * 0.8, py * 0.8);
      for (let c = 0; c < 4; c++) {
        let value = texel(scene, x, y, c);
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
  return { width: scene.width, height: scene.height, pixels };
}

/** Shared real renderer path: browser and Dawn execute the same assertions. */
export async function verifyLensFlare(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  screenshot?: (name: string) => Promise<void>,
  resize?: (width: number, height: number) => void,
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
          antialias: 0,
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
  const requestObservation = renderer.requestObservation?.bind(renderer);
  if (!requestObservation) throw new Error('missing linear-LDR observation');
  const draw = async (observe = false) => {
    if (observe) renderValue(requestObservation(['linear-ldr']));
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(
      renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        geometryLane: 'direct',
      }),
    );
    renderValue(await receipt.completed);
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
    for (const [name, parameters] of [
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
    ] as const) {
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
      await screenshot?.(name);
      images.set(name, live);
      expect(errors).toEqual([]);
      const active = name !== 'baseline' && name !== 'zero';
      expect(flarePasses()).toEqual(active ? [...FLARE_PASSES] : []);
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
      const composite = find('var bokeh');
      expect(prefilter.workIndex).toBeLessThan(blur.workIndex);
      expect(blur.workIndex).toBeLessThan(composite.workIndex);
      for (const work of [prefilter, blur, composite])
        expect(work.drawCall).toMatchObject({ kind: 'draw', vertexCount: 3, instanceCount: 1 });
      const replay = async (bytes: Uint8Array, label: string) => {
        const replayTape = decodeTape(bytes).unwrap();
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(
            replayDeviceRequest(replayTape, adapter.features, adapter.limits),
          )
        ).unwrap();
        const session = (
          await openReplay(replayTape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const bound = (binding: number) => {
            const entry = composite.bindings.find(
              (item) => item.groupIndex === 1 && item.binding === binding,
            );
            if (!entry?.resourceId) throw new Error(`missing composite binding ${binding}`);
            return entry.resourceId;
          };
          const colorOutput = workOutputs(composite).find(
            (output) => output.name === 'color0' && output.role === 'color',
          );
          if (!colorOutput) throw new Error('missing composite color output');
          // Read the output and all three full-resource inputs at one work. This
          // preserves the replay evidence while avoiding a second replay of the
          // same prefix just to inspect the composite attachment.
          const reads = (
            await session.readAtWorks([
              colorOutput.request,
              ...[2, 0, 3].map((binding) => ({
                resourceId: bound(binding),
                workIndex: composite.workIndex,
              })),
            ])
          ).unwrap();
          const [outputRead, uniform, sceneInput, bokehInput] = reads.map((read) => read.unwrap());
          if (!outputRead || !uniform || !sceneInput || !bokehInput)
            throw new Error('missing composite readback');
          expect(uniform.bytes.byteLength).toBe(160);
          const output = rgba(outputRead);
          const scene = rgba(sceneInput);
          const bokeh = rgba(bokehInput);
          for (const [input, image] of [
            ['scene', scene],
            ['bokeh', bokeh],
          ] as const)
            await save(
              `${name}-${label}-${input}.f32`,
              new Uint8Array(new Float32Array(image.pixels).buffer),
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
          return { output, scene, bokeh };
        } finally {
          (await session.dispose()).unwrap();
        }
      };
      const replayed = await replay(capture.bytes, 'live');
      expect([replayed.bokeh.width, replayed.bokeh.height]).toEqual([
        Math.ceil((live.width * GUARD_BAND) / 8),
        Math.ceil((live.height * GUARD_BAND) / 8),
      ]);
      const expected = compositeOracle(replayed.scene, replayed.bokeh, data);
      let oracleMaxError = 0;
      let flareEnergy = 0;
      for (let i = 0; i < expected.pixels.length; i++) {
        const want = expected.pixels[i] ?? NaN;
        const got = replayed.output.pixels[i] ?? NaN;
        oracleMaxError = Math.max(
          oracleMaxError,
          Math.abs(got - want) / Math.max(1, Math.abs(want)),
        );
        if (i % 4 !== 3) flareEnergy += got - (replayed.scene.pixels[i] ?? 0);
      }
      // Peak-to-energy ratio of the replayed HDR bokeh: a wider disc spreads
      // the same thresholded energy over more guard texels.
      let peak = 0;
      let weight = 0;
      for (let i = 1; i < replayed.bokeh.pixels.length; i += 4) {
        peak = Math.max(peak, replayed.bokeh.pixels[i] ?? 0);
        weight += replayed.bokeh.pixels[i] ?? 0;
      }
      bokehConcentration.set(name, peak / weight);
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
      // Without the bokeh pass the composite adds the cleared (black) guard band.
      let missingBlurEnergy = 0;
      for (let i = 0; i < blurFalsified.output.pixels.length; i++)
        if (i % 4 !== 3)
          missingBlurEnergy += Math.abs(
            (blurFalsified.output.pixels[i] ?? 0) - (blurFalsified.scene.pixels[i] ?? 0),
          );
      expect(missingBlurEnergy).toBeLessThan(flareEnergy * 1e-3);
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
        guardBand: [replayed.bokeh.width, replayed.bokeh.height],
        passes: renderer.inspect().perFramePassNames,
      });
    }
    // Composes with Bloom and TAA; the flare stays in the HDR chain before tone mapping.
    world.set(camera, LensFlare, { threshold: 8, intensity: 1 }).unwrap();
    world.set(camera, Camera, { bloom: 1, antialias: 2 }).unwrap();
    for (let i = 0; i < 8; i++) await draw();
    const passes = renderer.inspect().perFramePassNames;
    const flareIndex = passes.indexOf('standard-lens-flare');
    const bloomIndex = passes.findLastIndex((pass) => pass.includes('bloom'));
    expect(bloomIndex).toBeGreaterThanOrEqual(0);
    expect(flareIndex).toBeGreaterThan(bloomIndex);
    expect(flareIndex).toBeLessThan(passes.indexOf('output-transform'));
    composedPasses = passes;
    expect(errors).toEqual([]);
    if (resize) {
      resize(160, 96);
      world.set(camera, Camera, { aspect: 160 / 96 }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const resized = await readLive(await draw(true));
      expect([resized.width, resized.height]).toEqual([160, 96]);
      expect(resized.pixels.every(Number.isFinite)).toBe(true);
      expect(flarePasses()).toEqual([...FLARE_PASSES]);
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
