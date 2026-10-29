import {
  type BatchReadRequest,
  type BatchReadResults,
  type BufferRecordLayout,
  type BufferRecords,
  buildFrameModel,
  decodeBufferRecords,
  decodeTape,
  type EncodedTape,
  encodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
  type V7RhiCallEvent,
  type WorkEntry,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { CHANNEL_EPSILON, CHANNEL_SIZE } from './lighting-channels.fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing channel replay record');
  return value;
}

/** The actual draw owns its first-instance source, including indirect GPU output. */
function firstInstanceRead(draw: V7RhiCallEvent, workIndex: number): number | BatchReadRequest {
  if (draw.kind === 'draw' || draw.kind === 'drawIndexed') return draw.firstInstance;
  if (draw.kind === 'drawIndirect' || draw.kind === 'drawIndexedIndirect') {
    return {
      resourceId: draw.indirectBufferHandleId,
      workIndex,
      subresource: {
        offset: draw.indirectOffset + (draw.kind === 'drawIndexedIndirect' ? 16 : 12),
        size: 4,
      },
    };
  }
  throw new Error(`selected geometry work is not a draw: ${draw.kind}`);
}

/** Read the GPU address tables once, then follow their pointers on the CPU. */
function channelAddresses(geometry: WorkEntry, draw: V7RhiCallEvent) {
  const visibleItems = geometry.bindings.find(
    (binding) => binding.groupIndex === 3 && binding.binding === 2,
  );
  const instances = geometry.bindings.find(
    (binding) => binding.groupIndex === 3 && binding.binding === 0,
  );
  if (visibleItems?.resourceId == null || instances?.resourceId == null)
    throw new Error('missing selected draw GPU scene address bindings');
  const firstInstance = firstInstanceRead(draw, geometry.workIndex);
  return {
    requests: [
      { resourceId: visibleItems.resourceId, workIndex: geometry.workIndex },
      { resourceId: instances.resourceId, workIndex: geometry.workIndex },
      ...(typeof firstInstance === 'number' ? [] : [firstInstance]),
    ],
    primitiveIndex(reads: BatchReadResults): number {
      const wordAt = (slot: number, offset: number): number => {
        const read = required(reads[slot]).unwrap();
        expect(read.provenance.selectedWorkIndex).toBe(geometry.workIndex);
        return new DataView(
          read.bytes.buffer,
          read.bytes.byteOffset,
          read.bytes.byteLength,
        ).getUint32(offset, true);
      };
      const first = typeof firstInstance === 'number' ? firstInstance : wordAt(2, 0);
      const instance = wordAt(
        0,
        (visibleItems.bufferOffset ?? 0) + (visibleItems.dynamicOffset ?? 0) + first * 16,
      );
      return wordAt(
        1,
        (instances.bufferOffset ?? 0) + (instances.dynamicOffset ?? 0) + instance * 16,
      );
    },
  };
}

