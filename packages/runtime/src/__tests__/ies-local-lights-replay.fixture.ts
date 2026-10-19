import {
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  openReplay,
  replayDeviceRequest,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { IES_TEST_SIZE, localIesProfile } from './ies-local-lights.fixture';

export async function verifyLocalIesReplay(
  name: string,
  tape: EncodedTape,
  live: Float32Array,
  save: (name: string, bytes: Uint8Array) => Promise<void>,
) {
  const decoded = decodeTape(tape.bytes).unwrap();
  const model = buildFrameModel(decoded);
  const work = model.works.find((candidate) =>
    candidate.pipeline.shaders.some(
      (shader) =>
        shader.stage === 'fragment' &&
        (name.startsWith('deferred')
          ? shader.entryPoint === 'fs_standard_deferred'
          : shader.source?.includes('iesProfileFactor')),
    ),
  );
  if (work === undefined) throw new Error('missing IES Standard lighting work');
  const table = work.bindings.find((binding) => binding.groupIndex === 2 && binding.binding === 3);
  const ies = work.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 11);
  const output = work.attachments?.colorViewHandleIds[0];
  if (!table?.resourceId || !ies?.resourceId || !output)
    throw new Error('missing IES work bindings');
  const view = model.resources.find((resource) => resource.resourceId === ies.resourceId)
    ?.descriptor as {
    sourceHandleId: string;
    desc: { dimension: string; arrayLayerCount: number };
  };
  expect(view.desc.dimension).toBe('2d-array');
  expect(view.desc.arrayLayerCount).toBe(32);
  const texture = model.resources.find((resource) => resource.resourceId === view.sourceHandleId)
    ?.descriptor as {
    desc: { format: string; size: { width: number; height: number; depthOrArrayLayers: number } };
  };
  expect(texture.desc.format).toBe('r16float');
  const uploads = model.commands.filter(
    (command) =>
      command.kind === 'writeTexture' &&
      (command.params as { destination?: { textureHandleId?: string } })?.destination
        ?.textureHandleId === view.sourceHandleId,
  );
  expect(uploads).toHaveLength(name.endsWith('steady') ? 0 : 1);
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(decoded, adapter.features, adapter.limits))
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(device);
  if (raw === undefined) throw new Error('missing replay native device');
  raw.pushErrorScope('validation');
  const replay = (
    await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const reads = (
      await replay.readAtWorks([
        {
          resourceId: table.resourceId,
          workIndex: work.workIndex,
          subresource: { offset: (table.bufferOffset ?? 0) + (table.dynamicOffset ?? 0), size: 96 },
        },
        {
          resourceId: view.sourceHandleId,
          workIndex: work.workIndex,
          subresource: { arrayLayer: 0, mipLevel: 0 },
        },
        { resourceId: output, workIndex: work.workIndex },
      ])
    )
      .unwrap()
      .map((result) => result.unwrap());
    const [slot, profile, attachment] = reads;
    if (slot === undefined || profile === undefined || attachment === undefined)
      throw new Error('missing IES replay readback');
    const metadata = new Uint32Array(slot.bytes.buffer, slot.bytes.byteOffset, 24);
    expect((metadata[16] ?? -1) & 0xff).toBe(name.includes('-point-') ? 0 : 2);
    expect(metadata[18]).toBe(0);
    expect(profile.width).toBe(256);
    expect(profile.height).toBe(128);
    expect(profile.bytes).toEqual(
      localIesProfile(
        name.endsWith('polar-front') ? 'polar' : name.endsWith('wide270') ? 'wide270' : 'upper',
      ).data,
    );
    expect(attachment.format).toBe('rgba16float');
    const pixels = luminanceRgba16f(attachment.bytes, IES_TEST_SIZE, IES_TEST_SIZE);
    expect(pixels.every(Number.isFinite)).toBe(true);
    let maxRelativeError = 0;
    for (let i = 0; i < pixels.length; i++) {
      maxRelativeError = Math.max(
        maxRelativeError,
        Math.abs((pixels[i] ?? NaN) - (live[i] ?? NaN)) / Math.max(1, live[i] ?? NaN),
      );
    }
    expect(maxRelativeError).toBeLessThanOrEqual(0.005);
    const timing = adapter.features.has('timestamp-query')
      ? (await replay.timePasses()).unwrap()
      : undefined;
    expect(await raw.popErrorScope()).toBeNull();
    await save(`${name}-replay.luminance-f32`, new Uint8Array(pixels.buffer));
    await save(`${name}-ies.r16float`, profile.bytes);
    await save(
      `${name}-rhi.json`,
      new TextEncoder().encode(
        JSON.stringify(
          {
            digest: tape.digest,
            workIndex: work.workIndex,
            iesUploads: uploads.length,
            lightSlot: Array.from(metadata),
            iesTexture: texture.desc,
            bindings: work.bindings,
            maxRelativeError,
            unseededResources: model.unseededResources,
            summary: summarizeFrame(model),
            replayDeviceTiming: timing,
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    (await replay.dispose()).unwrap();
    raw.destroy();
  }
}
