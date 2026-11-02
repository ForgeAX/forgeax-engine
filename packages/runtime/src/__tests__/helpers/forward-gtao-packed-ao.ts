import type { FrameModel, V7Tape } from '@forgeax/engine-rhi-debug';

export interface PackedClusterWordAddressInput {
  readonly wordIndex: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly bytesPerRow: number;
  readonly byteLength: number;
}

export function packedClusterWordByteOffset(input: PackedClusterWordAddressInput): number {
  const { wordIndex, physicalWidth, physicalHeight, bytesPerRow, byteLength } = input;
  assertSafeInteger('wordIndex', wordIndex, 0, input);
  assertSafeInteger('physicalWidth', physicalWidth, 1, input);
  assertSafeInteger('physicalHeight', physicalHeight, 1, input);
  assertSafeInteger('bytesPerRow', bytesPerRow, 1, input);
  assertSafeInteger('byteLength', byteLength, 1, input);

  const physicalRowWords = physicalWidth * 4;
  const physicalRowBytes = physicalWidth * 16;
  if (
    !Number.isSafeInteger(physicalRowWords) ||
    !Number.isSafeInteger(physicalRowBytes) ||
    bytesPerRow < physicalRowBytes ||
    bytesPerRow % Uint32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new RangeError(`invalid rgba32uint physical row layout: ${JSON.stringify(input)}`);
  }
  const row = Math.floor(wordIndex / physicalRowWords);
  const columnWord = wordIndex % physicalRowWords;
  const byteOffset = row * bytesPerRow + columnWord * 4;
  const byteEnd = byteOffset + Uint32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(byteOffset) ||
    row >= physicalHeight ||
    byteEnd > byteLength ||
    byteEnd > row * bytesPerRow + physicalRowBytes
  ) {
    throw new RangeError(
      `packed Cluster word is outside the captured texture: ${JSON.stringify({
        ...input,
        physicalRowWords,
        physicalRowBytes,
        row,
        columnWord,
        byteOffset,
        byteEnd,
      })}`,
    );
  }
  return byteOffset;
}

export interface PackedAoRegion {
  readonly baseWord: number;
  readonly width: number;
  readonly height: number;
  readonly rowWords: number;
  readonly originX: number;
  readonly originY: number;
  readonly textureWidth: number;
  readonly packedWidth: number;
}

export function decodePackedAoRegion(input: {
  readonly clusterUniformBytes: Uint8Array;
  readonly clusterAoByteOffset: number;
  readonly ssaoUniformBytes: Uint8Array;
  readonly ssaoClusterPackByteOffset: number;
}): PackedAoRegion {
  const clusterView = new DataView(
    input.clusterUniformBytes.buffer,
    input.clusterUniformBytes.byteOffset,
    input.clusterUniformBytes.byteLength,
  );
  const ssaoView = new DataView(
    input.ssaoUniformBytes.buffer,
    input.ssaoUniformBytes.byteOffset,
    input.ssaoUniformBytes.byteLength,
  );
  assertWordRange(
    'cluster AO layout',
    input.clusterAoByteOffset,
    4,
    input.clusterUniformBytes.byteLength,
  );
  assertWordRange(
    'SSAO cluster pack layout',
    input.ssaoClusterPackByteOffset,
    4,
    input.ssaoUniformBytes.byteLength,
  );
  return {
    baseWord: clusterView.getUint32(input.clusterAoByteOffset, true),
    width: clusterView.getUint32(input.clusterAoByteOffset + 4, true),
    height: clusterView.getUint32(input.clusterAoByteOffset + 8, true),
    rowWords: clusterView.getUint32(input.clusterAoByteOffset + 12, true),
    originX: ssaoView.getUint32(input.ssaoClusterPackByteOffset, true),
    originY: ssaoView.getUint32(input.ssaoClusterPackByteOffset + 4, true),
    textureWidth: ssaoView.getUint32(input.ssaoClusterPackByteOffset + 8, true),
    packedWidth: ssaoView.getUint32(input.ssaoClusterPackByteOffset + 12, true),
  };
}

export interface RecordedUniformPayload {
  readonly resourceId: string;
  readonly descriptorSize: number;
  readonly bytes: Uint8Array;
  readonly lastWriteEventIndex: number;
}

