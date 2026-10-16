import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_SMAA,
  Camera,
  DEFAULT_STANDARD_PROFILE,
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
  halfToFloat,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));
function floats(bytes: Uint8Array, width: number, height: number, stride: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: width * height * 4 }, (_, i) =>
    halfToFloat(view.getUint16(Math.floor(i / (width * 4)) * stride + (i % (width * 4)) * 2, true)),
  );
}
const mse = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, p, i) => sum + (p - (b[i] ?? NaN)) ** 2, 0) / a.length;

export async function verifySmaa(
  renderer: Renderer,
  recorder: RecorderAttachment,
  canvas: { width: number; height: number },
  save: Save,
  settleFrames = 60,
) {
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const white = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 1, 1, 1]));
  for (const [x, y, angle, width, height] of [
    [-0.7, 0.5, 0.27, 1.2, 0.65],
    [0.7, 0.4, -0.63, 0.65, 1.2],
    [-0.6, -0.7, 0.12, 1.3, 0.045],
    [0.6, -0.7, 0.93, 1.1, 0.06],
  ] as const) {
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [x, y, 0],
            quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
            scale: [width, height, 0.01],
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [white] } },
      )
      .unwrap();
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          aspect: 1,
          fov: Math.PI / 3,
          near: 0.1,
          far: 20,
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
  const observe = async (name: string) => {
    if (renderer.requestObservation === undefined)
      throw new Error('missing observation capability');
    value(renderer.requestObservation(['linear-ldr', 'final-display']));
    const receipt = await draw();
    const result = value(
      await renderer.observe(receipt, { include: ['linear-ldr', 'final-display'] }),
    );
    const linear = result.observations?.find((o) => o.domain === 'linear-ldr');
    const final = result.observations?.find((o) => o.domain === 'final-display');
    if (linear === undefined || final === undefined) throw new Error('missing SMAA observation');
    const { width, height, bytesPerRow } = linear.metadata;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const src = y * final.metadata.bytesPerRow + x * 4;
        const dst = (y * width + x) * 4;
        rgba.set(final.bytes.subarray(src, src + 4), dst);
        if (final.metadata.format.startsWith('bgra')) {
          rgba[dst] = final.bytes[src + 2] ?? 0;
          rgba[dst + 2] = final.bytes[src] ?? 0;
        }
      }
    await save(`${name}-${width}x${height}.rgba`, rgba);
    return floats(linear.bytes, width, height, bytesPerRow);
  };
  try {
    for (let i = 0; i < 3; i++) await draw();
    const none = await observe('none');
    world.set(camera, Camera, { antialias: ANTIALIAS_SMAA }).unwrap();
    for (let i = 0; i < settleFrames; i++) await draw();
    const initialCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const smaa = await observe('smaa');
    (await recorder.frameBoundary()).unwrap();
    await save('initial.rhitape', (await initialCapture).unwrap().bytes);
    expect(mse(none, smaa)).toBeGreaterThan(0.00001);
    expect(renderer.inspect().perFramePassNames.filter((name) => name.startsWith('smaa-'))).toEqual(
      ['smaa-area-upload', 'smaa-search-upload', 'smaa-edges', 'smaa-weights', 'smaa-blend'],
    );
    // Flat interiors/background stay exact; only a one-pixel neighborhood of discontinuities blends.
    let flat = 0;
    for (let y = 2; y < 126; y++)
      for (let x = 2; x < 126; x++) {
        const p = (y * 128 + x) * 4;
        if ([-128, -1, 1, 128].every((d) => none[p + d * 4] === none[p])) {
          expect(smaa[p]).toBe(none[p]);
          flat++;
        }
      }
    expect(flat).toBeGreaterThan(10000);
    // Independent coverage oracle: render the same geometry at 4x each axis, then box resolve in linear space.
    world.set(camera, Camera, { antialias: 0 }).unwrap();
    canvas.width = canvas.height = 512;
    const supersampled = await observe('coverage-reference');
    const reference = none.map((_, i) => {
      const pixel = Math.floor(i / 4),
        c = i % 4;
      const x = pixel % 128,
        y = Math.floor(pixel / 128);
      let sum = 0;
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 4; dx++)
          sum += supersampled[((y * 4 + dy) * 512 + x * 4 + dx) * 4 + c] ?? NaN;
      return sum / 16;
    });
    const quality = { noneMse: mse(none, reference), smaaMse: mse(smaa, reference) };
    await save('quality.json', json(quality));
    expect(quality.smaaMse).toBeLessThan(quality.noneMse * 0.9);
    canvas.width = 127;
    canvas.height = 93;
    world.set(camera, Camera, { antialias: ANTIALIAS_SMAA }).unwrap();
    expect((await observe('odd-size')).length).toBe(127 * 93 * 4);
    canvas.width = canvas.height = 128;
    expect(mse(await observe('restored-size'), smaa)).toBe(0);
    world.set(camera, Camera, { antialias: 0 }).unwrap();
    expect(mse(await observe('disabled'), none)).toBe(0);
    expect(renderer.inspect().perFramePassNames.some((name) => name.startsWith('smaa-'))).toBe(
      false,
    );
    world.set(camera, Camera, { antialias: ANTIALIAS_SMAA }).unwrap();
    await draw();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const live = await observe('captured');
    (await recorder.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    await save('smaa.rhitape', captured.bytes);
    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    for (const work of model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('var areaTexture:')),
    )) {
      for (const binding of work.bindings.filter((b) => b.binding === 2 || b.binding === 3)) {
        const descriptor = model.resources.find(
          (r) => r.resourceId === binding.resourceId,
        )?.descriptor;
        if (
          descriptor === null ||
          typeof descriptor !== 'object' ||
          !('sourceHandleId' in descriptor)
        )
          throw new Error('missing lookup view descriptor');
        expect(
          model.unseededResources.some((r) => r.resourceId === descriptor.sourceHandleId),
        ).toBe(false);
      }
    }

    await save('frame-model.json', json(model));
    const blend = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('var blendTexture:')),
    );
    const weights = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('var areaTexture:')),
    );
    const edges = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('fn delta(')),
    );
    if (blend === undefined || weights === undefined || edges === undefined)
      throw new Error('missing SMAA work');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    const reports: unknown[] = [];
    try {
      for (const work of [edges, weights, blend]) {
        const inspection = (
          await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'pixels'])
        ).unwrap();
        const attachment = inspection.attachment;
        if (attachment === undefined) throw new Error('missing SMAA stage readback');
        expect(attachment.bytes.some((b) => b > 0)).toBe(true);
        await save(`work-${work.workIndex}.${attachment.format}`, attachment.bytes);
        reports.push({
          workIndex: work.workIndex,
          eventIndex: work.eventIndex,
          format: attachment.format,
          bindings: inspection.bindings,
        });
        if (work === blend) {
          const replayPixels = floats(attachment.bytes, 128, 128, 128 * 8);
          const maxError = Math.max(...replayPixels.map((p, i) => Math.abs(p - (live[i] ?? NaN))));
          expect(maxError).toBeLessThanOrEqual(0.002);
          reports.push({ maxLiveReplayError: maxError });
        }
      }
    } finally {
      (await replay.dispose()).unwrap();
    }
    // Remove the actual weight producer. The cleared weight buffer must restore the unfiltered image.
    const missing = encodeTape({
      ...tape,
      events: tape.events.map((event, index) =>
        index === weights.eventIndex && event.kind === 'draw'
          ? { ...event, vertexCount: 0 }
          : event,
      ),
    }).unwrap();
    const falsifier = (
      await openReplay(decodeTape(missing).unwrap(), {
        device,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const result = (await falsifier.inspectWork(blend.workIndex, ['pixels'])).unwrap();
      if (result.attachment === undefined) throw new Error('missing falsifier readback');
      expect(mse(floats(result.attachment.bytes, 128, 128, 128 * 8), none)).toBe(0);
      reports.push({ missingWeightsRestoresNoAa: true });
    } finally {
      (await falsifier.dispose()).unwrap();
    }
    webgpu._internal_getRawDevice(device)?.destroy();
    for (const renderPath of ['forward', 'deferred'] as const) {
      value(renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, renderPath }));
      world.set(camera, Camera, { tonemap: TONEMAP_ACES_FILMIC, antialias: 0 }).unwrap();
      const baseline = await observe(`${renderPath}-tone-none`);
      world.set(camera, Camera, { antialias: ANTIALIAS_SMAA }).unwrap();
      const antialiased = await observe(`${renderPath}-tone-smaa`);
      expect(mse(baseline, antialiased)).toBeGreaterThan(0.00001);
      expect(renderer.inspect().perFramePassNames).toContain('smaa-blend');
      reports.push({ renderPath, tone: 'aces-filmic', difference: mse(baseline, antialiased) });
    }
    canvas.width = canvas.height = 1;
    expect((await observe('one-pixel')).every(Number.isFinite)).toBe(true);
    canvas.width = canvas.height = 128;

    expect(errors).toEqual([]);
    await save(
      'report.json',
      json({
        quality,
        reports,
        digest: captured.digest,
        unseededResources: model.unseededResources,
        errors,
      }),
    );
  } catch (error) {
    await save(
      'failure.json',
      json({ error: String(error), errors, inspection: renderer.inspect() }),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
