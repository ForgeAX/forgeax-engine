import { World } from '@forgeax/engine-ecs';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot } from '../../render-system-extract';
import { encodeMainPass } from '../main-pass';
import type { _InternalRenderPipelineContext } from '../render-context';

it.each([
  ['Forward', false],
  ['Deferred', false],
  ['Deferred', true],
] as const)('reads selected %s contracts with GPU-only=%s', async (lightMode, gpuOnly) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: 0x14,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler().unwrap();
  const buffer = device.createBuffer({ size: 64, usage: 0x48 }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
  });
  let contractReads = 0;
  let selectorReads = 0;
  const material = {
    materialHandle: 1,
    get materialShaderId(): string {
      contractReads++;
      throw new Error('selected material contract');
    },
  };
  const resource = new MaterialResource(material as MaterialSnapshot);
  const entry = {
    renderableIndex: 0,
    source: {
      entityKey: 1,
      worldId: 0,
      material: resource,
      materials: [resource],
    },
  };
  const context = {
    runtime: { device },
    world: new World(),
    store: {},
    pipelineState: {
      colorAttachmentFormat: 'rgba8unorm',
      skylightFallback: {
        irradianceView: view,
        prefilterView: view,
        brdfLutView: view,
        sampler,
        intensityBuffer: buffer,
      },
    },
    frameState: {},
    validatedOrdered: gpuOnly ? [] : [entry],
    hdrpClusterBindGroup: null,
    materialSlots: [material],
    materialBindings: [{ material: resource, resourceClass: '', entityKey: 1 }],
    materialSlotIndices: [[0]],
    materialSlotCount: 1,
    skylightCount: 0,
    dispatch: gpuOnly
      ? {
          get length(): never {
            throw new Error('GPU accessed full dispatch');
          },
          [Symbol.iterator](): never {
            throw new Error('GPU iterated full dispatch');
          },
        }
      : [
          {
            entityIndex: 0,
            renderableIndex: 0,
            materialHandle: 1,
            passIndex: 0,
            queue: 2000,
            layer: 0,
            tags: {
              get LightMode() {
                selectorReads++;
                return 'Deferred';
              },
            },
          },
        ],
  } as unknown as _InternalRenderPipelineContext;
  try {
    const record = () =>
      encodeMainPass(
        context,
        pass,
        { LightMode: [lightMode] },
        {
          passKind: 'temporal',
          recordMode: 'opaque',
          ...(gpuOnly ? { gpuDriven: {} as never } : {}),
        },
      );
    if (lightMode === 'Forward') {
      expect(record).not.toThrow();
      expect(contractReads).toBe(0);
      expect(pass).toBeInstanceOf(RhiNullRenderPassEncoder);
      expect((pass as RhiNullRenderPassEncoder).bindGroupCount).toBe(0);
      expect((pass as RhiNullRenderPassEncoder).drawCount).toBe(0);
    } else {
      // A blanket skip would hide a real selected producer failure.
      expect(record).toThrow('selected material contract');
      expect(contractReads).toBe(1);
    }
    // Pair selection remains authoritative; the unrelated sprite-only set
    // must not perform another full selector scan before this geometry lane.
    expect(selectorReads).toBe(gpuOnly ? 0 : lightMode === 'Forward' ? 2 : 1);
  } finally {
    pass.end();
    device.destroyBuffer(buffer).unwrap();
    device.destroyTexture(texture).unwrap();
  }
});
