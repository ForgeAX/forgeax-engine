import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
  resolveVisibleSurface,
  ShadowParticipation,
} from '@forgeax/engine-render';
import type { RhiBackendInstrumentation } from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  type FrameModel,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;

function visibleSurfaceViewIds(model: FrameModel): ReadonlySet<string> {
  const textures = new Set(
    model.resources
      .filter(
        (resource) =>
          resource.kind === 'texture' &&
          (resource.descriptor as { desc?: { label?: string } } | null)?.desc?.label ===
            'visible-surface',
      )
      .map((resource) => resource.resourceId),
  );
  if (textures.size === 0) throw new Error('missing captured visible surface');
  return new Set(
    model.resources
      .filter(
        (resource) =>
          resource.kind === 'texture-view' &&
          textures.has(
            (resource.descriptor as { sourceHandleId?: string } | null)?.sourceHandleId ?? '',
          ),
      )
      .map((resource) => resource.resourceId),
  );
}

/** A real disocclusion must populate the receiver attachment in the late phase. */
async function verifyRevealedSurfaceReplay(bytes: Uint8Array, expected: Uint8Array, save: Save) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const surfaces = visibleSurfaceViewIds(model);
  const phases = model.passes.filter((pass) =>
    surfaces.has(pass.colorAttachmentViewHandleIds[6] ?? ''),
  );
  expect(phases).toHaveLength(2);
  const early = phases[0];
  const late = phases[1];
  const earlyWork = early?.workIndices.at(-1);
  const lateWork = late?.workIndices.at(-1);
  const identity = late?.colorAttachmentViewHandleIds[6];
  if (earlyWork === undefined || lateWork === undefined || identity === undefined || !late)
    throw new Error('missing early/late receiver work');
  const removed = new Set(late.workIndices.map((index) => model.works[index]?.eventIndex));
  const falsified = encodeTape({
    ...tape,
    events: tape.events.map((event, index) =>
      removed.has(index) && event.kind === 'drawIndexedIndirect'
        ? {
            kind: 'drawIndexed' as const,
            passHandleId: event.passHandleId,
            indexCount: 0,
            instanceCount: 0,
            firstIndex: 0,
            baseVertex: 0,
            firstInstance: 0,
          }
        : event,
    ),
  }).unwrap();
  await save('occlusion-reveal-missing-late.rhitape', falsified);
  for (const [name, input] of [
    ['occlusion-reveal', bytes],
    ['occlusion-reveal-missing-late', falsified],
  ] as const) {
    const decoded = decodeTape(input).unwrap();
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(decoded, adapter.features, adapter.limits))
    ).unwrap();
    const native = webgpu._internal_getRawDevice(device);
    expect(native).toBeDefined();
    const gpuErrors: string[] = [];
    native?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const replay = (
      await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const before = (await replay.readResourceAtWork(identity, earlyWork)).unwrap().bytes;
      const after = (await replay.readResourceAtWork(identity, lateWork)).unwrap().bytes;
      expect(before.every((value) => value === 0)).toBe(true);
      if (name === 'occlusion-reveal') expect(after).toEqual(expected);
      else expect(after.every((value) => value === 0)).toBe(true);
      expect(gpuErrors).toEqual([]);
      await save(`${name}-early.rgba32uint`, before);
      await save(`${name}-late.rgba32uint`, after);
    } finally {
      (await replay.dispose()).unwrap();
      native?.destroy();
    }
  }
}

async function verifyTemporalReplay(
  name: string,
  bytes: Uint8Array,
  expected: Uint8Array,
  save: Save,
) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const resource = model.resources.find(
    (resource) =>
      (resource.descriptor as { desc?: { label?: string } } | null)?.desc?.label ===
      'standard-scene-temporal',
  );
  const work = model.works.at(-1);
  if (resource === undefined || work === undefined)
    throw new Error('missing captured temporal frame');
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const gpuErrors: string[] = [];
  const native = webgpu._internal_getRawDevice(device);
  expect(native).toBeDefined();
  native?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  const replay = (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const read = (await replay.readResourceAtWork(resource.resourceId, work.workIndex)).unwrap();
    expect(read.bytes).toEqual(expected);
    expect(gpuErrors).toEqual([]);
    await save(`${name}-replay.rgba16float`, read.bytes);
  } finally {
    (await replay.dispose()).unwrap();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}

