import {
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
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { CHANNEL_EPSILON, CHANNEL_SIZE } from './lighting-channels.fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing channel replay record');
  return value;
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
    let primitiveIndex = 0;
    if (primitive !== undefined) {
      const visibleItems = geometry.bindings.find(
        (binding) => binding.groupIndex === 3 && binding.binding === 2,
      );
      const instances = geometry.bindings.find(
        (binding) => binding.groupIndex === 3 && binding.binding === 0,
      );
      if (visibleItems?.resourceId == null || instances?.resourceId == null)
        throw new Error('missing selected draw GPU scene address bindings');
      const wordAt = async (resourceId: string, offset: number): Promise<number> => {
        const reads = (
          await replay.readAtWorks([
            {
              resourceId,
              workIndex: geometry.workIndex,
              subresource: { offset, size: 4 },
            },
          ])
        ).unwrap();
        const read = required(reads[0]).unwrap();
        expect(read.provenance.selectedWorkIndex).toBe(geometry.workIndex);
        return new DataView(
          read.bytes.buffer,
          read.bytes.byteOffset,
          read.bytes.byteLength,
        ).getUint32(0, true);
      };
      const draw = required(decoded.events[geometry.eventIndex]);
      let firstInstance: number;
      if (draw.kind === 'draw' || draw.kind === 'drawIndexed') {
        firstInstance = draw.firstInstance;
      } else if (draw.kind === 'drawIndirect' || draw.kind === 'drawIndexedIndirect') {
        firstInstance = await wordAt(
          draw.indirectBufferHandleId,
          draw.indirectOffset + (draw.kind === 'drawIndexedIndirect' ? 16 : 12),
        );
      } else {
        throw new Error(`selected geometry work is not a draw: ${draw.kind}`);
      }
      // Follow the submitted draw's visible item to its instance and physical
      // primitive row. Source slot zero is not a GPU allocation contract.
      const instanceIndex = await wordAt(
        visibleItems.resourceId,
        (visibleItems.bufferOffset ?? 0) + (visibleItems.dynamicOffset ?? 0) + firstInstance * 16,
      );
      primitiveIndex = await wordAt(
        instances.resourceId,
        (instances.bufferOffset ?? 0) + (instances.dynamicOffset ?? 0) + instanceIndex * 16,
      );
    }
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
        stride: receiverOffset + 4,
        fields: [{ name: 'receiverChannels', type: 'u32', offset: receiverOffset, components: 1 }],
      },
    ];
    const carrierReads = [
      { resourceId: view.resourceId, workIndex: geometry.workIndex, count: 1 },
      { resourceId: lightTable.resourceId, workIndex: lighting.workIndex, count: 3 },
      { resourceId: receiver.resourceId, workIndex: geometry.workIndex, count: 1 },
    ];
    const receiverAttachment = deferred ? geometry.attachments?.colorViewHandleIds[5] : undefined;
    if (deferred && receiverAttachment == null)
      throw new Error('missing receiver geometry attachment');
    const hdrAttachment = lighting.attachments?.colorViewHandleIds[0];
    if (hdrAttachment == null) throw new Error('missing selected-work HDR attachment');
    await progress(`${name}:inspect-carrier-batch`);
    // The existing batch owner replays equal/ascending works once. Each read
    // retains its original selected-work provenance and exact byte range.
    const reads = (
      await replay.readAtWorks([
        ...carrierReads.map((read, index) => ({
          resourceId: read.resourceId,
          workIndex: read.workIndex,
          subresource: { offset: 0, size: required(layouts[index]).stride * read.count },
        })),
        ...(receiverAttachment == null
          ? []
          : [{ resourceId: receiverAttachment, workIndex: geometry.workIndex }]),
        { resourceId: hdrAttachment, workIndex: lighting.workIndex },
      ])
    ).unwrap();
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