/** Inspect the actual integer carriers and selected-work HDR on a fresh device. */
export async function verifyChannelReplay(
  name: string,
  tape: EncodedTape,
  live: Float32Array,
  devices: GPUDevice[],
  save: (name: string, bytes: Uint8Array) => void,
  progress: (phase: string) => Promise<void> = async () => {},
  physicalForward = false,
) {
  const lightKind = name.split('-')[1];
  const selectedMask = name.includes('-full-') ? 0xffffffff : 0x80000000;
  const directionalMask = lightKind === 'directional' ? selectedMask : 0;
  const localMasks = ['point', 'spot', 'rect'].map((kind) =>
    kind === lightKind ? selectedMask : 0,
  );
  const deferred = name.startsWith('deferred') && !physicalForward;
  const decoded = decodeTape(tape.bytes).unwrap();
  const model = buildFrameModel(decoded);
  const geometry = model.works.find((work) =>
    work.pipeline.shaders.some(
      (shader) =>
        shader.stage === 'fragment' &&
        (shader.entryPoint === 'fs_gbuffer' ||
          shader.entryPoint === 'fs_opaque' ||
          (shader.entryPoint === 'fs_main' && shader.source?.includes('lightingChannelsMatch'))),
    ),
  );
  const lighting = deferred
    ? model.works.find((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
      )
    : geometry;
  if (geometry === undefined || lighting === undefined)
    throw new Error('missing Standard channel work');
  expect(geometry.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer')).toBe(
    deferred,
  );
  expect(
    lighting.pipeline.shaders.some((shader) => shader.source?.includes('lightingChannelsMatch')),
  ).toBe(true);
  await progress(`${name}:fresh-device`);
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(decoded, adapter.features, adapter.limits))
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(device);
  if (raw === undefined) throw new Error('missing fresh native replay device');
  devices.push(raw);
  const replay = (
    await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  const records: BufferRecords[] = [];
  try {
    const view = geometry.bindings.find(
      (binding) => binding.groupIndex === 0 && binding.binding === 0,
    );
    const lightTable = lighting.bindings.find(
      (binding) => binding.groupIndex === 2 && binding.binding === 3,
    );
    const primitive = geometry.bindings.find(
      (binding) => binding.groupIndex === 3 && binding.binding === 6,
    );
    const mesh = geometry.bindings.find(
      (binding) => binding.groupIndex === 2 && binding.binding === 0,
    );
    const receiver = primitive ?? mesh;
    if (view?.resourceId == null || lightTable?.resourceId == null || receiver?.resourceId == null)
      throw new Error('missing channel carrier binding');
    const viewOffset = (view.bufferOffset ?? 0) + (view.dynamicOffset ?? 0);
    const addresses =
      primitive === undefined
        ? undefined
        : channelAddresses(geometry, required(decoded.events[geometry.eventIndex]));
    const receiverAttachment = deferred ? geometry.attachments?.colorViewHandleIds[5] : undefined;
    if (deferred && receiverAttachment == null)
      throw new Error('missing receiver geometry attachment');
    const hdrAttachment = lighting.attachments?.colorViewHandleIds[0];
    if (hdrAttachment == null) throw new Error('missing selected-work HDR attachment');
    await progress(`${name}:inspect-carrier-batch`);
    // Read this small fixture's address tables with its carriers in one replay.
    // Resolve the indirect -> visible item -> instance -> primitive chain from
    // those exact post-work bytes instead of replaying the frame for each word.
    const reads = (
      await replay.readAtWorks([
        {
          resourceId: view.resourceId,
          workIndex: geometry.workIndex,
          subresource: { offset: 0, size: viewOffset + 80 },
        },
        {
          resourceId: lightTable.resourceId,
          workIndex: lighting.workIndex,
          subresource: { offset: 0, size: 96 * 3 },
        },
        { resourceId: receiver.resourceId, workIndex: geometry.workIndex },
        ...(receiverAttachment == null
          ? []
          : [{ resourceId: receiverAttachment, workIndex: geometry.workIndex }]),
        { resourceId: hdrAttachment, workIndex: lighting.workIndex },
        ...(addresses?.requests ?? []),
      ])
    ).unwrap();
    const primitiveIndex =
      addresses?.primitiveIndex(reads.slice(receiverAttachment == null ? 4 : 5)) ?? 0;
    const receiverOffset =
      (receiver.bufferOffset ?? 0) +
      (receiver.dynamicOffset ?? 0) +
      (primitive ? primitiveIndex * 64 + 44 : 152);
    const layouts: readonly BufferRecordLayout[] = [
      {
        stride: viewOffset + 80,
        fields: [
          { name: 'directionalChannels', type: 'u32', offset: viewOffset + 76, components: 1 },
        ],
      },
      { stride: 96, fields: [{ name: 'channels', type: 'u32', offset: 80, components: 1 }] },
      {
        stride: required(reads[2]).unwrap().bytes.byteLength,
        fields: [{ name: 'receiverChannels', type: 'u32', offset: receiverOffset, components: 1 }],
      },
    ];
    const carrierReads = [
      { resourceId: view.resourceId, workIndex: geometry.workIndex, count: 1 },
      { resourceId: lightTable.resourceId, workIndex: lighting.workIndex, count: 3 },
      { resourceId: receiver.resourceId, workIndex: geometry.workIndex, count: 1 },
    ];
    const image = required(reads[receiverAttachment == null ? 3 : 4]).unwrap();
    expect(image.format).toBe('rgba16float');
    expect(image.width).toBe(CHANNEL_SIZE);
    expect(image.height).toBe(CHANNEL_SIZE);
    expect(image.provenance.selectedWorkIndex).toBe(lighting.workIndex);
    const pixels = luminanceRgba16f(image.bytes, CHANNEL_SIZE, CHANNEL_SIZE);
    for (let y = 25; y < 39; y++)
      for (let x = 25; x < 39; x++) {
        const i = y * CHANNEL_SIZE + x;
        expect(Math.abs((pixels[i] ?? NaN) - (live[i] ?? NaN))).toBeLessThanOrEqual(
          CHANNEL_EPSILON,
        );
      }
    for (const [index, read] of carrierReads.entries()) {
      records.push(
        decodeBufferRecords(required(reads[index]).unwrap(), required(layouts[index]), {
          first: 0,
          count: read.count,
        }).unwrap(),
      );
    }
    const [viewRecords, lightRecords, receiverRecords] = records;
    expect(viewRecords?.records[0]?.fields.directionalChannels).toEqual([directionalMask]);
    expect(lightRecords?.records.map((row) => row.fields.channels)).toEqual(
      localMasks.map((mask) => [mask]),
    );
    const receiverMask = name.endsWith('nonmatch') ? 0x7fffffff : selectedMask;
    expect(receiverRecords?.records[0]?.fields.receiverChannels).toEqual([receiverMask]);
    if (receiverAttachment != null) {
      const read = required(reads[3]).unwrap();
      expect(read.format).toBe('rg32uint');
      const words = new Uint32Array(
        read.bytes.buffer,
        read.bytes.byteOffset,
        read.bytes.byteLength / 4,
      );
      expect(words[(32 * CHANNEL_SIZE + 32) * 2 + 1]).toBe(receiverMask);
      save(`${name}-receiver.rg32uint`, read.bytes);
    }
    save(`${name}-replay.rgba16float`, image.bytes);
    save(
      `${name}-inspection.json`,
      new TextEncoder().encode(
        JSON.stringify(
          {
            digest: tape.digest,
            pipeline: lighting.pipeline,
            hdrProvenance: image.provenance,
            geometryWork: geometry.workIndex,
            lightingWork: lighting.workIndex,
            bindings: geometry.bindings,
            resources: model.resources,
            records,
            unseeded: model.unseededResources,
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

  if (!name.endsWith('nonmatch')) return;
  let replaced = 0;
  const bypass = <T extends V7RhiCallEvent | Record<string, unknown>>(event: T): T => {
    if (event.kind !== 'createShaderModule' || typeof event.wgslCode !== 'string') return event;
    const code = event.wgslCode.replace(
      /fn\s+\w*lightingChannelsMatch\w*\([\s\S]*?\)\s*->\s*bool\s*\{[^}]*\}/gu,
      (source) => {
        replaced++;
        return `${source.slice(0, source.indexOf('{') + 1)} return true; }`;
      },
    );
    return { ...event, wgslCode: code };
  };
  const modified = {
    ...decoded,
    bootstrap: decoded.bootstrap.map((resource) => ({
      ...resource,
      create: bypass(resource.create),
    })),
    events: decoded.events.map(bypass),
  };
  expect(replaced).toBeGreaterThan(0);
  const bytes = encodeTape(modified, { compression: 'gzip' }).unwrap();
  save(`${name}-bypass.falsifier.rhitape`, bytes);
  const falsifier = decodeTape(bytes).unwrap();
  // A WebGPU adapter is consumed by its first successful device request.
  await progress(`${name}:bypass-fresh-device`);
  const freshAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const fresh = (
    await freshAdapter.requestDevice(
      replayDeviceRequest(falsifier, freshAdapter.features, freshAdapter.limits),
    )
  ).unwrap();
  const rawFresh = webgpu._internal_getRawDevice(fresh);
  if (rawFresh === undefined) throw new Error('missing falsifier device');
  devices.push(rawFresh);
  const session = (
    await openReplay(falsifier, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    await progress(`${name}:bypass-inspect-hdr`);
    const read = (await session.inspectWork(lighting.workIndex, ['pixels'])).unwrap().attachment;
    if (read === undefined) throw new Error('missing falsifier HDR');
    const pixels = luminanceRgba16f(read.bytes, CHANNEL_SIZE, CHANNEL_SIZE);
    const i = 32 * CHANNEL_SIZE + 32;
    const increment = (pixels[i] ?? NaN) - (live[i] ?? NaN);
    expect(increment).toBeGreaterThan(0.01);
    save(
      `${name}-falsifier.json`,
      new TextEncoder().encode(JSON.stringify({ digest: tapeDigest(bytes), replaced, increment })),
    );
  } finally {
    (await session.dispose()).unwrap();
    rawFresh.destroy();
  }
}