/** Ordinary Renderer output; the native hook observes allocation, never supplies rendering work. */
export async function verifyVisibleSurfaceReplay(
  canvas: Pick<HTMLCanvasElement, 'width' | 'height' | 'getContext'>,
  save: Save,
  manifestUrl?: string,
) {
  const recorder = attachRecorder(webgpu).unwrap();
  let native: GPUDevice | undefined;
  const gpuErrors: string[] = [];
  let surface: GPUTexture | undefined;
  let temporal: GPUTexture | undefined;
  let rejectSubmit = false;
  let loseDevice: (() => void) | undefined;
  let onObservationMapped: (() => Promise<void>) | undefined;
  const instrumentation: RhiBackendInstrumentation = {
    beforeSubmit() {
      if (!rejectSubmit) return undefined;
      rejectSubmit = false;
      return new RhiError({
        code: 'queue-submit-failed',
        expected: 'injected visible-surface submission failure',
        hint: 'retry the uncommitted frame',
      });
    },
    deviceLost: () =>
      new Promise((resolve) => {
        loseDevice = () =>
          resolve({
            reason: 'unknown',
            message: 'host-injected visible-surface recovery; no driver reset claimed',
          });
      }),
    onDeviceLost: () => recorder.deviceLost(),
  };
  const backend = {
    ...recorder.backend.rhi,
    requestAdapter: async (...args: Parameters<typeof recorder.backend.rhi.requestAdapter>) => {
      const result = await recorder.backend.rhi.requestAdapter(...args);
      if (!result.ok) return result;
      const adapter = result.value;
      return ok(
        new Proxy(adapter, {
          get(target, key) {
            if (key === 'requestDevice')
              return async (...request: Parameters<typeof adapter.requestDevice>) => {
                const created = await adapter.requestDevice(...request);
                if (created.ok) {
                  native = webgpu._internal_getRawDevice(
                    recorder.backend.unwrapDeviceForSurface(created.value).unwrap(),
                  );
                  expect(native).toBeDefined();
                  if (native !== undefined) {
                    native.addEventListener('uncapturederror', (event) =>
                      gpuErrors.push(event.error.message),
                    );
                    const createBuffer = native.createBuffer.bind(native);
                    native.createBuffer = (descriptor) => {
                      const buffer = createBuffer(descriptor);
                      if (descriptor.label === 'visible-surface-observation-readback') {
                        const mapAsync = buffer.mapAsync.bind(buffer);
                        buffer.mapAsync = async (...args) => {
                          await mapAsync(...args);
                          const pause = onObservationMapped;
                          onObservationMapped = undefined;
                          await pause?.();
                        };
                      }
                      return buffer;
                    };
                    const temporalViews = new WeakMap<GPUTexture | GPUTextureView, GPUTexture>();
                    const createTexture = native.createTexture.bind(native);
                    native.createTexture = (descriptor) => {
                      const texture = createTexture(descriptor);
                      if (descriptor.label === 'visible-surface') surface = texture;
                      if (descriptor.label === 'standard-scene-temporal') {
                        temporalViews.set(texture, texture);
                        const createView = texture.createView.bind(texture);
                        texture.createView = (options) => {
                          const view = createView(options);
                          temporalViews.set(view, texture);
                          return view;
                        };
                      }
                      return texture;
                    };
                    const createEncoder = native.createCommandEncoder.bind(native);
                    native.createCommandEncoder = (options) => {
                      const encoder = createEncoder(options);
                      const beginRenderPass = encoder.beginRenderPass.bind(encoder);
                      encoder.beginRenderPass = (descriptor) => {
                        for (const attachment of descriptor.colorAttachments) {
                          if (attachment !== null)
                            temporal = temporalViews.get(attachment.view) ?? temporal;
                        }
                        return beginRenderPass(descriptor);
                      };
                      return encoder;
                    };
                  }
                }
                return created;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      );
    },
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: backend, rhiInstrumentation: instrumentation },
      manifestUrl === undefined ? undefined : { shaderManifestUrl: manifestUrl },
    ),
  );
  const renderer = host.renderer;
  const requestObservation = renderer.requestObservation?.bind(renderer);
  if (requestObservation === undefined) throw new Error('visible-surface observation unavailable');
  const original = renderer.inspect().profile;
  const world = new World();
  const identity = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const box = createBoxGeometry(1, 1, 0.1).unwrap();
  const normals = box.attributes.normal;
  if (!(normals instanceof Float32Array)) throw new Error('box normals must be Float32Array');
  // Independently authored shading normals must not tilt the geometric normal.
  for (let vertex = 16; vertex < 20; vertex++) {
    box.vertices.set([Math.SQRT1_2, 0, Math.SQRT1_2], vertex * 12 + 3);
    normals.set([Math.SQRT1_2, 0, Math.SQRT1_2], vertex * 3);
  }
  const submesh = box.submeshes[0];
  if (submesh === undefined) throw new Error('box has no submesh');
  const mesh = {
    ...box,
    submeshes: [
      { ...submesh, indexOffset: 0, indexCount: 24, materialSlot: 0 },
      { ...submesh, indexOffset: 24, indexCount: 3, materialSlot: 0 },
      { ...submesh, indexOffset: 27, indexCount: 3, materialSlot: 1 },
      { ...submesh, indexOffset: 30, indexCount: 6, materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'solid' }, { slotName: 'cutout' }],
  };
  const solid = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.6, 0.2, 0.1, 1] }),
  );
  const cutout = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.6, 0.2, 0.1, 0], alphaCutoff: 0.5 }),
  );
  let entity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', mesh),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [solid, solid],
        },
      },
      {
        component: Instances,
        data: { transforms: new Float32Array([...identity(-0.8), ...identity(0.8)]) },
      },
      { component: ShadowParticipation, data: { cast: true, receive: true } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 10,
          antialias: 0,
          bloom: 0,
        },
      },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const results: unknown[] = [];
  let direct: Uint8Array | undefined;
  let activeLane: 'direct' | 'automatic' = 'direct';
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: activeLane,
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(submit());
    renderValue(await receipt.completed);
    return receipt;
  };
  const readTemporal = async (name: string) => {
    if (native === undefined || temporal === undefined) throw new Error('missing temporal target');
    const stride = Math.ceil((canvas.width * 8) / 256) * 256;
    const buffer = native.createBuffer({
      size: stride * canvas.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: temporal }, { buffer, bytesPerRow: stride }, [
        canvas.width,
        canvas.height,
      ]);
      native.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange());
      const bytes = new Uint8Array(canvas.width * canvas.height * 8);
      for (let y = 0; y < canvas.height; y++)
        bytes.set(padded.subarray(y * stride, y * stride + canvas.width * 8), y * canvas.width * 8);
      await save(`${name}-temporal.rgba16float`, bytes);
      return bytes;
    } finally {
      buffer.destroy();
    }
  };

  try {
    renderValue(
      renderer.setProfile({
        ...original,
        renderPath: 'deferred',
        visibleSurface: true,
      }),
    );
    for (const lane of ['direct', 'automatic'] as const) {
      activeLane = lane;
      const receiveShadows = lane === 'automatic';
      world.set(entity, ShadowParticipation, { receive: receiveShadows }).unwrap();
      for (let i = 0; i < 8; i++) await draw();
      renderValue(requestObservation(['visible-surface']));
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const capturedReceipt = await draw();
      const temporalLive = await readTemporal(lane);
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await save(`${lane}.rhitape`, captured.bytes);
      await save(
        `${lane}-inspection.json`,
        new TextEncoder().encode(JSON.stringify(renderer.inspect(), null, 2)),
      );
      if (native === undefined || surface === undefined)
        throw new Error('visible surface was not allocated by Renderer');
      const liveBuffer = native.createBuffer({
        size: 64 * 64 * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = native.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: surface },
          { buffer: liveBuffer, bytesPerRow: 64 * 16 },
          [64, 64],
        );
        native.queue.submit([encoder.finish()]);
        await liveBuffer.mapAsync(GPUMapMode.READ);
        const live = new Uint8Array(liveBuffer.getMappedRange().slice(0));
        world.set(entity, MeshRenderer, { materials: [solid, cutout] }).unwrap();
        for (let i = 0; i < 4; i++) await draw();
        renderValue(requestObservation(['visible-surface']));
        const maskPending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const maskReceipt = await draw();
        (await recorder.frameBoundary()).unwrap();
        await save(`${lane}-masked.rhitape`, (await maskPending).unwrap().bytes);
        const maskResult = renderValue(
          await renderer.observe(maskReceipt, { include: ['visible-surface'] }),
        );
        const masked = maskResult.observations?.find((item) => item.domain === 'visible-surface');
        if (masked?.domain !== 'visible-surface') throw new Error('missing cutout observation');
        const maskWords = new Uint32Array(masked.bytes.buffer);
        const maskRows = Array.from({ length: 4096 }, (_, i) => i).filter(
          (i) => ((maskWords[i * 4 + 3] ?? 0) & 1) !== 0,
        );
        await save(`${lane}-masked.rgba32uint`, masked.bytes);
        await save(`${lane}-masked-records.u32`, new Uint8Array(masked.records.buffer));
        expect([...new Set(maskRows.map((i) => maskWords[i * 4]))].sort()).toEqual([3, 4]);
        expect(maskRows.length).toBeGreaterThan(100);
        expect(maskRows.length).toBeLessThan(300);
        world.set(entity, MeshRenderer, { materials: [solid, solid] }).unwrap();
        const observation = renderValue(
          await renderer.observe(capturedReceipt, { include: ['visible-surface'] }),
        );
        const observed = observation.observations?.find(
          (item) => item.domain === 'visible-surface',
        );
        if (observed?.domain !== 'visible-surface')
          throw new Error('missing receipt surface observation');
        expect(observed.bytes).toEqual(live);
        expect(observed.records).toHaveLength(128);
        expect(observed.metadata.frameId).toBe(capturedReceipt.frameId);
        await save(`${lane}-surface-records.u32`, new Uint8Array(observed.records.buffer));
        await save(`${lane}-live.rgba32uint`, live);
        const words = new Uint32Array(live.buffer);
        const covered = Array.from({ length: 4096 }, (_, i) => i).filter(
          (i) => ((words[i * 4 + 3] ?? 0) & 1) !== 0,
        );
        expect(covered.length).toBeGreaterThan(100);
        expect([...new Set(covered.map((i) => words[i * 4]))].sort()).toEqual([3, 4, 5, 6]);
        expect(covered.every((i) => words[i * 4 + 1] === 0)).toBe(true);
        if (direct === undefined) direct = live;
        else expect(live).toEqual(direct);
        const tape = decodeTape(captured.bytes).unwrap();
        const model = buildFrameModel(tape);
        const surfaces = visibleSurfaceViewIds(model);
        const geometry = model.works
          .filter((work) => surfaces.has(work.attachments?.colorViewHandleIds[6] ?? ''))
          .at(-1);
        if (geometry === undefined) throw new Error('missing visible surface geometry work');
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const fresh = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const replayNative = webgpu._internal_getRawDevice(fresh);
        expect(replayNative).toBeDefined();
        replayNative?.addEventListener('uncapturederror', (event) =>
          gpuErrors.push(event.error.message),
        );
        const replay = (
          await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const resource = geometry.attachments?.colorViewHandleIds[6];
          if (resource === undefined) throw new Error('missing visible surface attachment');
          const read = (await replay.readResourceAtWork(resource, geometry.workIndex)).unwrap();
          expect(read.bytes).toEqual(live);
          await save(`${lane}-replay.rgba32uint`, read.bytes);
          const contextResource = geometry.attachments?.colorViewHandleIds[4];
          if (contextResource === undefined) throw new Error('missing lighting context attachment');
          const contextRead = (
            await replay.readResourceAtWork(contextResource, geometry.workIndex)
          ).unwrap();
          const contexts = new Uint32Array(
            contextRead.bytes.buffer,
            contextRead.bytes.byteOffset,
            contextRead.bytes.byteLength / 4,
          );
          for (const pixel of covered)
            expect(((contexts[pixel] ?? 0) & 0x800000) === 0).toBe(receiveShadows);
          await save(`${lane}-lighting-context.r32uint`, contextRead.bytes);
          if (lane === 'automatic') {
            const binding = geometry.bindings.find(
              (entry) => entry.groupIndex === 3 && entry.binding === 7,
            );
            if (binding?.resourceId == null)
              throw new Error('missing GPU Scene receiver address binding');
            const addresses = (
              await replay.readResourceAtWork(binding.resourceId, geometry.workIndex)
            ).unwrap().bytes;
            const addressRows = new Uint32Array(
              addresses.buffer,
              addresses.byteOffset,
              addresses.byteLength / 4,
            );
            // Four source submeshes share two GPU Scene instance rows but need eight distinct receiver identities.
            expect([...addressRows].filter((row) => row !== 0).sort((a, b) => a - b)).toEqual([
              1, 2, 3, 4, 5, 6, 7, 8,
            ]);
            expect(
              model.resources.some(
                (entry) =>
                  entry.resourceId === binding.resourceId &&
                  (entry.descriptor as { desc?: { label?: string } } | null)?.desc?.label ===
                    'gpu-driven-view-visibleSurfaceRows',
              ),
            ).toBe(true);
            await save(`${lane}-candidate-surface-rows.u32`, addresses);
          }
          const shadingResource = geometry.attachments?.colorViewHandleIds[1];
          if (shadingResource === undefined) throw new Error('missing shading normal attachment');
          const shadingRead = (
            await replay.readResourceAtWork(shadingResource, geometry.workIndex)
          ).unwrap();
          await save(`${lane}-shading-normal.r32uint`, shadingRead.bytes);
          const shading = new Uint32Array(
            shadingRead.bytes.buffer,
            shadingRead.bytes.byteOffset,
            shadingRead.bytes.byteLength / 4,
          );
          const normal = (word: number) => {
            const x = (word & 4095) * (2 / 4095) - 1;
            const y = ((word >>> 12) & 4095) * (2 / 4095) - 1;
            const z = 1 - Math.abs(x) - Math.abs(y);
            const length = Math.hypot(x, y, z);
            return [x / length, y / length, z / length];
          };
          for (const pixel of covered) {
            expect(normal(words[pixel * 4 + 2] ?? 0)[2]).toBeGreaterThan(0.999);
            const actual = normal(shading[pixel] ?? 0);
            expect(actual[0]).toBeCloseTo(Math.SQRT1_2, 3);
            expect(actual[2]).toBeCloseTo(Math.SQRT1_2, 3);
          }
          const temporalResource = model.resources.find(
            (resource) =>
              (resource.descriptor as { desc?: { label?: string } } | null)?.desc?.label ===
              'standard-scene-temporal',
          );
          if (temporalResource === undefined) throw new Error('missing captured temporal resource');
          const lastWork = model.works.at(-1);
          if (lastWork === undefined) throw new Error('missing frame work');
          const temporalRead = (
            await replay.readResourceAtWork(temporalResource.resourceId, lastWork.workIndex)
          ).unwrap();
          expect(temporalRead.bytes).toEqual(temporalLive);
          results.push({
            lane,
            covered: covered.length,
            bytes: live.byteLength,
            mismatches: 0,
            workIndex: geometry.workIndex,
            maskedCovered: maskRows.length,
            oldReceiptAfterMaterialChange: true,
            independentNormals: true,
            receiveShadows,
            shadowContextAndSurfaceIdentity: true,
            temporalReplayMatches: true,
          });
        } finally {
          (await replay.dispose()).unwrap();
          webgpu._internal_getRawDevice(fresh)?.destroy();
        }
      } finally {
        liveBuffer.destroy();
      }
    }
    const snapshot = async (name: string) => {
      renderValue(requestObservation(['visible-surface']));
      const receipt = await draw();
      const result = renderValue(await renderer.observe(receipt, { include: ['visible-surface'] }));
      const surface = result.observations?.find((item) => item.domain === 'visible-surface');
      if (surface?.domain !== 'visible-surface') throw new Error('missing surface snapshot');
      await save(`${name}.rgba32uint`, surface.bytes);
      await save(`${name}-records.u32`, new Uint8Array(surface.records.buffer));
      const words = new Uint32Array(surface.bytes.buffer);
      let covered = 0;
      for (let i = 3; i < words.length; i += 4) if (((words[i] ?? 0) & 1) !== 0) covered++;
      const temporalBytes = await readTemporal(name);
      const halfs = new Uint16Array(temporalBytes.buffer);
      const samples = Array.from({ length: canvas.width * canvas.height }, (_, i) => i)
        .filter(
          (i) =>
            ((words[
              (Math.floor(i / canvas.width) * surface.metadata.bytesPerRow) / 4 +
                (i % canvas.width) * 4 +
                3
            ] ?? 0) &
              1) !==
            0,
        )
        .map((i) => Array.from(halfs.subarray(i * 4, i * 4 + 4), halfToFloat));
      const motion = [0, 1, 2, 3].map(
        (channel) =>
          samples.reduce((sum, sample) => sum + (sample[channel] ?? NaN), 0) /
          Math.max(1, samples.length),
      );
      results.push({
        scenario: name,
        covered,
        records: surface.records.length / 16,
        frameId: receipt.frameId,
        width: surface.metadata.width,
        height: surface.metadata.height,
        temporalMean: motion,
        graphAllocation: renderer.inspect().renderGraphResourceAllocation,
        generationAllocation: renderer.inspect().renderGraphGenerationAllocation,
        observationAllocation: renderer.inspect().observation.resourceStats,
      });
      return { receipt, surface, covered, motion, temporalBytes };
    };
    // Warm an actual opaque occluder, then move it out of view without a camera
    // cut. Cold starts draw conservatively early and cannot prove late writes.
    const unobscured = await snapshot('occlusion-unobscured');
    const occluder = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -2] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(4, 3, 0.1).unwrap()),
          },
        },
        { component: MeshRenderer, data: { materials: [solid] } },
      )
      .unwrap();
    for (let i = 0; i < 8; i++) await draw();
    const occluded = await snapshot('occlusion-hidden');
    expect(occluded.covered).toBeGreaterThan(1000);
    world.set(occluder, Transform, { pos: [20, 0, -2] }).unwrap();
    const revealCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const revealed = await snapshot('occlusion-reveal');
    (await recorder.frameBoundary()).unwrap();
    const revealBytes = (await revealCapture).unwrap().bytes;
    await save('occlusion-reveal.rhitape', revealBytes);
    expect(revealed.covered).toBe(unobscured.covered);
    await verifyRevealedSurfaceReplay(revealBytes, revealed.surface.bytes, save);
    world.despawn(occluder).unwrap();
    for (let i = 0; i < 4; i++) await draw();
    const before = await snapshot('before-instance-removal');
    const prior = resolveVisibleSurface(before.surface, 3, 0).unwrap();
    if (prior === undefined) throw new Error('missing prior surface');
    world.set(entity, Instances, { transforms: new Float32Array(identity(0.8)) }).unwrap();
    const instanceCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const reduced = await snapshot('instance-removed');
    (await recorder.frameBoundary()).unwrap();
    await save('instance-removed.rhitape', (await instanceCapture).unwrap().bytes);
    expect(reduced.surface.records.length).toBe(64);
    expect(reduced.covered).toBe(before.covered / 2);
    expect(resolveVisibleSurface(reduced.surface, 2, 0).unwrap()?.instanceGeneration).not.toBe(
      prior.instanceGeneration,
    );
    expect(resolveVisibleSurface(before.surface, 3, 0).unwrap()).toEqual(prior);
    expect(reduced.motion[3]).toBeGreaterThanOrEqual(2);
    world
      .set(entity, Instances, {
        transforms: new Float32Array([...identity(0.8), ...identity(-0.8)]),
      })
      .unwrap();
    const replaced = await snapshot('instances-reseeded');
    expect(replaced.covered).toBe(before.covered);
    expect(resolveVisibleSurface(replaced.surface, 3, 0).unwrap()?.instanceGeneration).not.toBe(
      prior.instanceGeneration,
    );
    expect(replaced.motion[3]).toBeGreaterThanOrEqual(2);
    for (const lane of ['direct', 'automatic'] as const) {
      activeLane = lane;
      world
        .set(entity, Instances, {
          transforms: new Float32Array([...identity(0.8), ...identity(-0.8)]),
        })
        .unwrap();
      await draw();
      await draw();
      world
        .set(entity, Instances, {
          transforms: new Float32Array([...identity(1.0), ...identity(-0.6)]),
        })
        .unwrap();
      const instanceMoved = await snapshot(`instances-moved-${lane}`);
      expect(instanceMoved.motion[0]).toBeCloseTo(0.2 / (3.95 * Math.tan(Math.PI / 6) * 2), 3);
      expect(instanceMoved.motion[3]).toBe(0);
      const settledCapture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const name = `instances-settled-${lane}`;
      const instanceSettled = await snapshot(name);
      (await recorder.frameBoundary()).unwrap();
      const bytes = (await settledCapture).unwrap().bytes;
      await save(`${name}.rhitape`, bytes);
      await save(
        `${name}-inspection.json`,
        new TextEncoder().encode(JSON.stringify(renderer.inspect(), null, 2)),
      );
      expect(instanceSettled.covered).toBe(instanceMoved.covered);
      expect(instanceSettled.motion[0]).toBeCloseTo(0, 5);
      expect(instanceSettled.motion[1]).toBeCloseTo(0, 5);
      expect(instanceSettled.motion[3]).toBe(0);
      await verifyTemporalReplay(name, bytes, instanceSettled.temporalBytes, save);
    }
    world
      .set(entity, Instances, {
        transforms: new Float32Array([...identity(0.8), ...identity(-0.8)]),
      })
      .unwrap();
    await draw();
    const editedMaterial = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.1, 0.4, 0.7, 1] }),
    );
    world.set(entity, MeshRenderer, { materials: [editedMaterial, solid] }).unwrap();
    const materialEdited = await snapshot('material-edited');
    expect(materialEdited.motion[3]).toBe(3);
    world.set(entity, MeshRenderer, { materials: [solid, solid] }).unwrap();
    await draw();
    world.set(camera, Transform, { pos: [0.3, 0, 0] }).unwrap();
    const motionCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const moved = await snapshot('camera-moved');
    (await recorder.frameBoundary()).unwrap();
    const motionTapeBytes = (await motionCapture).unwrap().bytes;
    await save('camera-moved.rhitape', motionTapeBytes);
    await verifyTemporalReplay('camera-moved', motionTapeBytes, moved.temporalBytes, save);

    expect(Math.abs(moved.motion[0] ?? NaN)).toBeCloseTo(
      0.3 / (3.95 * Math.tan(Math.PI / 6) * 2),
      3,
    );
    expect(moved.motion[1]).toBeCloseTo(0, 4);
    expect(moved.motion[3]).toBe(0);
    expect(errors).toEqual([]);
    world.set(camera, Transform, { pos: [0.5, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    renderValue(requestObservation(['visible-surface']));
    rejectSubmit = true;
    expect(submit().ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    errors.length = 0;
    const retried = await snapshot('submit-retried');
    expect(retried.receipt.frameId).toBe(moved.receipt.frameId + 1);
    expect(Math.abs(retried.motion[0] ?? NaN)).toBeCloseTo(
      0.2 / (3.95 * Math.tan(Math.PI / 6) * 2),
      3,
    );
    expect(retried.surface.records).toEqual(moved.surface.records);
    world.set(camera, Transform, { pos: [0.3, 0, 0] }).unwrap();
    await draw();
    // The bounded existing observation owner admits four unread captures.
    const pending = [];
    for (let i = 0; i < 4; i++) {
      renderValue(requestObservation(['visible-surface']));
      pending.push(await draw());
    }
    expect(requestObservation(['visible-surface']).ok).toBe(false);
    expect(renderer.inspect().observation.resourceStats).toMatchObject({
      liveCount: 4,
      liveByteLength: 4 * 64 * 64 * 16,
    });
    results.push({
      scenario: 'four-unread',
      allocation: renderer.inspect().observation.resourceStats,
    });
    for (const receipt of pending)
      renderValue(await renderer.observe(receipt, { include: ['visible-surface'] }));
    expect(renderer.inspect().observation.resourceStats).toMatchObject({
      liveCount: 0,
      liveByteLength: 0,
    });
    // A copy from the old extent remains bound to its receipt after resize.
    renderValue(requestObservation(['visible-surface']));
    const oldExtent = await draw();
    canvas.width = 80;
    canvas.height = 48;
    world.set(camera, Camera, { aspect: 80 / 48 }).unwrap();
    const resized = await snapshot('resized');
    expect(resized.surface.metadata.width).toBe(80);
    expect(resized.surface.metadata.height).toBe(48);
    const oldResult = renderValue(
      await renderer.observe(oldExtent, { include: ['visible-surface'] }),
    );
    expect(oldResult.observations?.[0]?.metadata.width).toBe(64);
    renderValue(
      renderer.setProfile({
        ...original,
        renderPath: 'deferred',
        visibleSurface: false,
      }),
    );
    await draw();
    expect(requestObservation(['visible-surface']).ok).toBe(false);
    expect(renderer.inspect().perFramePassNames).not.toContain('visible-surface-observation');
    const disabledAllocation = renderer.inspect().observation.resourceStats;
    await draw();
    expect(renderer.inspect().observation.resourceStats).toEqual(disabledAllocation);
    results.push({
      scenario: 'disabled',
      graphAllocation: renderer.inspect().renderGraphResourceAllocation,
      generationAllocation: renderer.inspect().renderGraphGenerationAllocation,
      observationAllocation: disabledAllocation,
    });
    renderValue(
      renderer.setProfile({
        ...original,
        renderPath: 'deferred',
        visibleSurface: true,
      }),
    );
    for (let i = 0; i < 4; i++) await draw();
    const enabled = await snapshot('re-enabled');
    expect(enabled.covered).toBe(resized.covered);
    world.despawn(entity).unwrap();
    const empty = await snapshot('entity-deleted');
    expect(empty.covered).toBe(0);
    expect(empty.surface.records).toHaveLength(0);
    entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -4] } },
        { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
        { component: MeshRenderer, data: { materials: [solid, solid] } },
        {
          component: Instances,
          data: { transforms: new Float32Array([...identity(-0.8), ...identity(0.8)]) },
        },
      )
      .unwrap();
    for (let i = 0; i < 4; i++) await draw();
    const reused = await snapshot('entity-reused');
    expect(reused.covered).toBeGreaterThan(0);
    const current = resolveVisibleSurface(reused.surface, 3, 0).unwrap();
    if (current === undefined) throw new Error('missing current surface');
    expect([current.entityKey, current.generation]).not.toEqual([
      prior.entityKey,
      prior.generation,
    ]);
    expect(resolveVisibleSurface(before.surface, 3, 0).unwrap()).toEqual(prior);
    renderValue(requestObservation(['visible-surface']));
    const beforeLoss = await draw();
    const lostNative = native;
    // Pause a real successful map; loss must also invalidate an in-flight read.
    let releaseMap = () => {};
    const held = new Promise<void>((resolve) => {
      releaseMap = resolve;
    });
    let enteredMap = () => {};
    const mapped = new Promise<void>((resolve) => {
      enteredMap = resolve;
    });
    onObservationMapped = async () => {
      enteredMap();
      await held;
    };
    const readingDuringLoss = renderer.observe(beforeLoss, { include: ['visible-surface'] });
    await mapped;
    loseDevice?.();
    for (let i = 0; i < 100 && renderer.state() !== 'device-lost'; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    releaseMap();
    const lostRead = await readingDuringLoss;
    expect(lostRead.ok).toBe(false);
    if (!lostRead.ok) expect(lostRead.error.code).toBe('frame-receipt-stale');
    expect(renderer.state()).toBe('device-lost');
    expect((await renderer.observe(beforeLoss, { include: ['visible-surface'] })).ok).toBe(false);
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'device-operation-failed',
        detail: expect.objectContaining({
          cause: expect.objectContaining({ code: 'device-lost' }),
        }),
      }),
    ]);
    errors.length = 0;
    renderValue(await renderer.recover());
    lostNative?.destroy();
    expect(native).not.toBe(lostNative);
    const recoveryCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const cold = await snapshot('recovery-cold');
    (await recorder.frameBoundary()).unwrap();
    const recoveryBytes = (await recoveryCapture).unwrap().bytes;
    await save('recovery-cold.rhitape', recoveryBytes);
    expect(cold.covered).toBe(reused.covered);
    expect(cold.receipt.deviceGeneration).toBeGreaterThan(beforeLoss.deviceGeneration);
    // Rebuilt GPU Scene rows seed previous = current. The packed lane carries
    // reactive = 1 plus motion-invalid = 2 until a new submission is accepted.
    expect(cold.motion[3]).toBe(3);
    await verifyTemporalReplay('recovery-cold', recoveryBytes, cold.temporalBytes, save);
    for (let i = 0; i < 4; i++) await draw();
    const recovered = await snapshot('recovered');
    expect(recovered.covered).toBe(reused.covered);
    expect(recovered.motion[0]).toBe(0);
    expect(recovered.motion[3]).toBe(0);
    results.push({
      scenario: 'host-loss-recovery',
      physicalDriverReset: false,
      inFlightReadRejected: true,
      oldGeneration: beforeLoss.deviceGeneration,
      newGeneration: recovered.receipt.deviceGeneration,
    });
    renderValue(requestObservation(['visible-surface']));
    const retired = await draw();
    renderValue(await renderer.dispose());
    expect((await renderer.observe(retired, { include: ['visible-surface'] })).ok).toBe(false);
    expect(renderer.inspect().observation.resourceStats).toMatchObject({
      liveCount: 0,
      liveByteLength: 0,
    });
    // Graph retirement is queue-fenced; dispose initiates it synchronously.
    await expect
      .poll(() => renderer.inspect().renderGraphGenerationAllocation?.pendingRetirementBytes, {
        timeout: 5000,
      })
      .toBe(0);
    for (const generation of renderer.inspect().renderGraphGenerationAllocation?.entries ?? []) {
      expect(generation.allocation.liveBytes).toBe(0);
      expect(generation.allocation.pendingRetirementBytes).toBe(0);
    }
    results.push({
      scenario: 'disposed',
      generationAllocation: renderer.inspect().renderGraphGenerationAllocation,
      observationAllocation: renderer.inspect().observation.resourceStats,
    });
    expect(errors).toEqual([]);
    expect(gpuErrors).toEqual([]);
    await save('result.json', new TextEncoder().encode(JSON.stringify(results, null, 2)));
  } finally {
    await save(
      'latest-state.json',
      new TextEncoder().encode(
        JSON.stringify({ results, errors, gpuErrors, inspection: renderer.inspect() }, null, 2),
      ),
    );
    unsubscribe();
    renderValue(await renderer.dispose());
    (await recorder.dispose()).unwrap();
    native?.destroy();
  }
}
