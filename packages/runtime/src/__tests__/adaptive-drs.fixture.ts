import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_TAA,
  Camera,
  DynamicResolution,
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
  replayDeviceRequest,
  type V7RhiCallEvent,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export async function verifyAdaptiveDrs(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
) {
  const world = new World();
  const lease = value(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          antialias: ANTIALIAS_TAA,
          aspect: 1,
          fov: Math.PI / 3,
          near: 0.1,
          far: 20,
          tonemap: TONEMAP_ACES_FILMIC,
          clearColor: [0.01, 0.02, 0.04, 1],
        },
      },
    )
    .unwrap();
  for (const [x, y, color] of [
    [-0.6, 0, [0.9, 0.12, 0.05, 1]],
    [0.65, 0.2, [0.03, 0.7, 0.25, 1]],
  ] as const) {
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([...color]));
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, 0], scale: [0.8, 1.3, 0.5] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  let frames = 0;
  const draw = async () => {
    propagateTransforms(world);
    world.update(1 / 60).unwrap();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    frames++;
    // Internal scale changes must preserve output-sized temporal history.
    if (frames > 2) {
      expect(renderer.inspect().temporal).toMatchObject({
        historyValid: true,
        coverage: { width: 128, height: 128 },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return receipt;
  };
  const reports: unknown[] = [];
  const capture = async (name: string) => {
    if (renderer.requestObservation === undefined)
      throw new Error('missing observation capability');
    value(renderer.requestObservation(['final-display']));
    const pending = recorder.captureFrame();
    value(await recorder.frameBoundary());
    const receipt = await draw();
    value(await recorder.frameBoundary());
    const recorded = value(await pending);
    await save(`${name}.rhitape`, recorded.bytes);
    const observation = value(
      await renderer.observe(receipt, { include: ['final-display'] }),
    ).observations?.find((o) => o.domain === 'final-display');
    if (observation === undefined) throw new Error('missing final output');
    const { width, height, bytesPerRow, format } = observation.metadata;
    expect(width).toBe(128);
    expect(height).toBe(128);
    const live = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      live.set(
        observation.bytes.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
        y * width * 4,
      );
    const rgba = live.slice();
    if (format.startsWith('bgra'))
      for (let i = 0; i < rgba.length; i += 4)
        [rgba[i], rgba[i + 2]] = [rgba[i + 2] ?? 0, rgba[i] ?? 0];
    expect(Array.from(rgba).filter((v, i) => i % 4 === 0 && v > 180).length).toBeGreaterThan(200);
    await save(`${name}.rgba`, rgba);
    const tape = value(decodeTape(recorded.bytes));
    const model = buildFrameModel(tape);
    const taa = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' && shader.source?.includes('struct TaaResolveParams'),
      ),
    );
    expect(taa, 'real TAAU resolve draw').toBeDefined();
    const creates: readonly V7RhiCallEvent[] = [
      ...tape.bootstrap.map((resource) => resource.create as unknown as V7RhiCallEvent),
      ...tape.events,
    ];
    const textureForView = (viewId: string | null) => {
      const view = creates.find(
        (event) => event.kind === 'createTextureView' && event.resultHandleId === viewId,
      );
      if (view?.kind !== 'createTextureView') return;
      const texture = creates.find(
        (event) => event.kind === 'createTexture' && event.handleId === view.sourceHandleId,
      );
      return texture?.kind === 'createTexture' ? texture : undefined;
    };
    const taaTextures = taa?.bindings.flatMap((binding) => {
      const texture = textureForView(binding.resourceId);
      return texture === undefined ? [] : [{ binding: binding.binding, ...texture }];
    });
    // Inspect real RHI bindings, not only the Renderer's declared extent.
    expect(taaTextures?.find((texture) => texture.binding === 0)?.desc.size).toMatchObject({
      width: renderer.inspect().dynamicResolution?.extent?.internalWidth ?? 128,
      height: renderer.inspect().dynamicResolution?.extent?.internalHeight ?? 128,
    });
    expect(taaTextures?.find((texture) => texture.binding === 2)?.desc.size).toMatchObject({
      width: 128,
      height: 128,
    });
    await save(
      `${name}-resources.json`,
      new TextEncoder().encode(
        JSON.stringify(
          {
            taaTextures,
            unseeded: model.unseededResources.map((resource) => ({
              ...resource,
              views: creates.filter(
                (event) =>
                  event.kind === 'createTextureView' &&
                  event.sourceHandleId === resource.resourceId,
              ),
            })),
            passes: tape.events.filter((event) => event.kind === 'beginRenderPass'),
          },
          null,
          2,
        ),
      ),
    );
    const output = model.works
      .filter((work) => (work.attachments?.colorViewHandleIds.length ?? 0) > 0)
      .at(-1);
    if (output === undefined) throw new Error('missing output work');
    const adapter = value(await webgpu.rhi.requestAdapter());
    const device = value(
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits)),
    );
    const replay = value(
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule }),
    );
    let maxError = 0;
    try {
      const inspected = value(
        await replay.inspectWork(output.workIndex, ['pipeline', 'bindings', 'pixels']),
      );
      if (inspected.attachment === undefined) throw new Error('missing replay output');
      expect(inspected.attachment.bytes.length).toBe(live.length);
      for (let i = 0; i < live.length; i++)
        maxError = Math.max(
          maxError,
          Math.abs((live[i] ?? NaN) - (inspected.attachment.bytes[i] ?? NaN)) / 255,
        );
      expect(maxError).toBeLessThanOrEqual(0.05);
    } finally {
      value(await replay.dispose());
    }
    // Falsifier: a missing output draw must change the captured picture.
    const missing = value(
      encodeTape({
        ...tape,
        events: tape.events.map((event, index) =>
          index === output.eventIndex && event.kind === 'draw'
            ? { ...event, vertexCount: 0 }
            : event,
        ),
      }),
    );
    const falsifier = value(
      await openReplay(value(decodeTape(missing)), {
        device,
        createShaderModule: webgpu.createShaderModule,
      }),
    );
    try {
      const inspected = value(await falsifier.inspectWork(output.workIndex, ['pixels']));
      expect(inspected.attachment?.bytes).not.toEqual(live);
    } finally {
      value(await falsifier.dispose());
      webgpu._internal_getRawDevice(device)?.destroy();
    }
    reports.push({
      name,
      digest: recorded.digest,
      taaWork: taa?.workIndex,
      outputWork: output.workIndex,
      eventIndex: output.eventIndex,
      unseededResources: model.unseededResources,
      maxError,
      inspection: renderer.inspect().dynamicResolution,
    });
  };
  try {
    for (let i = 0; i < 60; i++) await draw();
    expect(renderer.inspect().dynamicResolution).toBeUndefined();
    await capture('native');
    world
      .addComponent(camera, {
        component: DynamicResolution,
        data: { targetGpuMs: 0.0001, minScale: 0.5, maxScale: 1 },
      })
      .unwrap();
    for (let i = 0; i < 120; i++) await draw();
    expect(renderer.inspect().dynamicResolution).toMatchObject({
      status: 'adaptive',
      extent: { scale: 0.5, internalWidth: 64, internalHeight: 64 },
    });
    expect(renderer.inspect().temporalTarget?.descriptor).toMatchObject({ width: 64, height: 64 });
    expect(renderer.inspect().temporal.coverage).toEqual({ width: 128, height: 128 });
    await capture('reduced');
    world.set(camera, DynamicResolution, { targetGpuMs: 10000 }).unwrap();
    await draw();
    expect(renderer.inspect().dynamicResolution?.extent?.scale).toBe(0.5);
    for (let i = 0; i < 180; i++) await draw();
    expect(renderer.inspect().dynamicResolution).toMatchObject({
      status: 'adaptive',
      extent: { scale: 1, internalWidth: 128 },
    });
    await capture('restored');
    world.removeComponent(camera, DynamicResolution).unwrap();
    for (let i = 0; i < 60; i++) await draw();
    expect(renderer.inspect().dynamicResolution).toBeUndefined();
    expect(renderer.inspect().perFramePassNames).not.toContain('standard-scene-coverage');
    expect(errors, JSON.stringify(errors)).toEqual([]);
    await save(
      'report.json',
      new TextEncoder().encode(
        JSON.stringify(
          { frames, reports, errors, capability: renderer.inspect().capabilities },
          null,
          2,
        ),
      ),
    );
  } catch (error) {
    await save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify({ error: String(error), errors, inspection: renderer.inspect() }, null, 2),
      ),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