export function recordedBufferResourceId(model: FrameModel, label: string): string {
  const matches = model.resources.filter(
    (resource) => resource.kind === 'buffer' && descriptorLabel(resource.descriptor) === label,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one recorded ${label} buffer; found ${matches.length}`);
  }
  const resource = matches[0];
  if (resource === undefined) throw new Error(`missing recorded ${label} buffer`);
  return resource.resourceId;
}

export function recordedShaderWorkEventIndex(
  model: FrameModel,
  fragmentEntryPoint: string,
  boundResourceId: string,
  sourceMarker?: string,
): number {
  const matches = model.works.filter(
    (work) =>
      work.pipeline.status === 'available' &&
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' &&
          shader.entryPoint === fragmentEntryPoint &&
          (sourceMarker === undefined || shader.source?.includes(sourceMarker) === true),
      ) &&
      work.bindings.some((binding) => binding.resourceId === boundResourceId),
  );
  if (matches.length === 0) {
    throw new Error(
      `no ${fragmentEntryPoint} frame work binds ${boundResourceId}${sourceMarker === undefined ? '' : ` and contains ${sourceMarker}`}`,
    );
  }
  return Math.min(...matches.map((work) => work.eventIndex));
}

export function recordedUniformPayload(
  tape: V7Tape,
  frameModel: FrameModel,
  label: string,
  beforeEventIndex: number,
): RecordedUniformPayload {
  const resources = frameModel.resources.filter(
    (resource) => resource.kind === 'buffer' && descriptorLabel(resource.descriptor) === label,
  );
  if (resources.length !== 1) {
    throw new Error(`expected one recorded ${label} buffer; found ${resources.length}`);
  }
  const resource = resources[0];
  if (resource === undefined) throw new Error(`missing recorded ${label} buffer`);
  const descriptor = recordValue(resource.descriptor);
  const descriptorBody = descriptor === undefined ? undefined : recordValue(descriptor.desc);
  const descriptorSize = descriptorBody?.size;
  if (typeof descriptorSize !== 'number' || !Number.isSafeInteger(descriptorSize)) {
    throw new Error(`recorded ${label} buffer has no safe descriptor size`);
  }

  const payload = new Uint8Array(descriptorSize);
  const covered = new Uint8Array(descriptorSize);
  let lastWriteEventIndex = -1;
  for (const [eventIndex, event] of tape.events.entries()) {
    if (
      event.kind !== 'writeBuffer' ||
      event.handleId !== resource.resourceId ||
      eventIndex >= beforeEventIndex
    ) {
      continue;
    }
    const blob = tape.blobs.find((candidate) => candidate.hash === event.dataHash);
    if (blob === undefined || blob.bytes.byteLength < event.size) {
      throw new Error(
        `recorded ${label} write is missing bytes: ${JSON.stringify({
          resourceId: resource.resourceId,
          eventIndex,
          dataHash: event.dataHash,
          eventSize: event.size,
          blobSize: blob?.bytes.byteLength,
        })}`,
      );
    }
    const end = event.bufferOffset + event.size;
    if (!Number.isSafeInteger(end) || event.bufferOffset < 0 || end > descriptorSize) {
      throw new Error(
        `recorded ${label} write exceeds its descriptor: ${JSON.stringify({
          resourceId: resource.resourceId,
          eventIndex,
          bufferOffset: event.bufferOffset,
          eventSize: event.size,
          descriptorSize,
        })}`,
      );
    }
    payload.set(blob.bytes.subarray(0, event.size), event.bufferOffset);
    covered.fill(1, event.bufferOffset, end);
    lastWriteEventIndex = eventIndex;
  }
  if (lastWriteEventIndex < 0 || covered.some((value) => value === 0)) {
    throw new Error(
      `recorded ${label} buffer was not fully written before work event ${beforeEventIndex}: ${JSON.stringify(
        {
          resourceId: resource.resourceId,
          descriptorSize,
          lastWriteEventIndex,
          uncoveredBytes: covered.reduce((count, value) => count + (value === 0 ? 1 : 0), 0),
        },
      )}`,
    );
  }
  return { resourceId: resource.resourceId, descriptorSize, bytes: payload, lastWriteEventIndex };
}

export interface PackedAoPhysicalCapture {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly bytesPerRow: number;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly usage: number;
  readonly graphGeneration: number;
  readonly deviceGeneration: number;
  readonly textureIdentity: number;
  readonly targetRecordFrameNumber: number;
  readonly publicReceiptFrameId: number;
  readonly receiptPresentation: 'ready';
  readonly receiptCompleted: true;
}

type PackedAoReadbackFacts = Omit<PackedAoPhysicalCapture, 'bytes'> & {
  readonly actualByteLength: number;
};

function validatePackedAoReadback(
  cluster: PackedAoPhysicalCapture,
  blurred: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
): PackedAoReadbackFacts {
  const readbackFacts = {
    byteLength: cluster.byteLength,
    bytesPerRow: cluster.bytesPerRow,
    actualByteLength: cluster.bytes.byteLength,
    format: cluster.format,
    width: cluster.width,
    height: cluster.height,
    usage: cluster.usage,
    graphGeneration: cluster.graphGeneration,
    deviceGeneration: cluster.deviceGeneration,
    textureIdentity: cluster.textureIdentity,
    targetRecordFrameNumber: cluster.targetRecordFrameNumber,
    publicReceiptFrameId: cluster.publicReceiptFrameId,
    receiptPresentation: cluster.receiptPresentation,
    receiptCompleted: cluster.receiptCompleted,
  } as const;
  if (
    cluster.format !== 'rgba32uint' ||
    (cluster.usage & 1) === 0 ||
    !Number.isSafeInteger(cluster.width) ||
    cluster.width < 1 ||
    !Number.isSafeInteger(cluster.height) ||
    cluster.height < 1 ||
    !Number.isSafeInteger(cluster.bytesPerRow) ||
    cluster.bytesPerRow < cluster.width * 16 ||
    cluster.bytesPerRow % 256 !== 0 ||
    !Number.isSafeInteger(cluster.byteLength) ||
    cluster.byteLength < 1 ||
    cluster.byteLength !== cluster.bytes.byteLength ||
    cluster.byteLength !== cluster.bytesPerRow * cluster.height ||
    !Number.isSafeInteger(cluster.graphGeneration) ||
    !Number.isSafeInteger(cluster.deviceGeneration) ||
    !Number.isSafeInteger(cluster.textureIdentity) ||
    !Number.isSafeInteger(cluster.targetRecordFrameNumber) ||
    !Number.isSafeInteger(cluster.publicReceiptFrameId) ||
    blurred.bytes.byteLength !== blurred.width * blurred.height
  ) {
    throw new Error(`invalid packed AO readback metadata: ${JSON.stringify(readbackFacts)}`);
  }
  return readbackFacts;
}

export function comparePackedAo(
  cluster: PackedAoPhysicalCapture,
  blurred: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
  region: PackedAoRegion,
): {
  readonly mismatches: number;
  readonly total: number;
  readonly rowWords: number;
  readonly baseWord: number;
  readonly firstMismatch:
    | { readonly x: number; readonly y: number; readonly expected: number; readonly actual: number }
    | undefined;
  readonly readback: PackedAoReadbackFacts;
  readonly aoRegion: PackedAoRegion;
  readonly physicalRowWords: number;
} {
  const readbackFacts = validatePackedAoReadback(cluster, blurred);
  validatePackedAoRegion(cluster, blurred, region);

  const physicalRowWords = cluster.width * 4;
  const view = new DataView(
    cluster.bytes.buffer,
    cluster.bytes.byteOffset,
    cluster.bytes.byteLength,
  );
  let mismatches = 0;
  let firstMismatch:
    | { readonly x: number; readonly y: number; readonly expected: number; readonly actual: number }
    | undefined;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const expectedByte = blurred.bytes[y * blurred.width + x];
      if (expectedByte === undefined) {
        throw new Error(
          `filtered AO byte missing at ${x},${y} from ${JSON.stringify({ blurred })}`,
        );
      }
      const expected = encodePackedAoWord(expectedByte);
      const wordIndex = region.baseWord + y * region.rowWords + x;
      let byteOffset: number;
      try {
        byteOffset = packedClusterWordByteOffset({
          wordIndex,
          physicalWidth: cluster.width,
          physicalHeight: cluster.height,
          bytesPerRow: cluster.bytesPerRow,
          byteLength: cluster.byteLength,
        });
      } catch (cause) {
        throw new RangeError(
          `AO word address is invalid for the captured Cluster readback: ${JSON.stringify({
            readback: readbackFacts,
            aoRegion: region,
            x,
            y,
            wordIndex,
            cause: cause instanceof Error ? cause.message : String(cause),
          })}`,
          { cause },
        );
      }
      const actual = view.getUint32(byteOffset, true);
      if (actual !== expected) {
        mismatches += 1;
        firstMismatch ??= { x, y, expected, actual };
      }
    }
  }
  return {
    mismatches,
    total: region.width * region.height,
    rowWords: region.rowWords,
    baseWord: region.baseWord,
    firstMismatch,
    readback: readbackFacts,
    aoRegion: region,
    physicalRowWords,
  };
}

function validatePackedAoRegion(
  cluster: PackedAoPhysicalCapture,
  blurred: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
  region: PackedAoRegion,
): void {
  const packedWidth = Math.ceil(region.width / 4);
  const physicalRowWords = cluster.width * 4;
  const baseRow = Math.floor(region.baseWord / physicalRowWords);
  const baseColumnWord = region.baseWord % physicalRowWords;
  const regionLastWord = region.baseWord + (region.height - 1) * region.rowWords + region.width - 1;
  const regionFields = [
    region.baseWord,
    region.width,
    region.height,
    region.rowWords,
    region.originX,
    region.originY,
    region.textureWidth,
    region.packedWidth,
    regionLastWord,
  ];
  const facts = {
    physical: {
      format: cluster.format,
      width: cluster.width,
      height: cluster.height,
      bytesPerRow: cluster.bytesPerRow,
      byteLength: cluster.byteLength,
      graphGeneration: cluster.graphGeneration,
      deviceGeneration: cluster.deviceGeneration,
      textureIdentity: cluster.textureIdentity,
      targetRecordFrameNumber: cluster.targetRecordFrameNumber,
      publicReceiptFrameId: cluster.publicReceiptFrameId,
      receiptPresentation: cluster.receiptPresentation,
      receiptCompleted: cluster.receiptCompleted,
      physicalRowWords,
    },
    blurred: { width: blurred.width, height: blurred.height, byteLength: blurred.bytes.byteLength },
    aoRegion: region,
    decodedRegion: { packedWidth, baseRow, baseColumnWord, regionLastWord },
  };
  if (
    regionFields.some((value) => !Number.isSafeInteger(value)) ||
    region.width !== blurred.width ||
    region.height !== blurred.height ||
    region.width < 1 ||
    region.height < 1 ||
    region.rowWords !== packedWidth * 4 ||
    region.packedWidth !== packedWidth ||
    region.textureWidth !== cluster.width ||
    region.originX < 0 ||
    region.originY < 0 ||
    region.originX + packedWidth > cluster.width ||
    baseRow !== region.originY ||
    baseColumnWord !== region.originX * 4 ||
    region.baseWord !== (region.originY * region.textureWidth + region.originX) * 4 ||
    baseColumnWord + region.rowWords > physicalRowWords ||
    regionLastWord >= physicalRowWords * cluster.height
  ) {
    throw new RangeError(`inconsistent packed AO region: ${JSON.stringify(facts)}`);
  }
}

function assertSafeInteger(
  name: string,
  value: number,
  minimum: number,
  context: PackedClusterWordAddressInput,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`invalid ${name}: ${JSON.stringify({ value, minimum, context })}`);
  }
}

function assertWordRange(name: string, offset: number, words: number, byteLength: number): void {
  const end = offset + words * Uint32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(end) ||
    end > byteLength
  ) {
    throw new RangeError(
      `${name} exceeds its captured buffer: ${JSON.stringify({ offset, words, byteLength, end })}`,
    );
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function descriptorLabel(value: unknown): string | undefined {
  const outer = recordValue(value);
  const inner = outer === undefined ? undefined : recordValue(outer.desc);
  return typeof inner?.label === 'string' ? inner.label : undefined;
}

export function encodePackedAoWord(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`invalid AO visibility byte ${value}`);
  }
  return value === 255 ? 0xffffffff : Math.round((value / 255) * 4294967040);
}
