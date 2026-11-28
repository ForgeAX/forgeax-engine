import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Name, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it, vi } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { basisImages } from '../../../app/__tests__/render-worker-basis-data';
import { loadRhiPack } from '../assembly/backend-contract';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { BarrelDistortion } from '../components/barrel-distortion';
import { perspective } from '../components/camera';
import { Materials } from '../materials';

it.each([
  'projected',
  'native',
] as const)('rehydrates an encoded texture after %s device loss', async (loss) => {
  const manifest = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderTemplateManifest())], {
      type: 'application/json',
    }),
  );
  let device: GPUDevice | undefined,
    target: GPUTexture | undefined,
    format: GPUTextureFormat = 'rgba8unorm';
  let lose: (() => void) | undefined;
  const failures: unknown[] = [];
  const context = {
    configure(input: GPUCanvasConfiguration) {
      device = input.device;
      format = input.format;
      device.addEventListener('uncapturederror', (event) => failures.push(event.error));
      target?.destroy();
      target = device.createTexture({
        size: [64, 64],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: input.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      assert(target);
      return target;
    },
    unconfigure() {},
  };
  const implementation = await createRenderer(
    { width: 64, height: 64, getContext: () => context },
    {},
    { shaderManifestUrl: manifest, prepareShaderProgramCompiler },
    loadRhiPack(
      webgpu,
      loss === 'native'
        ? undefined
        : {
            deviceLost: () =>
              new Promise((resolve) => {
                lose = () => resolve({ reason: 'unknown', message: 'encoded texture recovery' });
              }),
          },
    ),
  );
  assert((await implementation.initialization).ok);
  implementation.onError((error) => failures.push(error));
  const renderer = exposeRenderer(implementation),
    assets = implementation.assetRegistry;
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const attached = renderer.attach(world);
  assert(attached.ok);
  const lease = attached.value;
  const image = (index: number) => ({
    kind: 'texture' as const,
    encoding: 'ktx2' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 16, height: 16 } },
    format: 'rgba8unorm-srgb' as const,
    colorSpace: 'srgb' as const,
    mips: { kind: 'packed' as const, levelCount: 5 },
    data:
      basisImages[index] ??
      (() => {
        throw new Error('Missing encoded fixture');
      })(),
  });
  const texture = assets.create(image(0)).unwrap();
  const material = assets
    .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: { texture } }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createPrimitiveMesh('cube').unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: 1, aspect: 1, near: 0.1, far: 10 }),
          tonemap: 0,
          antialias: 0,
          bloom: 0,
        },
      },
    )
    .unwrap();
  const createNamedView = () => {
    const output = renderer.createRenderTarget({
      shape: '2d',
      width: 64,
      height: 64,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: false,
      readback: true,
    });
    assert(output.ok);
    const camera = world
      .spawn(
        { component: Name, data: { value: 'recovered readback view' } },
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: 1, aspect: 1, near: 0.1, far: 10 }),
            tonemap: 0,
            antialias: 0,
            bloom: 0,
            target: world.allocSharedRef('RenderTarget', output.value),
          },
        },
      )
      .unwrap();
    return { camera, output: output.value };
  };
  const oldView = loss === 'native' ? createNamedView() : undefined;
  const ready = (sourceWorld = world, sourceLease = lease) =>
    completeReadyFrame(async () => {
      sourceWorld.update(1 / 60).unwrap();
      const drawn = renderer.draw({ source: sourceLease });
      assert(drawn.ok);
      const receipt = drawn.value;
      assert((await receipt.completed).ok);
      return receipt;
    });
  const expectDisplayPixel = async (color: 'red' | 'green' | 'blue') => {
    assert(device && target);
    const buffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target, origin: [32, 32] },
      { buffer, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixel = new Uint8Array(buffer.getMappedRange());
    const red = format.startsWith('bgra') ? 2 : 0;
    expect(pixel[color === 'green' ? 1 : color === 'red' ? red : 2 - red]).toBeGreaterThan(240);
    expect(pixel[color === 'green' ? red : 1]).toBeLessThan(15);
    buffer.unmap();
    buffer.destroy();
  };
  let frames = 0;
  const draw = async (green: boolean) => {
    for (let i = 0; i < 20; i++) {
      await ready();
      frames++;
    }
    await expectDisplayPixel(green ? 'green' : 'red');
  };
  const deliverFences = Promise.withResolvers<void>();
  const deliverMap = Promise.withResolvers<void>();
  try {
    await draw(false);
    assets.replace(texture, image(1)).unwrap();
    await draw(true);
    expect(failures).toEqual([]);
    let oldRead: Promise<unknown> | undefined;
    let oldHdr: Promise<unknown> | undefined;
    let oldMapReturned: Promise<void> | undefined;
    let oldGeneration: number | undefined;
    let staleRangeReads = 0;
    let retirements = 0;
    if (oldView === undefined) {
      assert(lose);
      lose();
    } else {
      for (const stage of ['build', 'finish', 'submit'] as const) {
        assert(device);
        const stageDevice = device;
        const { frameId, deviceGeneration } = renderer.inspect().frame;
        const fault = () => {
          stageDevice.destroy();
          throw new Error('injected device loss before native frame acceptance');
        };
        const createEncoder = stageDevice.createCommandEncoder.bind(stageDevice);
        const intercept =
          stage === 'submit'
            ? vi.spyOn(stageDevice.queue, 'submit').mockImplementationOnce(fault)
            : vi.spyOn(stageDevice, 'createCommandEncoder').mockImplementationOnce((descriptor) => {
                if (stage === 'build') return fault();
                const encoder = createEncoder(descriptor);
                vi.spyOn(encoder, 'finish').mockImplementationOnce(fault);
                return encoder;
              });
        try {
          assert(renderer.requestObservation(['linear-hdr']).ok);
          expect(renderer.draw({ source: lease }).ok, stage).toBe(false);
          expect(renderer.inspect().frame.frameId, stage).toBe(frameId);
          expect(renderer.inspect().observation.resourceStats?.liveByteLength, stage).toBe(0);
        } finally {
          intercept.mockRestore();
        }
        expect((await stageDevice.lost).reason).toBe('destroyed');
        await expect.poll(() => renderer.state()).toBe('device-lost');
        assert((await renderer.recover()).ok);
        expect(device).not.toBe(stageDevice);
        const firstReady = await ready();
        expect(firstReady.deviceGeneration).toBe(deviceGeneration + 1);
        await expectDisplayPixel('green');
      }
      expect(
        failures.filter((error) => (error as { code?: string }).code === 'device-lost'),
      ).toHaveLength(3);
      failures.length = 0;
      assert(device);
      const lostDevice = device;
      const mapped = Promise.withResolvers<GPUBuffer>();
      const hdrMapped = Promise.withResolvers<GPUBuffer>();
      const mapDelivered = Promise.withResolvers<void>();
      oldMapReturned = mapDelivered.promise;
      const create = lostDevice.createBuffer.bind(lostDevice);
      const spy = vi.spyOn(lostDevice, 'createBuffer').mockImplementation((descriptor) => {
        const buffer = create(descriptor);
        const readyMap = descriptor.label?.startsWith('render-target-readback.')
          ? mapped
          : descriptor.label === 'linear-hdr-observation-readback'
            ? hdrMapped
            : undefined;
        if (readyMap === undefined) return buffer;
        const nativeMap = buffer.mapAsync.bind(buffer);
        vi.spyOn(buffer, 'mapAsync').mockImplementation(async (...args) => {
          await nativeMap(...args);
          readyMap.resolve(buffer);
          await deliverMap.promise;
          mapDelivered.resolve();
        });
        return buffer;
      });
      const ticket = renderer.requestTargetReadback(oldView.output, { mipLevel: 0 });
      assert(ticket.ok);
      assert(renderer.requestObservation(['linear-hdr']).ok);
      const receipt = await ready();
      spy.mockRestore();
      oldGeneration = receipt.deviceGeneration;
      let verdict: unknown;
      oldRead = renderer
        .observe(receipt, {
          include: ['target-readbacks'],
          targetReadbacks: [ticket.value],
        })
        .then((result) => {
          verdict = result;
          return result;
        });
      let hdrVerdict: unknown;
      oldHdr = renderer.observe(receipt, { include: ['linear-hdr'] }).then((result) => {
        hdrVerdict = result;
        return result;
      });
      const [buffer, hdrBuffer] = await Promise.all([mapped.promise, hdrMapped.promise]);
      expect(buffer.mapState).toBe('mapped');
      expect(hdrBuffer.mapState).toBe('mapped');
      const destroy = buffer.destroy.bind(buffer);
      vi.spyOn(buffer, 'destroy').mockImplementation(() => {
        retirements++;
        destroy();
      });
      const getRange = buffer.getMappedRange.bind(buffer);
      vi.spyOn(buffer, 'getMappedRange').mockImplementation((...args) => {
        staleRangeReads++;
        return getRange(...args);
      });
      vi.spyOn(hdrBuffer, 'getMappedRange').mockImplementation(() => {
        staleRangeReads++;
        throw new Error('The old HDR observation reached its invalidated GPU range');
      });
      const pickRequest = {
        x: 32,
        y: 32,
        width: 64,
        height: 64,
        afterFrameId: receipt.frameId,
        worldIdentity: world.identity,
        deviceGeneration: receipt.deviceGeneration,
      };
      const pick = renderer.requestViewportHit(pickRequest);
      const queueDone = lostDevice.queue.onSubmittedWorkDone.bind(lostDevice.queue);
      const fence = vi
        .spyOn(lostDevice.queue, 'onSubmittedWorkDone')
        .mockImplementation(async () => {
          await queueDone();
          await deliverFences.promise;
        });
      const queued = [];
      try {
        for (let i = 0; i < 2; i++) {
          const drawn = renderer.draw({ source: lease });
          assert(drawn.ok);
          queued.push(drawn.value);
        }
        expect(renderer.inspect().frame.pendingCompletionCount).toBeGreaterThanOrEqual(2);
      } finally {
        fence.mockRestore();
      }
      lostDevice.destroy();
      expect((await lostDevice.lost).reason).toBe('destroyed');
      await expect
        .poll(() => verdict)
        .toMatchObject({
          ok: false,
          error: { code: 'render-target-state-invalid', detail: { reason: 'generation-mismatch' } },
        });
      await expect(pick).resolves.toEqual({ kind: 'stale', reason: 'device-generation' });
      await expect
        .poll(() => hdrVerdict)
        .toMatchObject({
          ok: false,
          error: { code: 'frame-receipt-stale' },
        });
      expect(hdrBuffer.mapState).toBe('unmapped');
      for (const pending of queued)
        await expect(pending.completed).resolves.toMatchObject({ ok: false });
      expect(renderer.inspect().frame.pendingCompletionCount).toBe(0);
      expect(renderer.inspect().observation.resourceStats?.liveByteLength).toBe(0);
      await expect(renderer.requestViewportHit(pickRequest)).resolves.toEqual({
        kind: 'stale',
        reason: 'device-generation',
      });
      expect(renderer.requestObservation(['linear-hdr'])).toMatchObject({
        ok: false,
        error: { code: 'renderer-state-invalid', detail: { state: 'device-lost' } },
      });
      expect(buffer.mapState).toBe('unmapped');
      expect(retirements).toBe(1);
      expect(renderer.requestTargetReadback(oldView.output, { mipLevel: 0 })).toMatchObject({
        ok: false,
        error: { code: 'render-target-state-invalid', detail: { reason: 'generation-mismatch' } },
      });
      expect(renderer.destroyRenderTarget(oldView.output).ok).toBe(true);
      world.despawn(oldView.camera).unwrap();
    }
    await expect.poll(() => renderer.state()).toBe('device-lost');
    const recovered = await renderer.recover();
    assert(recovered.ok, JSON.stringify(recovered));
    if (oldView !== undefined) {
      const next = createNamedView();
      expect(next.camera).not.toBe(oldView.camera);
      expect(next.output).not.toBe(oldView.output);
      const firstReady = await ready();
      expect(firstReady.deviceGeneration).toBe((oldGeneration ?? -1) + 1);
      await expectDisplayPixel('green');
      const ticket = renderer.requestTargetReadback(next.output, { mipLevel: 0 });
      assert(ticket.ok);
      const receipt = await ready();
      expect(receipt.deviceGeneration).toBe(firstReady.deviceGeneration);
      const observed = await renderer.observe(receipt, {
        include: ['target-readbacks'],
        targetReadbacks: [ticket.value],
      });
      assert(observed.ok, JSON.stringify(observed));
      const result = observed.value.targetReadbacks?.[0];
      assert(result);
      expect(result.frameId).toBe(receipt.frameId);
      expect(result.deviceGeneration).toBe(receipt.deviceGeneration);
      const pixel = result.bytes.subarray(32 * result.bytesPerRow + 32 * 4);
      expect(pixel[0]).toBeLessThan(15);
      expect(pixel[1]).toBeGreaterThan(240);
      deliverMap.resolve();
      deliverFences.resolve();
      await oldMapReturned;
      await expect(oldRead).resolves.toMatchObject({ ok: false });
      await expect(oldHdr).resolves.toMatchObject({ ok: false });
      expect(staleRangeReads).toBe(0);
      expect(retirements).toBe(1);
    }
    await draw(true);
    expect(frames).toBe(60);
    if (oldView !== undefined) {
      assert(device);
      const current = renderer.inspect().frame;
      const oldPick = {
        x: 32,
        y: 32,
        width: 64,
        height: 64,
        afterFrameId: current.frameId,
        worldIdentity: world.identity,
        deviceGeneration: current.deviceGeneration,
      };
      const pick = renderer.requestViewportHit(oldPick);
      const queueDone = device.queue.onSubmittedWorkDone.bind(device.queue);
      const oldWorldGate = Promise.withResolvers<void>();
      const waitOldWorld = vi
        .spyOn(device.queue, 'onSubmittedWorkDone')
        .mockImplementation(async () => {
          await queueDone();
          await oldWorldGate.promise;
        });
      assert(renderer.requestObservation(['linear-hdr']).ok);
      const oldWorldSubmission = renderer.draw({ source: lease });
      waitOldWorld.mockRestore();
      assert(oldWorldSubmission.ok);
      expect(renderer.inspect().frame.pendingCompletionCount).toBe(1);
      const observedOldWorld = renderer.observe(oldWorldSubmission.value, {
        include: ['linear-hdr'],
      });
      const replacement = new World();
      registerPropagateTransforms(replacement);
      replacement
        .spawn(
          { component: Name, data: { value: 'recovered readback view' } },
          { component: Transform, data: { pos: [0, 0, 4] } },
          { component: BarrelDistortion, data: { strength: 0.1 } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: 1, aspect: 1, near: 0.1, far: 10 }),
              clearColor: [0, 0, 1, 1],
              tonemap: 0,
              antialias: 0,
              bloom: 0,
            },
          },
        )
        .unwrap();
      lease.dispose();
      const attachedReplacement = renderer.attach(replacement);
      try {
        await expect(pick).resolves.toEqual({ kind: 'stale', reason: 'world-or-request' });
        await expect(renderer.requestViewportHit(oldPick)).resolves.toEqual({
          kind: 'stale',
          reason: 'world-or-request',
        });
        assert(attachedReplacement.ok);
        await ready(replacement, attachedReplacement.value);
        await expectDisplayPixel('blue');
      } finally {
        oldWorldGate.resolve();
      }
      const oldColor = await observedOldWorld;
      assert(oldColor.ok);
      const hdr = oldColor.value.observations?.[0];
      assert(hdr);
      expect(hdr.metadata.frameId).toBe(oldWorldSubmission.value.frameId);
      expect(hdr.metadata.format).toBe('rgba16float');
      const oldPixel = new DataView(
        hdr.bytes.buffer,
        hdr.bytes.byteOffset + 32 * hdr.metadata.bytesPerRow + 32 * 8,
      );
      expect(oldPixel.getUint16(2, true)).toBeGreaterThan(0x3800);
      expect(oldPixel.getUint16(0, true)).toBeLessThan(0x2800);
      const replaced = renderer.inspect().frame;
      const abort = new AbortController();
      const removeListener = vi.spyOn(abort.signal, 'removeEventListener');
      const cancelled = renderer.requestViewportHit(
        {
          ...oldPick,
          afterFrameId: replaced.frameId,
          worldIdentity: replacement.identity,
          deviceGeneration: replaced.deviceGeneration,
        },
        abort.signal,
      );
      abort.abort();
      await expect(cancelled).resolves.toEqual({ kind: 'stale', reason: 'cancelled' });
      expect(removeListener).toHaveBeenCalledOnce();

      const closeGate = Promise.withResolvers<void>();
      const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
        await queueDone();
        await closeGate.promise;
      });
      try {
        assert(renderer.requestObservation(['linear-hdr']).ok);
        const submitted = renderer.draw({ source: attachedReplacement.value });
        assert(submitted.ok);
        expect(renderer.inspect().frame.pendingCompletionCount).toBe(1);
        const observed = renderer.observe(submitted.value, { include: ['linear-hdr'] });
        assert((await renderer.dispose()).ok);
        await expect(observed).resolves.toMatchObject({ ok: false });
        await expect(submitted.value.completed).resolves.toMatchObject({ ok: false });
      } finally {
        fence.mockRestore();
        closeGate.resolve();
      }
    }
    expect(failures).toMatchObject([{ code: 'device-lost' }]);
  } finally {
    deliverMap.resolve();
    deliverFences.resolve();
    assert((await renderer.dispose()).ok);
    target?.destroy();
    URL.revokeObjectURL(manifest);
  }
}, 120_000);
