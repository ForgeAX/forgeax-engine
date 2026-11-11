import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  BarrelDistortion,
  Camera,
  LensEffects,
  type LensEffectsData,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
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
import { observeReplaySubmissions } from './native-replay-work.fixture';
import { describeReplayWork } from './replay-inspections.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
const delta = (a: readonly number[], b: readonly number[]) =>
  a.reduce((max, value, i) => Math.max(max, Math.abs(value - (b[i] ?? NaN))), 0);
function rgba(read: ReplayReadbackResult): number[] {
  expect(read.format).toBe('rgba16float');
  const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
  return Array.from({ length: read.bytes.length / 2 }, (_, i) =>
    halfFloat.f16ToF32(data.getUint16(i * 2, true)),
  );
}

/** Independent oracle for the radial fringe; shared by the two chromatic samples. */
function expectChromaticFringe(
  name: string,
  live: { width: number; height: number; pixels: readonly number[] },
  baseline: readonly number[],
) {
  const at = (pixels: readonly number[], x: number, y: number, c = 0) =>
    pixels[(y * live.width + x) * 4 + c] ?? NaN;
  expect(delta(live.pixels, baseline)).toBeGreaterThan(0.15);
  // Independent oracle for UE's scene color fringe (PostProcessTonemap.usf:318-341):
  // red and green sample bilinearly at lens - sign(lens) * max(|lens| - start, 0) * scale,
  // blue stays at the pixel centre.
  const start = name === 'chromatic' ? 0 : 0.5;
  // UE ChromaticAberrationParams: 5 % intensity, wavelength scales over 1 - start.
  const scaleR = (0.05 * 0.007 * (611.3 - 464.3)) / (1 - start);
  const scaleG = (0.05 * 0.007 * (549.1 - 464.3)) / (1 - start);
  const bilinear = (u: number, v: number, c: number) => {
    const fx = u * live.width - 0.5;
    const fy = v * live.height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const texel = (x: number, y: number) =>
      at(
        baseline,
        Math.max(0, Math.min(live.width - 1, x)),
        Math.max(0, Math.min(live.height - 1, y)),
        c,
      );
    const top = texel(x0, y0) * (1 - tx) + texel(x0 + 1, y0) * tx;
    const bottom = texel(x0, y0 + 1) * (1 - tx) + texel(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const pulled = (lens: number, scale: number) =>
    (lens - Math.sign(lens) * Math.max(Math.abs(lens) - start, 0) * scale) * 0.5 + 0.5;
  let fringes = 0;
  for (let y = 0; y < live.height; y++)
    for (let x = 0; x < live.width; x++) {
      const lx = ((x + 0.5) / live.width) * 2 - 1;
      const ly = ((y + 0.5) / live.height) * 2 - 1;
      const red = bilinear(pulled(lx, scaleR), pulled(ly, scaleR), 0);
      const green = bilinear(pulled(lx, scaleG), pulled(ly, scaleG), 1);
      expect(Math.abs(at(live.pixels, x, y, 0) - red)).toBeLessThanOrEqual(0.004);
      expect(Math.abs(at(live.pixels, x, y, 1) - green)).toBeLessThanOrEqual(0.004);
      expect(at(live.pixels, x, y, 2)).toBe(at(baseline, x, y, 2));
      const inside = Math.abs(lx) <= start && Math.abs(ly) <= start;
      if (inside) expect(at(live.pixels, x, y, 0)).toBe(at(baseline, x, y, 0));
      if (Math.abs(at(live.pixels, x, y, 0) - at(live.pixels, x, y, 2)) > 0.1) fringes++;
    }
  expect(fringes).toBeGreaterThan(10);
}

/** Shared real renderer path: browser and Dawn execute the same assertions. */
export async function verifyLensEffects(
  renderer: Renderer,
  assets: AssetRegistry,
  recorder: RecorderAttachment,
  save: Save,
  options: {
    screenshot?: (name: string) => Promise<void>;
    resize?: (width: number, height: number) => void;
  } = {},
) {
  // Six frames per sampled state plus the composition window retain the
  // fixture's 60-frame lifetime, including callers without a resize probe.
  const sampleFrames = Math.max(6, testQuality.staticFrames);
  const world = new World({ assets });
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
          tonemap: 0,
          antialias: 0,
          bloom: 0,
        },
      },
      { component: LensEffects, data: {} },
    )
    .unwrap();
  const box = (x: number, y: number, z: number, width: number, height: number, color: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, z] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: assets.create(createBoxGeometry(width, height, 0.1).unwrap()).unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [assets.create(Materials.unlit([color, color, color, 1])).unwrap()],
          },
        },
      )
      .unwrap();
  box(0, 0, -9, 30, 30, 0.5);
  box(-3, -2.5, -8, 1, 0.4, 0);
  for (const x of [-4, -2, 0, 2, 4]) box(x, 0, -8, 0.22, 5, 0.95);
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
  const readLive = async (receipt: Awaited<ReturnType<typeof draw>>) => {
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
  const reports: unknown[] = [];
  const images = new Map<string, number[]>();
  try {
    for (const [name, parameters] of [
      ['baseline', {}],
      ['vignette', { vignetteIntensity: 0.85 }],
      ['hit', { vignetteIntensity: 0.9, vignetteColor: [0.7, 0, 0] }],
      ['chromatic', { vignetteIntensity: 0, chromaticAberration: 5 }],
      ['chromatic-start', { chromaticAberrationStartOffset: 0.5 }],
      [
        'grain',
        { chromaticAberration: 0, chromaticAberrationStartOffset: 0, grainIntensity: 0.25 },
      ],
      ['combined', { vignetteIntensity: 0.65, chromaticAberration: 3, grainIntensity: 0.12 }],
      ['zero', { vignetteIntensity: 0, chromaticAberration: 0, grainIntensity: 0 }],
    ] as const) {
      world.set(camera, LensEffects, parameters as Partial<LensEffectsData>).unwrap();
      // Normal frame progression checks parameter updates without topology changes.
      for (let i = 0; i < sampleFrames; i++) await draw();
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = await draw(true);
      const live = await readLive(receipt);
      (await recorder.frameBoundary()).unwrap();
      const capture = (await pending).unwrap();
      await save(`${name}.rhitape`, compactTape(capture).bytes);
      await save(`${name}-live.f32`, new Uint8Array(new Float32Array(live.pixels).buffer));
      await options.screenshot?.(name);
      images.set(name, live.pixels);
      const tape = decodeTape(capture.bytes).unwrap();
      const model = buildFrameModel(tape);
      // The fringe is its own pre-tonemap pass; vignette and grain share the output pass.
      const current = world.get(camera, LensEffects).unwrap();
      const fringe = current.chromaticAberration > 0;
      const output = current.vignetteIntensity > 0 || current.grainIntensity > 0;
      const marker = name.startsWith('chromatic') ? 'params.greenScale' : 'fn grain_hash';
      const lens = model.works.find((work) =>
        work.pipeline.shaders.some((shader) => shader.source?.includes(marker)),
      );
      expect(lens !== undefined).toBe(name.startsWith('chromatic') ? fringe : output);
      const passes = renderer.inspect().perFramePassNames;
      expect(passes.filter((pass) => pass === 'lens-effects')).toHaveLength(output ? 1 : 0);
      expect(passes.filter((pass) => pass === 'chromatic-aberration')).toHaveLength(fringe ? 1 : 0);
      expect(errors).toEqual([]);
      const baseline = images.get('baseline');
      if (!baseline) throw new Error('missing baseline');
      const at = (pixels: readonly number[], x: number, y: number, c = 0) =>
        pixels[(y * live.width + x) * 4 + c] ?? NaN;
      if (name === 'baseline') expect(at(baseline, 3, 3)).toBeGreaterThan(0.2);
      if (name === 'vignette') {
        expect(at(live.pixels, 3, 3)).toBeLessThan(at(baseline, 3, 3) * 0.3);
        expect(at(live.pixels, live.width / 2, live.height / 2)).toBeCloseTo(
          at(baseline, live.width / 2, live.height / 2),
          3,
        );
      }
      if (name === 'hit')
        expect(at(live.pixels, 3, 3, 0)).toBeGreaterThan(at(live.pixels, 3, 3, 1) + 0.4);
      if (name === 'chromatic' || name === 'chromatic-start')
        expectChromaticFringe(name, live, baseline);
      if (name === 'grain') {
        const next = await readLive(await draw(true));
        expect(delta(live.pixels, next.pixels)).toBeGreaterThan(0.1);
        const gains: number[] = [];
        let blackPixels = 0;
        for (let i = 0; i < live.pixels.length; i += 4) {
          const base = baseline[i] ?? NaN;
          if (base === 0) {
            expect(live.pixels[i]).toBe(0);
            blackPixels++;
          } else gains.push((live.pixels[i] ?? NaN) / base - 1);
        }
        expect(blackPixels).toBeGreaterThan(0);
        // FilmShader's clamp(0.1 + U[0,1), 0, 1) has mean 0.595.
        expect(Math.min(...gains)).toBeGreaterThanOrEqual(0.025 - 0.002);
        expect(Math.max(...gains)).toBeLessThanOrEqual(0.25 + 0.002);
        expect(gains.reduce((a, b) => a + b, 0) / gains.length).toBeCloseTo(0.595 * 0.25, 2);
      }
      if (name === 'zero') expect(live.pixels).toEqual(baseline);
      for (let i = 3; i < live.pixels.length; i += 4) expect(live.pixels[i]).toBe(baseline[i]);
      if (lens) {
        const replayPixels = async (bytes: Uint8Array, label: string) => {
          const replayTape = decodeTape(bytes).unwrap();
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (
            await adapter.requestDevice(
              replayDeviceRequest(replayTape, adapter.features, adapter.limits),
            )
          ).unwrap();
          const replayWork = observeReplaySubmissions(device);
          const session = (
            await openReplay(replayTape, { device, createShaderModule: webgpu.createShaderModule })
          ).unwrap();
          try {
            const uniform = lens.bindings.find(
              (binding) => binding.groupIndex === 1 && binding.binding === 2,
            );
            if (!uniform?.resourceId) throw new Error('missing lens parameter buffer');
            const resource = model.resources.find(
              (resource) => resource.resourceId === uniform.resourceId,
            );
            const paramBytes = name.startsWith('chromatic') ? 16 : 48;
            expect(resource?.descriptor).toMatchObject({ desc: { size: paramBytes } });
            const output = workOutputs(lens).find((row) => row.role === 'color');
            if (output === undefined) throw new Error('missing replay pixels');
            const reads = (
              await session.readAtWorks([
                { ...output.request, workIndex: lens.workIndex },
                { resourceId: uniform.resourceId, workIndex: lens.workIndex },
              ])
            )
              .unwrap()
              .map((read) => read.unwrap());
            replayWork.assertMaximum(8);
            const [attachment, parameters] = reads;
            if (attachment === undefined || parameters === undefined)
              throw new Error('missing lens replay readback');
            for (const read of reads)
              expect(read.provenance.selectedWorkIndex).toBe(lens.workIndex);
            const inspected = describeReplayWork(lens, attachment);
            expect(parameters.bytes.byteLength).toBe(paramBytes);
            const lensData = world.get(camera, LensEffects).unwrap();
            const firstParam = new DataView(
              parameters.bytes.buffer,
              parameters.bytes.byteOffset,
            ).getFloat32(0, true);
            // Fringe: UE red scale; output pass: vignette intensity.
            if (name.startsWith('chromatic'))
              expect(firstParam).toBeCloseTo(
                (lensData.chromaticAberration * 0.01 * 0.007 * (611.3 - 464.3)) /
                  (1 - lensData.chromaticAberrationStartOffset),
                5,
              );
            else expect(firstParam).toBe(lensData.vignetteIntensity);
            expect(lens.drawCall).toMatchObject({ kind: 'draw', vertexCount: 3, instanceCount: 1 });
            await save(
              `${name}-${label}-work.json`,
              new TextEncoder().encode(
                JSON.stringify(inspected, (key, value) => (key === 'bytes' ? undefined : value), 2),
              ),
            );

            return rgba(attachment);
          } finally {
            try {
              (await session.dispose()).unwrap();
              replayWork.restore();
            } finally {
              device.nativeDevice().unwrap().destroy();
            }
          }
        };
        const replayed = await replayPixels(capture.bytes, 'live');
        const difference = delta(live.pixels, replayed);
        expect(difference).toBeLessThanOrEqual(0.005);
        const missingDraw = encodeTape(
          {
            ...tape,
            events: tape.events.map((event, index) =>
              index === lens.eventIndex && event.kind === 'draw'
                ? { ...event, vertexCount: 0 }
                : event,
            ),
          },
          { compression: 'gzip' },
        ).unwrap();
        const falsified = delta(live.pixels, await replayPixels(missingDraw, 'missing-draw'));
        expect(falsified).toBeGreaterThan(name.startsWith('chromatic') ? 0.1 : 0.2);
        await save(`${name}-missing-draw.rhitape`, missingDraw);
        reports.push({
          name,
          digest: capture.digest,
          workIndex: lens.workIndex,
          eventIndex: lens.eventIndex,
          unseeded: model.unseededResources,
          liveReplayMaxDelta: difference,
          missingDrawMaxDelta: falsified,
          width: live.width,
          height: live.height,
          passes,
        });
      }
    }
    // Ordinary topology composes with existing spatial warp and antialiasing; the
    // fringe stays ahead of Bloom and tone mapping as UE (PostProcessTonemap.usf:318-399).
    world
      .set(camera, LensEffects, {
        vignetteIntensity: 0.4,
        chromaticAberration: 2,
        grainIntensity: 0.1,
      })
      .unwrap();
    world.addComponent(camera, { component: BarrelDistortion, data: { strength: 0.1 } }).unwrap();
    world.set(camera, Camera, { antialias: 1, tonemap: 1, bloom: 1 }).unwrap();
    for (let i = 0; i < 8; i++) await draw();
    const passes = renderer.inspect().perFramePassNames;
    const fringeAt = passes.indexOf('chromatic-aberration');
    expect(fringeAt).toBeGreaterThanOrEqual(0);
    expect(passes.indexOf('bloom-horizontal-0')).toBeGreaterThan(fringeAt);
    expect(passes.indexOf('fxaa')).toBeGreaterThan(fringeAt);
    expect(passes.indexOf('lens-effects')).toBeGreaterThan(passes.indexOf('fxaa'));
    expect(passes.indexOf('fxaa')).toBeGreaterThan(passes.indexOf('barrel-distortion'));
    expect(passes.filter((pass) => pass === 'standard-output-encoding')).toHaveLength(1);
    if (options.resize) {
      options.resize(160, 96);
      world.set(camera, Camera, { aspect: 160 / 96 }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const resized = await readLive(await draw(true));
      expect([resized.width, resized.height]).toEqual([160, 96]);
      expect(resized.pixels.every(Number.isFinite)).toBe(true);
      expect(
        renderer.inspect().perFramePassNames.filter((pass) => pass === 'lens-effects'),
      ).toHaveLength(1);
      await options.screenshot?.('resized');
    }
    world.removeComponent(camera, LensEffects).unwrap();
    for (let i = 0; i < 3; i++) await draw();
    expect(renderer.inspect().perFramePassNames).not.toContain('lens-effects');
    expect(renderer.inspect().perFramePassNames).not.toContain('chromatic-aberration');
    expect(errors).toEqual([]);
    expect(completedFrames).toBeGreaterThanOrEqual(60);
    await save(
      'report.json',
      new TextEncoder().encode(JSON.stringify({ completedFrames, cases: reports }, null, 2)),
    );
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
