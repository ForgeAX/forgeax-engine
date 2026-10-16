import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';

/** Real graph mip writers, same-handle replacement and fresh-device replay. */
export async function verifyGraphTextureResidency() {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const scope = DeviceScope.create(1, 'graph-texture-residency');
  const store = new GpuResidencyCache();
  store.bindDeviceScope(scope);
  store.configureGpuDevice(
    device,
    (_device, descriptor) => recorder.backend.createShaderModule(device, descriptor),
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  (await store.prewarmMipmapPipeline(device, ['rgba8unorm'])).unwrap();
  const world = new World();
  const source = (rgba: number[]): TextureAsset => ({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'generate' },
    data: Uint8Array.from(Array.from({ length: 16 }, () => rgba).flat()),
  });
  const red = source([255, 0, 0, 255]);
  const handle = world.allocSharedRef('TextureAsset', red);
  const facts: {
    stage: string;
    rgba: number[];
    prepareCpuMs: number;
    executeSubmitCpuMs: number;
    submissions: number;
    passes: string[];
  }[] = [];
  const outputs: Uint8Array[] = [];
  const captured = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const submit = vi.spyOn(device.queue, 'submit');
  try {
    for (const [index, rgba] of [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ].entries()) {
      const omitMips = index === 2;
      const beforeSubmissions = submit.mock.calls.length;
      const start = performance.now();
      const candidate = store.prepareTextureResidencyForGraph(handle, source(rgba), world).unwrap();
      const prepareCpuMs = performance.now() - start;
      expect(candidate.needsMipmaps).toBe(true);
      expect(store.getTextureGpuView(handle, world)).toBeUndefined();
      expect(submit.mock.calls.length).toBe(beforeSubmissions);
      const staging = device.createBuffer({ size: 256, usage: 9 }).unwrap();
      const builder = new RenderGraphBuilder();
      const receipt = candidate.entry.receipt;
      const texture = builder
        .importTexture(
          'source',
          {
            format: receipt.format,
            size: receipt.extent,
            mipLevelCount: receipt.mipLevelCount,
            usage: 23,
          },
          () => candidate.entry.texture.handle,
        )
        .unwrap();
      const views = [0, 1, 2].map((level) =>
        builder.view(texture, { baseMipLevel: level, mipLevelCount: 1 }).unwrap(),
      );
      if (!omitMips)
        for (let level = 1; level < 3; level++) {
          const sourceView = views[level - 1];
          const destination = views[level];
          assert(sourceView && destination);
          builder
            .addRasterPass(`mip-${index}-${level}`, {
              accesses: [
                { resource: sourceView, usage: 'sampled-read' },
                { resource: destination, usage: 'color-attachment' },
              ],
              colorAttachments: [
                {
                  view: destination,
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
              ],
              encode: ({ pass, resources }) =>
                encodeMipmapLevel(
                  device,
                  pass,
                  resources.textureView(sourceView).unwrap(),
                  receipt.format,
                ).unwrap(),
            })
            .unwrap();
        }
      const output = builder
        .importBuffer('readback', { size: 256, usage: 9 }, () => staging)
        .unwrap();
      const lastView = views[2];
      assert(lastView);
      builder
        .addCopyPass('read-final-mip', {
          accesses: [
            { resource: lastView, usage: 'copy-src' },
            { resource: output, usage: 'copy-dst' },
          ],
          encode: ({ encoder, resources }) =>
            encoder.copyTextureToBuffer(
              { texture: resources.texture(texture).unwrap(), mipLevel: 2 },
              { buffer: resources.buffer(output).unwrap(), bytesPerRow: 256 },
              { width: 1, height: 1, depthOrArrayLayers: 1 },
            ),
        })
        .unwrap();
      const graph = builder.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
      const encoder = device.createCommandEncoder({ label: `texture-graph-${index}` }).unwrap();
      const executeStart = performance.now();
      graph.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const executeSubmitCpuMs = performance.now() - executeStart;
      const completed = device.queue.onSubmittedWorkDone();
      candidate.lease.track(completed);
      expect(submit.mock.calls.length - beforeSubmissions).toBe(1);
      if (!omitMips) {
        expect(candidate.current()).toBe(true);
        expect(candidate.commit()).toBe(true);
        const hot = store.prepareTextureResidencyForGraph(handle, source(rgba), world).unwrap();
        expect(hot.needsMipmaps).toBe(false);
        expect(hot.entry).toBe(candidate.entry);
        const releasedHot = hot.lease.release(false);
        // Publication invalidates the mapping while accepted users still hold this allocation.
        store.invalidateTexture(handle, world);
        expect(candidate.current()).toBe(false);
        expect(candidate.commit()).toBe(false);
        expect(store.getTextureGpuView(handle, world)).toBeUndefined();
        expect(candidate.entry.texture.isDestroyed).toBe(false);
        await completed;
        await releasedHot;
      }
      const mapped = (await staging.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap()).slice(0, 4);
      mapped.unmap();
      expect([...bytes]).toEqual(omitMips ? [0, 0, 0, 0] : rgba);
      outputs.push(bytes);
      facts.push({
        stage: omitMips ? 'missing-mip-falsifier' : index === 0 ? 'cold' : 'replacement',
        rgba: [...bytes],
        prepareCpuMs,
        executeSubmitCpuMs,
        submissions: submit.mock.calls.length - beforeSubmissions,
        passes: graph.inspect().passes.map((pass) => pass.name),
      });
      await candidate.lease.release(false);
      expect(candidate.entry.texture.isDestroyed).toBe(true);
      (await graph.retire()).unwrap();
      device.destroyBuffer(staging).unwrap();
    }
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await captured).unwrap().bytes;
    const tape = decodeTape(bytes).unwrap();
    const model = buildFrameModel(tape);
    expect(model.works).toHaveLength(4);
    // All six resources are created inside the capture, so no retained initial
    // snapshot exists. Captured source uploads, graph mip writers and copies
    // initialize the positive paths; the omitted-mip control deliberately reads
    // WebGPU's zero-initialized level. Fresh replay below checks every writer.
    expect(model.unseededResources.filter((resource) => resource.kind === 'texture')).toHaveLength(
      3,
    );
    expect(model.unseededResources.filter((resource) => resource.kind === 'buffer')).toHaveLength(
      3,
    );
    store.destroyAll();
    scope.retire();
    expect(scope.resourceDelta()).toBe(0);
    raw.destroy();
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      for (const [index, work] of model.works.entries()) {
        const attachment = work.attachments?.colorViewHandleIds[0];
        assert(attachment);
        const actual = (await replay.readResourceAtWork(attachment, work.workIndex)).unwrap().bytes;
        const expected = outputs[Math.floor(index / 2)];
        assert(expected);
        expect(actual.byteLength).toBe(index % 2 === 0 ? 16 : 4);
        for (let offset = 0; offset < actual.byteLength; offset += 4)
          expect(actual.slice(offset, offset + 4)).toEqual(expected);
      }
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return { bytes, facts, outputs };
  } finally {
    submit.mockRestore();
    store.destroyAll();
    scope.retire();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
