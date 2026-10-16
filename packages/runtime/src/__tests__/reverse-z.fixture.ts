import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, type Renderer } from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** The production World -> Renderer path, including native depth and fresh-device replay. */
export async function verifyReverseZ(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  warmupFrames = 60,
) {
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const box = (z: number, size: number, color: [number, number, number, number]) => {
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
    return world
      .spawn(
        { component: Transform, data: { pos: [0, 0, z], scale: [size, size, 0.25] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  };
  // At 100 km with near=0.1, forward float32 depth collapses this separation.
  box(-100000, 60000, [1, 0, 0, 1]);
  box(-100001, 200000, [0, 1, 0, 1]);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 2,
          aspect: 1,
          near: 0.1,
          far: 1e8,
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
  const readColor = async (receipt: Awaited<ReturnType<typeof draw>>) => {
    const observations = value(
      await renderer.observe(receipt, { include: ['final-display', 'linear-ldr'] }),
    ).observations;
    const live = observations?.find((item) => item.domain === 'final-display');
    if (!live) throw new Error('missing live image');
    const rgba = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const src = y * live.metadata.bytesPerRow + x * 4;
        const dst = (y * 64 + x) * 4;
        rgba.set(live.bytes.subarray(src, src + 4), dst);
        if (live.metadata.format.startsWith('bgra')) {
          [rgba[dst], rgba[dst + 2]] = [rgba[dst + 2] ?? 0, rgba[dst] ?? 0];
        }
      }
    return rgba;
  };
  const expectSurfaces = (rgba: Uint8Array) => {
    expect(Array.from(rgba.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 3))).toEqual([255, 0, 0]);
    expect(Array.from(rgba.slice((32 * 64 + 8) * 4, (32 * 64 + 8) * 4 + 3))).toEqual([0, 255, 0]);
  };
  try {
    for (let i = 0; i < warmupFrames; i++) await draw();
    if (!renderer.requestObservation) throw new Error('observation unavailable');
    value(renderer.requestObservation(['final-display', 'linear-ldr']));
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await draw();
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    await save('frame.rhitape', capture.bytes);
    await save(
      'inspection.json',
      new TextEncoder().encode(JSON.stringify({ errors, inspection: renderer.inspect() }, null, 2)),
    );
    const rgba = await readColor(receipt);
    await save('live.rgba', rgba);
    expectSurfaces(rgba);
    const tape = decodeTape(capture.bytes).unwrap();
    const model = buildFrameModel(tape);
    const geometry = model.works.filter(
      (work) => work.attachments?.depthStencilViewHandleId != null,
    );
    expect(geometry.length).toBeGreaterThan(0);
    const last = geometry.at(-1);
    const depthId = last?.attachments?.depthStencilViewHandleId;
    const colorId = last?.attachments?.colorViewHandleIds[0];
    if (!last || !depthId || !colorId) throw new Error('missing scene work');
    const final = model.works.at(-1);
    const finalColorId = final?.attachments?.colorViewHandleIds[0];
    if (!final || !finalColorId) throw new Error('missing final output work');
    const replayFrame = async (source: typeof tape) => {
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(source, adapter.features, adapter.limits))
      ).unwrap();
      const replay = (
        await openReplay(source, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const inspected = (
          await replay.inspectWork(last.workIndex, ['pipeline', 'bindings'])
        ).unwrap();
        const color = (await replay.readResourceAtWork(colorId, last.workIndex)).unwrap();
        const depth = (
          await replay.readResourceAtWork(depthId, last.workIndex, {
            aspect: 'depth-only',
            mipLevel: 0,
            arrayLayer: 0,
          })
        ).unwrap();
        const output = (await replay.readResourceAtWork(finalColorId, final.workIndex)).unwrap();
        return { inspected, color, depth, output };
      } finally {
        (await replay.dispose()).unwrap();
      }
    };
    const replay = await replayFrame(tape);
    expect(replay.depth.format).toBe('depth32float-stencil8');
    const replayRgba = new Uint8Array(replay.output.bytes);
    if (replay.output.format?.startsWith('bgra')) {
      for (let i = 0; i < replayRgba.length; i += 4)
        [replayRgba[i], replayRgba[i + 2]] = [replayRgba[i + 2] ?? 0, replayRgba[i] ?? 0];
    }
    expect(Array.from(replayRgba)).toEqual(Array.from(rgba));
    await save('replay.rgba', replayRgba);
    const depths = new Float32Array(
      replay.depth.bytes.buffer,
      replay.depth.bytes.byteOffset,
      64 * 64,
    );
    const nearDepth = depths[32 * 64 + 32] ?? 0;
    const farDepth = depths[32 * 64 + 8] ?? 0;
    expect(nearDepth).toBeGreaterThan(farDepth);
    expect(farDepth).toBeGreaterThan(0);
    expect(nearDepth).toBeLessThan(0.000002);
    await save('depth.f32', replay.depth.bytes);
    await save('replay-color.bin', replay.color.bytes);
    // Falsify the actual recorded scene clear: greater-depth writes must fail against 1.
    let changed = 0;
    const invalid = encodeTape({
      ...tape,
      events: tape.events.map((event) => {
        if (
          event.kind !== 'beginRenderPass' ||
          !event.desc.depthStencilAttachment ||
          event.desc.depthStencilAttachment.depthLoadOp !== 'clear'
        )
          return event;
        changed++;
        return {
          ...event,
          desc: {
            ...event.desc,
            depthStencilAttachment: { ...event.desc.depthStencilAttachment, depthClearValue: 1 },
          },
        };
      }),
    }).unwrap();
    expect(changed).toBeGreaterThan(0);
    const falsified = await replayFrame(decodeTape(invalid).unwrap());
    await save('falsified.rgba', falsified.output.bytes);
    await save('falsified-color.bin', falsified.color.bytes);
    await save('clear-falsifier.rhitape', invalid);
    expect(Array.from(falsified.color.bytes)).not.toEqual(Array.from(replay.color.bytes));
    // The depth falsifier is exact before final-output dither. A half-LSB tie
    // may quantize to 1 on a native driver; it must never hide surviving color.
    expect(falsified.color.format).toBe('rgba16float');
    const linearWords = new Uint16Array(
      falsified.color.bytes.buffer,
      falsified.color.bytes.byteOffset,
      falsified.color.bytes.byteLength / 2,
    );
    expect(linearWords.every((word, index) => index % 4 === 3 || word === 0)).toBe(true);
    expect(falsified.output.bytes.every((byte, index) => index % 4 === 3 || byte <= 1)).toBe(true);
    await save(
      'report.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            digest: capture.digest,
            completedFrames: 61,
            maxPixelError: 0,
            clearFalsifier: 'linear HDR RGB exactly zero; final-output dither at most one LSB',
            nearDepth,
            farDepth,
            workIndex: last.workIndex,
            eventIndex: last.eventIndex,
            pipeline: replay.inspected,
            unseededResources: model.unseededResources,
            errors,
          },
          null,
          2,
        ),
      ),
    );
    // Projection change must retain the same near/far ownership.
    world
      .set(camera, Camera, {
        projection: 1,
        far: 1e6,
        left: -100000,
        right: 100000,
        top: 100000,
        bottom: -100000,
      })
      .unwrap();
    for (const projection of [1, 0]) {
      for (const antialias of [2, 3, 1, 0]) {
        world.set(camera, Camera, { projection, antialias }).unwrap();
        for (let i = 0; i < 3; i++) await draw();
        value(renderer.requestObservation(['final-display', 'linear-ldr']));
        const pixels = await readColor(await draw());
        expectSurfaces(pixels);
        await save(`projection-${projection}-aa-${antialias}.rgba`, pixels);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
