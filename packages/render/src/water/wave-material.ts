import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  BindGroupLayoutEntry,
  Buffer,
  RhiDevice,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result, type ShaderEntryPointReads } from '@forgeax/engine-types';
import {
  WATER_BAKED_DESCRIPTOR_STRIDE_BYTES,
  WATER_BODY_DATA_STRIDE_BYTES,
  type WaterBakedUploadSource,
  type WaterMeshLayoutReceipt,
  type WaterWaveUploadPlan,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import {
  createWaterMeshLayoutReceipt,
  isWaterBakedSourceAvailable,
  isWaterMeshContinuityPayloadValid,
  isWaterMeshLayoutReceiptValid,
  requireWaterValue,
  WATER_MESH_INSTANCE_LAYOUT,
} from '@forgeax/engine-water/internal';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { bindGroupChainLeaf } from '../record/mesh-ssbo';
import { waterMaterialReadsBakedSource } from './material-admission';
import { isOwnedWaterMeshAdmissionUpload } from './mesh-source-admission';

export const WATER_MATERIAL_FRAME_BINDINGS = Object.freeze({
  bodyData: 0,
  waves: 1,
  waterInfo: 2,
  waterInfoSampler: 3,
  waterInfoDescriptor: 4,
  drawData: 5,
  waterMeshInstances: 6,
  bakedDescriptors: 7,
  bakedSamples: 8,
});

export const WATER_INFO_DESCRIPTOR_BYTES = 48;
export const WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES = 256;
export const WATER_MATERIAL_DRAW_DATA_BYTES = 16;
export const WATER_MESH_INSTANCE_STRIDE_BYTES = WATER_MESH_INSTANCE_LAYOUT.strideBytes;
export const WATER_MESH_INSTANCE_SCHEMA_VERSION = WATER_MESH_INSTANCE_LAYOUT.schemaVersion;
export const WATER_MATERIAL_FRAME_LAYOUT_SCHEMA_VERSION = 3;
export const WATER_BODY_ONLY_BINDING_KEY = 'water-body-frame';

export interface WaterMeshInstanceDrawUpload {
  readonly drawKey: string;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly zoneGeneration: number;
  readonly viewIdentity: string;
  readonly transitionTargets: readonly WaterMeshTransitionTarget[];
  readonly bytes: Uint8Array;
  readonly coverageBytes: Uint8Array;
  readonly layout: WaterMeshLayoutReceipt;
}

export interface WaterMeshTransitionTarget {
  readonly instanceIndex: number;
  /** Generation-qualified WaterBody owner key in this renderer view. */
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly zoneGeneration: number;
}

export interface WaterMeshInstanceUpload {
  readonly bytes: Uint8Array;
  readonly dynamicOffsets: ReadonlyMap<string, number>;
  readonly transitionTargetsByDraw: ReadonlyMap<string, readonly WaterMeshTransitionTarget[]>;
  readonly bindingSize: number;
  readonly offsetAlignment: number;
  readonly layout: WaterMeshLayoutReceipt;
}

function validateWaterMeshInstanceDraw(draw: WaterMeshInstanceDrawUpload): void {
  if (
    !draw.drawKey ||
    !draw.bodyGuid ||
    !draw.viewIdentity ||
    !Number.isInteger(draw.bodyGeneration) ||
    !Number.isInteger(draw.zoneGeneration) ||
    draw.bytes.byteLength === 0 ||
    draw.bytes.byteLength % WATER_MESH_INSTANCE_STRIDE_BYTES !== 0 ||
    !isWaterMeshLayoutReceiptValid(draw.layout, draw.bytes, draw.coverageBytes) ||
    !isWaterMeshContinuityPayloadValid(draw.bytes, draw.coverageBytes)
  )
    throw new RangeError(
      `WaterMesh draw ${draw.drawKey} has a stale or invalid instance layout receipt`,
    );
}

export function buildWaterMeshInstanceUpload(
  draws: readonly WaterMeshInstanceDrawUpload[],
  alignment = 256,
): WaterMeshInstanceUpload {
  return packWaterMeshInstanceDraws(draws, alignment, true);
}

function packWaterMeshInstanceDraws(
  draws: readonly WaterMeshInstanceDrawUpload[],
  alignment: number,
  validateSourceDraws: boolean,
  transitionWrites?: ReadonlyMap<
    WaterMeshInstanceDrawUpload,
    readonly WaterMeshTransitionWaveWrite[]
  >,
): WaterMeshInstanceUpload {
  if (!Number.isInteger(alignment) || alignment < 4 || (alignment & (alignment - 1)) !== 0)
    throw new RangeError('WaterMesh storage offsets require a power-of-two alignment');
  const dynamicOffsets = new Map<string, number>();
  const transitionTargetsByDraw = new Map<string, readonly WaterMeshTransitionTarget[]>();
  const entries: Array<{ draw: WaterMeshInstanceDrawUpload; offset: number }> = [];
  let cursor = alignment,
    bindingSize: number = WATER_MESH_INSTANCE_STRIDE_BYTES;
  for (const draw of [...draws].sort((a, b) => a.drawKey.localeCompare(b.drawKey))) {
    if (validateSourceDraws) validateWaterMeshInstanceDraw(draw);
    if (draw.viewIdentity !== draws[0]?.viewIdentity)
      throw new RangeError('WaterMesh tile records cannot mix renderer views');
    if (dynamicOffsets.has(draw.drawKey))
      throw new RangeError(`Duplicate WaterMesh draw key ${draw.drawKey}`);
    cursor = Math.ceil(cursor / alignment) * alignment;
    dynamicOffsets.set(draw.drawKey, cursor);
    transitionTargetsByDraw.set(draw.drawKey, Object.freeze([...draw.transitionTargets]));
    entries.push({ draw, offset: cursor });
    cursor += draw.bytes.byteLength + draw.coverageBytes.byteLength;
    bindingSize = Math.max(bindingSize, draw.bytes.byteLength + draw.coverageBytes.byteLength);
  }
  const bytes = new Uint8Array(Math.max(WATER_MESH_INSTANCE_STRIDE_BYTES, cursor + bindingSize));
  for (const { draw, offset } of entries) {
    bytes.set(draw.bytes, offset);
    bytes.set(draw.coverageBytes, offset + draw.bytes.byteLength);
    const writes = transitionWrites?.get(draw);
    if (writes === undefined || writes.length === 0) continue;
    const data = new DataView(bytes.buffer, bytes.byteOffset + offset, draw.bytes.byteLength);
    for (const write of writes)
      data.setUint32(
        write.instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES +
          WATER_MESH_INSTANCE_LAYOUT.offsets.transitionWaveIndexPlusOne,
        write.bodyIndex + 1,
        true,
      );
  }
  const coverageByteLength = draws.reduce((sum, draw) => sum + draw.coverageBytes.byteLength, 0);
  const coverageBytes = new Uint8Array(coverageByteLength);
  let coverageOffset = 0;
  for (const draw of [...draws].sort((a, b) => a.drawKey.localeCompare(b.drawKey))) {
    coverageBytes.set(draw.coverageBytes, coverageOffset);
    coverageOffset += draw.coverageBytes.byteLength;
  }
  const layout = createWaterMeshLayoutReceipt(bytes, coverageBytes);
  return Object.freeze({
    bytes,
    dynamicOffsets,
    transitionTargetsByDraw,
    bindingSize,
    offsetAlignment: alignment,
    layout,
  });
}

type WaterMeshTransitionWaveWrite = Readonly<{
  readonly instanceIndex: number;
  readonly bodyIndex: number;
}>;

function resolveTransitionWaveWrites(
  draw: WaterMeshInstanceDrawUpload,
  plan: WaterWaveUploadPlan,
  bytes: Uint8Array,
): readonly WaterMeshTransitionWaveWrite[] {
  const targetsByInstance = new Map<
    number,
    WaterMeshInstanceDrawUpload['transitionTargets'][number]
  >();
  const captureTransitionMetadata = () => {
    for (const target of draw.transitionTargets) {
      if (
        !Number.isSafeInteger(target.instanceIndex) ||
        target.instanceIndex < 0 ||
        target.instanceIndex >= bytes.byteLength / WATER_MESH_INSTANCE_STRIDE_BYTES ||
        !target.bodyGuid ||
        !Number.isSafeInteger(target.bodyGeneration) ||
        target.bodyGeneration < 0 ||
        target.zoneGeneration !== draw.zoneGeneration ||
        targetsByInstance.has(target.instanceIndex)
      )
        throw new RangeError(
          `WaterMesh draw ${draw.drawKey} has invalid or duplicate transition target metadata`,
        );
      const bodyIndex = plan.bodyIndices.get(target.bodyGuid);
      const body = bodyIndex === undefined ? undefined : plan.bodyData[bodyIndex];
      if (
        bodyIndex === undefined ||
        body === undefined ||
        body.bodyGeneration !== target.bodyGeneration ||
        plan.bodyZoneGenerations.get(target.bodyGuid) !== target.zoneGeneration ||
        bodyIndex >= 0xffff_ffff
      )
        throw new RangeError(
          `WaterMesh draw ${draw.drawKey} has a missing or stale transition WaveSet/WaterBody row for ${target.bodyGuid}`,
        );
      targetsByInstance.set(target.instanceIndex, target);
    }
  };
  captureTransitionMetadata();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const writes: WaterMeshTransitionWaveWrite[] = [];
  for (
    let instanceIndex = 0;
    instanceIndex < bytes.byteLength / WATER_MESH_INSTANCE_STRIDE_BYTES;
    instanceIndex++
  ) {
    const recordOffset = instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES;
    const localTransitionIndex = data.getUint32(
      recordOffset + WATER_MESH_INSTANCE_LAYOUT.offsets.transitionWaveIndexPlusOne,
      true,
    );
    const target = targetsByInstance.get(instanceIndex);
    if ((localTransitionIndex === 0) !== (target === undefined))
      throw new RangeError(
        `WaterMesh draw ${draw.drawKey} transition record ${instanceIndex} does not match its generation-qualified target`,
      );
    const support =
      data.getUint32(
        recordOffset + WATER_MESH_INSTANCE_LAYOUT.offsets.flatFarBoundaryMask,
        true,
      ) >>> 4;
    if (target === undefined) continue;
    const bodyIndex = plan.bodyIndices.get(target.bodyGuid);
    const body = bodyIndex === undefined ? undefined : plan.bodyData[bodyIndex];
    if (
      bodyIndex === undefined ||
      body === undefined ||
      Math.fround(body.baseHeightM) !== data.getFloat32(recordOffset + 16, true)
    )
      throw new RangeError(
        `WaterMesh draw ${draw.drawKey} transition height does not match target ${target.bodyGuid}`,
      );
    if (support !== 0) {
      const sourceIndex = plan.bodyIndices.get(draw.bodyGuid);
      const source = sourceIndex === undefined ? undefined : plan.bodyData[sourceIndex];
      const a = source?.heightSource,
        b = body.heightSource;
      if (
        a === undefined ||
        a.kind !== b.kind ||
        a.kind === 'baked' ||
        (a.kind === 'fixed' && a.fixedDepthM !== b.fixedDepthM) ||
        (a.kind === 'water-info' &&
          (b.kind !== 'water-info' || a.zoneIndex !== b.zoneIndex || a.slice !== b.slice))
      )
        throw new RangeError(
          `WaterMesh draw ${draw.drawKey} continuity requires one shared source depth authority for its target`,
        );
    }
    writes.push({ instanceIndex, bodyIndex });
  }
  return writes;
}

function resolveBorrowedTransitionWaveRows(
  draw: WaterMeshInstanceDrawUpload,
  plan: WaterWaveUploadPlan,
): WaterMeshInstanceDrawUpload {
  validateWaterMeshInstanceDraw(draw);
  // Borrowed inputs keep the original detached-before-plan-read contract.
  const bytes = draw.bytes.slice();
  const writes = resolveTransitionWaveWrites(draw, plan, bytes);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const write of writes)
    data.setUint32(
      write.instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES +
        WATER_MESH_INSTANCE_LAYOUT.offsets.transitionWaveIndexPlusOne,
      write.bodyIndex + 1,
      true,
    );
  const layout = createWaterMeshLayoutReceipt(bytes, draw.coverageBytes);
  return Object.freeze({ ...draw, bytes, layout });
}

/** Frame upload packs source tiles directly into their final ranges. */
function buildWaterMeshFrameInstanceUpload(
  draws: readonly WaterMeshInstanceDrawUpload[],
  plan: WaterWaveUploadPlan,
  alignment: number,
): WaterMeshInstanceUpload {
  if (!draws.every(isOwnedWaterMeshAdmissionUpload))
    return buildWaterMeshInstanceUpload(
      draws.map((draw) => resolveBorrowedTransitionWaveRows(draw, plan)),
      alignment,
    );

  // Preserve source order for byte and transition validation; packing remains sorted by key.
  const transitionWrites = new Map<
    WaterMeshInstanceDrawUpload,
    readonly WaterMeshTransitionWaveWrite[]
  >();
  for (const draw of draws) {
    validateWaterMeshInstanceDraw(draw);
    transitionWrites.set(draw, resolveTransitionWaveWrites(draw, plan, draw.bytes));
  }

  return packWaterMeshInstanceDraws(draws, alignment, false, transitionWrites);
}

export interface WaterMaterialDrawDataUpload {
  readonly bytes: Uint8Array;
  readonly bodyIndices: ReadonlyMap<string, number>;
  readonly bodyGenerations: ReadonlyMap<string, number>;
  readonly bodyZoneGenerations: ReadonlyMap<string, number>;
  readonly bodyIndexDynamicOffsets: ReadonlyMap<string, number>;
}

export interface WaterInfoDescriptorUpload {
  readonly bytes: Uint8Array;
  readonly dynamicOffsets: ReadonlyMap<string, number>;
}

export interface WaterMaterialFrameUpload {
  readonly bodyData: Uint8Array;
  readonly waveData: Uint8Array;
  readonly drawData: Uint8Array;
  readonly waterInfoDescriptors: Uint8Array;
  readonly waterMeshInstances: WaterMeshInstanceUpload;
  readonly bakedDescriptors: Uint8Array;
  readonly bakedSamples: Uint8Array;
  readonly bakedSources: readonly WaterBakedUploadSource[];
  readonly bodyIndices: ReadonlyMap<string, number>;
  readonly bodyGenerations: ReadonlyMap<string, number>;
  readonly bodyZoneGenerations: ReadonlyMap<string, number>;
  readonly bodyIndexDynamicOffsets: ReadonlyMap<string, number>;
  readonly waterInfoDescriptorDynamicOffsets: ReadonlyMap<string, number>;
}

export interface WaterMaterialFrameGpuBuffers {
  readonly bodyDataBuffer: Buffer;
  readonly waveDataBuffer: Buffer;
  readonly drawDataBuffer: Buffer;
  readonly waterInfoDescriptorBuffer: Buffer;
  readonly waterMeshInstanceBuffer: Buffer;
  readonly bakedDescriptorBuffer: Buffer;
  readonly bakedSamplesBuffer: Buffer;
}

/** Packs an aligned draw row for every body in the view wave plan. */
export function buildWaterMaterialDrawData(
  plan: WaterWaveUploadPlan,
  viewOriginM: readonly [number, number, number] = [0, 0, 0],
): WaterMaterialDrawDataUpload {
  if (!viewOriginM.every((value) => Number.isFinite(value) && Number.isFinite(Math.fround(value))))
    throw new RangeError('Water deformation requires a finite selected-view origin');
  const bytes = new Uint8Array(
    Math.max(
      WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES,
      plan.bodyData.length * WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES,
    ),
  );
  const view = new DataView(bytes.buffer);
  const bodyIndices = new Map<string, number>();
  const bodyGenerations = new Map<string, number>();
  const bodyZoneGenerations = new Map<string, number>();
  const bodyIndexDynamicOffsets = new Map<string, number>();
  for (const [bodyGuid, bodyIndex] of plan.bodyIndices) {
    if (!Number.isSafeInteger(bodyIndex) || bodyIndex < 0 || bodyIndex >= plan.bodyData.length)
      throw new RangeError(`WaterWaveUploadPlan has an invalid body index for ${bodyGuid}`);
    const offset = bodyIndex * WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES;
    const body = plan.bodyData[bodyIndex];
    const zoneGeneration = plan.bodyZoneGenerations.get(bodyGuid);
    if (body === undefined || zoneGeneration === undefined)
      throw new RangeError(
        `WaterWaveUploadPlan has incomplete owner generation data for ${bodyGuid}`,
      );
    view.setUint32(offset, bodyIndex, true);
    viewOriginM.forEach((value, axis) => {
      view.setFloat32(offset + 4 + axis * 4, value, true);
    });
    bodyIndices.set(bodyGuid, bodyIndex);
    bodyGenerations.set(bodyGuid, body.bodyGeneration);
    bodyZoneGenerations.set(bodyGuid, zoneGeneration);
    bodyIndexDynamicOffsets.set(bodyGuid, offset);
  }
  return Object.freeze({
    bytes,
    bodyIndices,
    bodyGenerations,
    bodyZoneGenerations,
    bodyIndexDynamicOffsets,
  });
}

/** Packs one Zone/view descriptor per water body into dynamic-uniform rows. */
export function buildWaterInfoDescriptorUpload(
  descriptors: ReadonlyMap<string, Uint8Array>,
): WaterInfoDescriptorUpload {
  const bytes = new Uint8Array(
    Math.max(
      WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES,
      descriptors.size * WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES,
    ),
  );
  const dynamicOffsets = new Map<string, number>();
  let row = 0;
  for (const [bodyGuid, descriptor] of [...descriptors].sort(([a], [b]) => a.localeCompare(b))) {
    if (descriptor.byteLength !== WATER_INFO_DESCRIPTOR_BYTES)
      throw new RangeError(
        `WaterInfo descriptor for ${bodyGuid} must be ${WATER_INFO_DESCRIPTOR_BYTES} bytes`,
      );
    const offset = row++ * WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES;
    bytes.set(descriptor, offset);
    dynamicOffsets.set(bodyGuid, offset);
  }
  return Object.freeze({ bytes, dynamicOffsets });
}

/** Closes the cooked wave plan and per-body WaterInfo rows into one upload. */
export function buildWaterMaterialFrameUpload(
  plan: WaterWaveUploadPlan,
  descriptors: ReadonlyMap<string, Uint8Array>,
  waterMeshDraws: readonly WaterMeshInstanceDrawUpload[] = [],
  waterMeshOffsetAlignment = 256,
  viewOriginM: readonly [number, number, number] = [0, 0, 0],
): WaterMaterialFrameUpload {
  const draws = buildWaterMaterialDrawData(plan, viewOriginM);
  if (
    [...descriptors.keys()].some((guid) => !plan.bodyIndices.has(guid)) ||
    [...plan.bodyIndices].some(
      ([guid, index]) =>
        plan.bodyData[index]?.heightSource.kind === 'water-info' && !descriptors.has(guid),
    )
  )
    throw new RangeError('Every WaterInfo height source requires its same-view descriptor');
  const info = buildWaterInfoDescriptorUpload(descriptors);
  for (const draw of waterMeshDraws) {
    const bodyIndex = plan.bodyIndices.get(draw.bodyGuid);
    const body = bodyIndex === undefined ? undefined : plan.bodyData[bodyIndex];
    if (
      body === undefined ||
      body.bodyGeneration !== draw.bodyGeneration ||
      plan.bodyZoneGenerations.get(draw.bodyGuid) !== draw.zoneGeneration
    )
      throw new RangeError(
        `WaterMesh draw ${draw.drawKey} does not match its view wave body/Zone generations`,
      );
    const ownerDescriptor = descriptors.get(draw.bodyGuid);
    if (ownerDescriptor === undefined)
      throw new RangeError(
        `WaterMesh draw ${draw.drawKey} is missing its same-view owner WaterInfo descriptor`,
      );
    for (const target of draw.transitionTargets) {
      const targetDescriptor = descriptors.get(target.bodyGuid);
      if (
        targetDescriptor === undefined ||
        targetDescriptor.byteLength !== ownerDescriptor.byteLength ||
        targetDescriptor.some((value, index) => value !== ownerDescriptor[index])
      )
        throw new RangeError(
          `WaterMesh draw ${draw.drawKey} transition target ${target.bodyGuid} does not share the owner WaterInfo descriptor`,
        );
    }
  }
  const waterMeshInstances = buildWaterMeshFrameInstanceUpload(
    waterMeshDraws,
    plan,
    waterMeshOffsetAlignment,
  );
  return Object.freeze({
    bodyData: plan.bodyBuffer,
    waveData: plan.waveBuffer,
    drawData: draws.bytes,
    waterInfoDescriptors: info.bytes,
    waterMeshInstances,
    bakedDescriptors: plan.bakedDescriptorBuffer,
    bakedSamples: plan.bakedSamplesBuffer,
    bakedSources: plan.bakedSources,
    bodyIndices: draws.bodyIndices,
    bodyGenerations: draws.bodyGenerations,
    bodyZoneGenerations: draws.bodyZoneGenerations,
    bodyIndexDynamicOffsets: draws.bodyIndexDynamicOffsets,
    waterInfoDescriptorDynamicOffsets: info.dynamicOffsets,
  });
}

/** Allocates and writes the four same-frame wave/descriptor buffers. */
export function uploadWaterMaterialFrame(
  device: Pick<RhiDevice, 'createBuffer' | 'destroyBuffer' | 'queue'>,
  upload: WaterMaterialFrameUpload,
): Result<WaterMaterialFrameGpuBuffers, RhiError> {
  const created: Buffer[] = [];
  const allocate = (
    label: string,
    bytes: Uint8Array,
    stride: number,
    usage: number,
  ): Result<Buffer, RhiError> => {
    const result = device.createBuffer({
      label,
      size: Math.max(stride, bytes.byteLength),
      usage: usage | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!result.ok) return result;
    created.push(result.value);
    if (bytes.byteLength > 0) {
      const written = device.queue.writeBuffer(result.value, 0, bytes);
      if (!written.ok) return err(written.error);
    }
    return result;
  };
  const allocateWaterMaterialBuffers = () => {
    const bodyData = allocate(
      'water-body-data',
      upload.bodyData,
      WATER_BODY_DATA_STRIDE_BYTES,
      GPU_BUFFER_USAGE_STORAGE,
    );
    const waveData = bodyData.ok
      ? allocate('water-gerstner-waves', upload.waveData, 48, GPU_BUFFER_USAGE_STORAGE)
      : bodyData;
    const drawData = waveData.ok
      ? allocate(
          'water-material-draw-data',
          upload.drawData,
          WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES,
          GPU_BUFFER_USAGE_UNIFORM,
        )
      : waveData;
    const waterInfo = drawData.ok
      ? allocate(
          'water-info-descriptors',
          upload.waterInfoDescriptors,
          WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES,
          GPU_BUFFER_USAGE_UNIFORM,
        )
      : drawData;
    const waterMeshInstances = waterInfo.ok
      ? allocate(
          'water-mesh-tile-instances',
          upload.waterMeshInstances.bytes,
          WATER_MESH_INSTANCE_STRIDE_BYTES,
          GPU_BUFFER_USAGE_STORAGE,
        )
      : waterInfo;
    const bakedDescriptors = waterMeshInstances.ok
      ? allocate('water-baked-descriptors', upload.bakedDescriptors, 48, GPU_BUFFER_USAGE_STORAGE)
      : waterMeshInstances;
    const bakedSamples = bakedDescriptors.ok
      ? allocate('water-baked-samples', upload.bakedSamples, 16, GPU_BUFFER_USAGE_STORAGE)
      : bakedDescriptors;
    return {
      bodyData,
      waveData,
      drawData,
      waterInfo,
      waterMeshInstances,
      bakedDescriptors,
      bakedSamples,
    };
  };
  const {
    bodyData,
    waveData,
    drawData,
    waterInfo,
    waterMeshInstances,
    bakedDescriptors,
    bakedSamples,
  } = allocateWaterMaterialBuffers();
  if (
    !bodyData.ok ||
    !waveData.ok ||
    !drawData.ok ||
    !waterInfo.ok ||
    !waterMeshInstances.ok ||
    !bakedDescriptors.ok ||
    !bakedSamples.ok
  ) {
    for (const buffer of created) device.destroyBuffer(buffer);
    const failure = !bodyData.ok
      ? bodyData
      : !waveData.ok
        ? waveData
        : !drawData.ok
          ? drawData
          : !waterInfo.ok
            ? waterInfo
            : !waterMeshInstances.ok
              ? waterMeshInstances
              : !bakedDescriptors.ok
                ? bakedDescriptors
                : bakedSamples;
    if (failure.ok)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'all Water material frame buffers allocate before publication',
          hint: 'retry the frame after repairing the GPU resource allocation failure',
        }),
      );
    return err(failure.error);
  }
  return ok(
    Object.freeze({
      bodyDataBuffer: bodyData.value,
      waveDataBuffer: waveData.value,
      drawDataBuffer: drawData.value,
      waterInfoDescriptorBuffer: waterInfo.value,
      waterMeshInstanceBuffer: waterMeshInstances.value,
      bakedDescriptorBuffer: bakedDescriptors.value,
      bakedSamplesBuffer: bakedSamples.value,
    }),
  );
}

export interface WaterMaterialFrameBindingResources {
  readonly schemaVersion: number;
  /** Current recording envelope; WaterInfo content may come from this or an older committed frame. */
  readonly waterInfoContentFrameGeneration?: number;
  readonly waterInfoContentGraphResourceVersion?: string;
  readonly waterInfoTargetName?: string;
  readonly waterInfoFormat?: 'rgba16float' | 'rgba32float';
  readonly bodyTargetNames: ReadonlyMap<string, string>;
  readonly bodyTargetFormats: ReadonlyMap<string, 'rgba16float' | 'rgba32float'>;
  readonly bodyDataBuffer: Buffer;
  readonly waveDataBuffer: Buffer;
  readonly waterInfoTextureView?: TextureView;
  readonly waterInfoSampler?: Sampler;
  readonly waterInfoDescriptorBuffer: Buffer;
  readonly waterInfoDescriptorDynamicOffsets: ReadonlyMap<string, number>;
  readonly drawDataBuffer: Buffer;
  readonly waterMeshInstanceBuffer: Buffer;
  readonly bakedDescriptorBuffer: Buffer;
  readonly bakedSamplesBuffer: Buffer;
  readonly bakedDescriptorBytes: Uint8Array;
  readonly bakedSampleBytes: Uint8Array;
  readonly bakedSources: readonly WaterBakedUploadSource[];
  readonly waterMeshInstanceDynamicOffsets: ReadonlyMap<string, number>;
  readonly waterMeshTransitionTargetsByDraw: ReadonlyMap<
    string,
    readonly WaterMeshTransitionTarget[]
  >;
  readonly waterMeshInstanceBindingSize: number;
  readonly waterMeshInstanceOffsetAlignment: number;
  readonly waterMeshInstanceBytes: Uint8Array;
  readonly waterMeshInstanceLayout: WaterMeshLayoutReceipt;
  readonly bodyIndices: ReadonlyMap<string, number>;
  readonly bodyGenerations: ReadonlyMap<string, number>;
  readonly bodyZoneGenerations: ReadonlyMap<string, number>;
  readonly bodyIndexDynamicOffsets: ReadonlyMap<string, number>;
  readonly viewIdentity: string;
  readonly deviceGeneration: number;
  readonly frameGeneration: number;
}

export function waterMaterialFrameBindingResources(input: {
  readonly upload: WaterMaterialFrameUpload;
  readonly buffers: WaterMaterialFrameGpuBuffers;
  readonly waterInfoContentFrameGeneration?: number;
  readonly waterInfoContentGraphResourceVersion?: string;
  readonly waterInfoTextureView?: TextureView;
  readonly waterInfoTargetName?: string;
  readonly waterInfoFormat?: 'rgba16float' | 'rgba32float';
  readonly bodyTargetNames: ReadonlyMap<string, string>;
  readonly bodyTargetFormats: ReadonlyMap<string, 'rgba16float' | 'rgba32float'>;
  readonly waterInfoSampler?: Sampler;
  readonly viewIdentity: string;
  readonly deviceGeneration: number;
  readonly frameGeneration: number;
}): WaterMaterialFrameBindingResources {
  return Object.freeze({
    ...input.buffers,
    schemaVersion: WATER_MATERIAL_FRAME_LAYOUT_SCHEMA_VERSION,
    ...(input.waterInfoTextureView === undefined
      ? {}
      : {
          ...(input.waterInfoContentFrameGeneration === undefined
            ? {}
            : { waterInfoContentFrameGeneration: input.waterInfoContentFrameGeneration }),
          ...(input.waterInfoContentGraphResourceVersion === undefined
            ? {}
            : { waterInfoContentGraphResourceVersion: input.waterInfoContentGraphResourceVersion }),
          ...(input.waterInfoTargetName === undefined
            ? {}
            : { waterInfoTargetName: input.waterInfoTargetName }),
          ...(input.waterInfoFormat === undefined
            ? {}
            : { waterInfoFormat: input.waterInfoFormat }),
          waterInfoTextureView: input.waterInfoTextureView,
          ...(input.waterInfoSampler === undefined
            ? {}
            : { waterInfoSampler: input.waterInfoSampler }),
        }),
    bodyTargetNames: input.bodyTargetNames,
    bodyTargetFormats: input.bodyTargetFormats,
    bakedDescriptorBytes: input.upload.bakedDescriptors,
    bakedSampleBytes: input.upload.bakedSamples,
    bakedSources: input.upload.bakedSources,
    bodyIndices: input.upload.bodyIndices,
    bodyGenerations: input.upload.bodyGenerations,
    bodyZoneGenerations: input.upload.bodyZoneGenerations,
    bodyIndexDynamicOffsets: input.upload.bodyIndexDynamicOffsets,
    waterInfoDescriptorDynamicOffsets: input.upload.waterInfoDescriptorDynamicOffsets,
    waterMeshInstanceDynamicOffsets: input.upload.waterMeshInstances.dynamicOffsets,
    waterMeshTransitionTargetsByDraw: input.upload.waterMeshInstances.transitionTargetsByDraw,
    waterMeshInstanceBindingSize: input.upload.waterMeshInstances.bindingSize,
    waterMeshInstanceOffsetAlignment: input.upload.waterMeshInstances.offsetAlignment,
    waterMeshInstanceBytes: input.upload.waterMeshInstances.bytes,
    waterMeshInstanceLayout: input.upload.waterMeshInstances.layout,
    viewIdentity: input.viewIdentity,
    deviceGeneration: input.deviceGeneration,
    frameGeneration: input.frameGeneration,
  });
}

/** Detached source facts proven against the exact retained frame buffers and row offsets. */
export type WaterMaterialBakedSourceBinding = Readonly<{
  readonly source: WaterBakedUploadSource;
  readonly drawDataRowOffset: number;
  readonly descriptorBufferByteLength: number;
  readonly sampleBufferByteLength: number;
  readonly complete: boolean;
}>;

export function waterMaterialBakedSourceBindings(
  bindings: WaterMaterialFrameBindingResources,
  sourceBodyIndices: readonly number[],
): readonly WaterMaterialBakedSourceBinding[] {
  const byIndex = new Map(bindings.bakedSources.map((source) => [source.bodyIndex, source]));
  return Object.freeze(
    sourceBodyIndices.flatMap((bodyIndex) => {
      const source = byIndex.get(bodyIndex);
      if (source === undefined) return [];
      const ownerKey = waterBodyOwnerKey(
        source.worldIdentity,
        source.bodyGuid,
        source.bodyGeneration,
        source.zoneGeneration,
      );
      const bodyIndexAtBinding = bindings.bodyIndices.get(ownerKey);
      const bodyGeneration = bindings.bodyGenerations.get(ownerKey);
      const zoneGeneration = bindings.bodyZoneGenerations.get(ownerKey);
      const drawDataRowOffset = bindings.bodyIndexDynamicOffsets.get(ownerKey) ?? -1;
      const descriptorStart = source.descriptorRange[0];
      const descriptorEnd = source.descriptorRange[1];
      const sampleStart = source.sampleRange[0];
      const sampleEnd = source.sampleRange[1];
      let complete =
        bodyIndexAtBinding === bodyIndex &&
        bodyGeneration === source.bodyGeneration &&
        zoneGeneration === source.zoneGeneration &&
        drawDataRowOffset === bodyIndex * WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES &&
        descriptorStart === bodyIndex * WATER_BAKED_DESCRIPTOR_STRIDE_BYTES &&
        descriptorEnd - descriptorStart === WATER_BAKED_DESCRIPTOR_STRIDE_BYTES &&
        descriptorEnd <= bindings.bakedDescriptorBytes.byteLength &&
        sampleStart >= 0 &&
        sampleEnd > sampleStart &&
        sampleEnd <= bindings.bakedSampleBytes.byteLength &&
        sampleStart % 16 === 0 &&
        sampleEnd % 16 === 0;
      if (complete) {
        const descriptor = new DataView(
          bindings.bakedDescriptorBytes.buffer,
          bindings.bakedDescriptorBytes.byteOffset + descriptorStart,
          WATER_BAKED_DESCRIPTOR_STRIDE_BYTES,
        );
        const width = descriptor.getUint32(32, true);
        const height = descriptor.getUint32(36, true);
        const sampleOffsetBytes = descriptor.getUint32(40, true) * 16;
        complete =
          descriptor.getUint32(44, true) === 1 &&
          Number.isSafeInteger(width * height) &&
          width >= 3 &&
          height >= 3 &&
          sampleOffsetBytes === sampleStart &&
          width * height * 16 === sampleEnd - sampleStart;
      }
      return [
        Object.freeze({
          source,
          drawDataRowOffset,
          descriptorBufferByteLength: bindings.bakedDescriptorBytes.byteLength,
          sampleBufferByteLength: bindings.bakedSampleBytes.byteLength,
          complete,
        }),
      ];
    }),
  );
}

export interface WaterMaterialFrameBindings extends WaterMaterialFrameBindingResources {
  readonly bindGroup: BindGroup;
}

/** Reuse only the actual WaterInfo views declared by this recording pass. */
export function selectWaterMaterialFrameTargets(
  bindings: ReadonlyMap<string, WaterMaterialFrameBindings>,
  views: ReadonlyMap<string, TextureView>,
): ReadonlyMap<string, WaterMaterialFrameBindings> | undefined {
  for (const [targetName, view] of views)
    if (bindings.get(targetName)?.waterInfoTextureView !== view) return undefined;
  const selected = new Map(
    [...bindings].filter(
      ([targetName]) => targetName === WATER_BODY_ONLY_BINDING_KEY || views.has(targetName),
    ),
  );
  return selected.size === bindings.size ? bindings : selected;
}

export interface WaterMaterialDrawBinding {
  readonly bodyIndex: number;
  readonly sourceBodyIndices: readonly number[];
  readonly waterInfoDynamicOffset?: number;
  readonly waterMeshInstanceDynamicOffset: number;
  readonly dynamicOffset: number;
  readonly frameBindings: WaterMaterialFrameBindings;
  readonly bindGroup: BindGroup;
}

/** Select resources only after the program has declared the Water system ABI. */
export function waterMaterialEntryPointsUseWaterInfo(
  entryPoints: readonly ShaderEntryPointReads[] | undefined,
): boolean {
  return (
    entryPoints?.some((point) =>
      point.bindings.some((read) => {
        const binding = read.binding - 16;
        return (
          read.group === 2 &&
          (binding === WATER_MATERIAL_FRAME_BINDINGS.waterInfo ||
            binding === WATER_MATERIAL_FRAME_BINDINGS.waterInfoSampler ||
            binding === WATER_MATERIAL_FRAME_BINDINGS.waterInfoDescriptor)
        );
      }),
    ) === true
  );
}

export function waterMaterialFrameBindGroupLayoutEntries(
  waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
  bindingBase = 0,
  entryPoints?: readonly ShaderEntryPointReads[],
  waterInfoAvailable = true,
): readonly BindGroupLayoutEntry[] {
  if (waterInfoFormat === undefined && waterMaterialEntryPointsUseWaterInfo(entryPoints))
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'a prepared WaterInfo format for the selected Water system resources',
      hint: 'prepare the generation-qualified Water frame before requesting its layout',
    });
  const binding = (index: number) => bindingBase + index;
  const entries: BindGroupLayoutEntry[] = [
    { binding: binding(0), visibility: 3, buffer: { type: 'read-only-storage' } },
    { binding: binding(1), visibility: 1, buffer: { type: 'read-only-storage' } },
    ...(waterInfoFormat === undefined
      ? []
      : [
          {
            binding: binding(2),
            visibility: 1,
            texture: {
              sampleType:
                waterInfoFormat === 'rgba16float'
                  ? ('float' as const)
                  : ('unfilterable-float' as const),
              viewDimension: '2d-array' as const,
            },
          },
          { binding: binding(3), visibility: 1, sampler: { type: 'non-filtering' as const } },
          {
            binding: binding(4),
            visibility: 1,
            buffer: {
              type: 'uniform' as const,
              hasDynamicOffset: true,
              minBindingSize: WATER_INFO_DESCRIPTOR_BYTES,
            },
          },
        ]),
    {
      binding: binding(5),
      visibility: 3,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
    },
    // Temporal and main fragments both evaluate per-tile coverage from this buffer.
    {
      binding: binding(6),
      visibility: 3,
      buffer: {
        type: 'read-only-storage',
        hasDynamicOffset: true,
        minBindingSize: WATER_MESH_INSTANCE_STRIDE_BYTES,
      },
    },
    { binding: binding(7), visibility: 1, buffer: { type: 'read-only-storage' } },
    { binding: binding(8), visibility: 1, buffer: { type: 'read-only-storage' } },
  ];
  if (entryPoints === undefined)
    return Object.freeze(
      entries.filter(
        (entry) => waterInfoAvailable || ![2, 3, 4].includes(entry.binding - bindingBase),
      ),
    );
  const visibilityByBinding = new Map<number, number>();
  for (const point of entryPoints) {
    const visibility = point.stage === 'vertex' ? 1 : point.stage === 'fragment' ? 2 : 4;
    for (const read of point.bindings)
      if (read.group === 2 && read.binding >= 16 && read.binding <= 24)
        visibilityByBinding.set(
          read.binding - 16,
          (visibilityByBinding.get(read.binding - 16) ?? 0) | visibility,
        );
  }
  return Object.freeze(
    entries.flatMap((entry) => {
      const visibility = visibilityByBinding.get(entry.binding - bindingBase);
      return visibility === undefined ? [] : [{ ...entry, visibility }];
    }),
  );
}

export const WATER_MATERIAL_FRAME_BIND_GROUP_LAYOUT_ENTRIES: readonly BindGroupLayoutEntry[] =
  waterMaterialFrameBindGroupLayoutEntries('rgba32float');

export function requireWaterMaterialBakedSources(
  bindings: WaterMaterialFrameBindingResources,
  bodyIndices: readonly number[],
  inputs: import('../material-program-inputs').MaterialProgramInputs | undefined,
): void {
  if (!waterMaterialReadsBakedSource(inputs)) return;
  for (const bodyIndex of bodyIndices) {
    if (!isWaterBakedSourceAvailable(bindings.bakedDescriptorBytes, bodyIndex))
      throw new RhiError({
        code: 'rhi-not-available',
        expected:
          'an accepted Baked simulation grid for every Body sampled by the selected material',
        hint: 'publish the current Body generation Baked grid before selecting the Baked material branch',
      });
  }
}

export function waterMaterialFrameBindGroupEntries(
  bindings: WaterMaterialFrameBindingResources,
  bindingBase = 0,
  entryPoints?: readonly ShaderEntryPointReads[],
): BindGroupEntry[] {
  const binding = (index: number) => bindingBase + index;
  const entries: BindGroupEntry[] = [
    {
      binding: binding(0),
      resource: { kind: 'buffer', value: { buffer: bindings.bodyDataBuffer } },
    },
    {
      binding: binding(1),
      resource: { kind: 'buffer', value: { buffer: bindings.waveDataBuffer } },
    },
    ...(bindings.waterInfoTextureView === undefined
      ? []
      : [
          {
            binding: binding(2),
            resource: { kind: 'textureView' as const, value: bindings.waterInfoTextureView },
          },
          ...(bindings.waterInfoSampler === undefined
            ? []
            : [
                {
                  binding: binding(3),
                  resource: {
                    kind: 'sampler' as const,
                    value: requireWaterValue(bindings.waterInfoSampler),
                  },
                },
              ]),
          {
            binding: binding(4),
            resource: {
              kind: 'buffer' as const,
              value: {
                buffer: bindings.waterInfoDescriptorBuffer,
                offset: 0,
                size: WATER_INFO_DESCRIPTOR_BYTES,
              },
            },
          },
        ]),
    {
      binding: binding(5),
      resource: {
        kind: 'buffer',
        value: { buffer: bindings.drawDataBuffer, offset: 0, size: WATER_MATERIAL_DRAW_DATA_BYTES },
      },
    },
    {
      binding: binding(6),
      resource: {
        kind: 'buffer',
        value: {
          buffer: bindings.waterMeshInstanceBuffer,
          offset: 0,
          size: bindings.waterMeshInstanceBindingSize,
        },
      },
    },
    {
      binding: binding(7),
      resource: { kind: 'buffer', value: { buffer: bindings.bakedDescriptorBuffer } },
    },
    {
      binding: binding(8),
      resource: { kind: 'buffer', value: { buffer: bindings.bakedSamplesBuffer } },
    },
  ];
  const required = waterMaterialFrameBindGroupLayoutEntries(
    bindings.waterInfoFormat ?? 'rgba32float',
    bindingBase,
    entryPoints,
    bindings.waterInfoTextureView !== undefined,
  );
  return required.map((entry) => {
    const value = entries.find((candidate) => candidate.binding === entry.binding);
    if (value === undefined)
      throw new RhiError({
        code: 'rhi-not-available',
        expected: `published Water system binding ${entry.binding} required by the cooked entrypoint`,
        hint: 'publish the real WaterInfo source or select an explicitly independent fixed/Baked material variant',
      });
    return value;
  });
}

const waterSystemGroups = new WeakMap<object, unknown>();
const activeWaterSystemGroups = new WeakMap<object, unknown>();

interface WaterPrimitiveBuffers {
  readonly mesh: { readonly buffer: Buffer; readonly size: number };
  readonly tiles?: { readonly buffer: Buffer; readonly size: number } | undefined;
}

/**
 * A frame receipt establishes current admission. The GPU group is reusable
 * whenever its layout, resource handles and bound ranges match that receipt.
 */
export function waterMaterialSystemBindGroup(
  device: Pick<RhiDevice, 'createBindGroup'>,
  layout: BindGroupLayout,
  inputs: WaterMaterialFrameBindingResources,
  entryPoints: readonly ShaderEntryPointReads[],
  primitive?: WaterPrimitiveBuffers,
): BindGroup {
  const frameKeys: object[] = [inputs, layout];
  if (primitive !== undefined)
    frameKeys.push(
      primitive.mesh.buffer,
      primitive.tiles?.buffer ?? inputs.waterMeshInstanceBuffer,
    );
  const frameKey =
    primitive === undefined
      ? 'frame'
      : `${primitive.mesh.size}:${primitive.tiles?.size ?? 'default'}`;
  const frameLeaf = bindGroupChainLeaf(activeWaterSystemGroups, frameKeys);
  const issued = frameLeaf.get(frameKey);
  if (issued !== undefined) return issued;
  const entries = waterMaterialFrameBindGroupEntries(inputs, 16, entryPoints);
  if (primitive !== undefined) {
    const { mesh, tiles } = primitive;
    if (tiles !== undefined) {
      const slot = entries.findIndex(
        (entry) => entry.binding === 16 + WATER_MATERIAL_FRAME_BINDINGS.waterMeshInstances,
      );
      if (slot >= 0) {
        entries[slot] = {
          binding: 16 + WATER_MATERIAL_FRAME_BINDINGS.waterMeshInstances,
          resource: { kind: 'buffer', value: { ...tiles, offset: 0 } },
        };
      }
    }
    entries.unshift({ binding: 0, resource: { kind: 'buffer', value: { ...mesh, offset: 0 } } });
  }
  const keys: object[] = [layout];
  const ranges: string[] = [];
  for (const { binding, resource } of entries) {
    if (resource.kind === 'buffer') {
      keys.push(resource.value.buffer);
      ranges.push(`${binding}:${resource.value.offset ?? 0}:${resource.value.size ?? 'all'}`);
    } else {
      keys.push(resource.value);
      ranges.push(`${binding}:${resource.kind}`);
    }
  }
  const leaf = bindGroupChainLeaf(waterSystemGroups, keys);
  const variant = ranges.join(',');
  const cached = leaf.get(variant);
  if (cached !== undefined) {
    frameLeaf.set(frameKey, cached);
    return cached;
  }
  const group = device
    .createBindGroup({
      label: primitive === undefined ? 'water-system-frame' : 'water-system-primitive',
      layout,
      entries,
    })
    .unwrap();
  leaf.set(variant, group);
  frameLeaf.set(frameKey, group);
  return group;
}

export function waterMaterialFrameDynamicOffsets(
  offsets: Readonly<{ waterInfo?: number; body: number; mesh: number }>,
  entryPoints?: readonly ShaderEntryPointReads[],
  waterInfoAvailable = true,
): readonly number[] {
  return waterMaterialFrameBindGroupLayoutEntries(
    'rgba32float',
    0,
    entryPoints,
    waterInfoAvailable,
  ).flatMap((entry) => {
    if (!entry.buffer?.hasDynamicOffset) return [];
    const offset =
      entry.binding === 4 ? offsets.waterInfo : entry.binding === 5 ? offsets.body : offsets.mesh;
    if (offset === undefined)
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'a current dynamic offset for every reflected Water system binding',
        hint: 'publish the real same-view WaterInfo descriptor before recording this material',
      });
    return [offset];
  });
}

export function createWaterMaterialFrameBindGroupLayout(
  device: Pick<RhiDevice, 'createBindGroupLayout'>,
  waterInfoFormat: 'rgba16float' | 'rgba32float' = 'rgba32float',
): Result<BindGroupLayout, RhiError> {
  return device.createBindGroupLayout({
    label: 'water-material-frame-layout',
    entries: waterMaterialFrameBindGroupLayoutEntries(waterInfoFormat),
  });
}

export function createWaterMaterialFrameBindings(
  device: Pick<RhiDevice, 'createBindGroup'>,
  layout: BindGroupLayout,
  resources: WaterMaterialFrameBindingResources,
): Result<WaterMaterialFrameBindings, RhiError> {
  const validateWaterMaterialFrameResources = () => {
    if (
      resources.schemaVersion !== WATER_MATERIAL_FRAME_LAYOUT_SCHEMA_VERSION ||
      resources.waterInfoDescriptorBuffer === undefined ||
      resources.bodyDataBuffer === undefined ||
      resources.waveDataBuffer === undefined ||
      resources.drawDataBuffer === undefined ||
      resources.waterMeshInstanceBuffer === undefined ||
      resources.bakedDescriptorBuffer === undefined ||
      resources.bakedSamplesBuffer === undefined ||
      (resources.waterInfoTextureView !== undefined &&
        (!Number.isSafeInteger(resources.waterInfoContentFrameGeneration) ||
          resources.waterInfoContentFrameGeneration === undefined ||
          resources.waterInfoContentFrameGeneration < 0 ||
          !resources.waterInfoContentGraphResourceVersion ||
          !resources.waterInfoTargetName ||
          resources.waterInfoSampler === undefined ||
          (resources.waterInfoFormat !== 'rgba16float' &&
            resources.waterInfoFormat !== 'rgba32float'))) ||
      [...resources.bodyTargetNames.keys()].some(
        (bodyGuid) =>
          !resources.bodyTargetFormats.has(bodyGuid) ||
          !resources.waterInfoDescriptorDynamicOffsets.has(bodyGuid),
      ) ||
      [...resources.bodyIndices.keys()].some(
        (bodyGuid) =>
          !resources.bodyIndexDynamicOffsets.has(bodyGuid) ||
          !resources.bodyGenerations.has(bodyGuid) ||
          !resources.bodyZoneGenerations.has(bodyGuid),
      )
    ) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'same-generation water wave buffers, draw rows and WaterInfo descriptor',
          hint: 'rebuild and publish one complete Water material frame before binding it',
        }),
      );
    }
    return undefined;
  };
  const frameResourcesFailure = validateWaterMaterialFrameResources();
  if (frameResourcesFailure !== undefined) return frameResourcesFailure;
  if (
    !isWaterMeshLayoutReceiptValid(
      resources.waterMeshInstanceLayout,
      resources.waterMeshInstanceBytes,
    ) ||
    [...resources.waterMeshInstanceDynamicOffsets.values()].some(
      (offset) =>
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % resources.waterMeshInstanceOffsetAlignment !== 0 ||
        offset + resources.waterMeshInstanceBindingSize >
          resources.waterMeshInstanceBytes.byteLength,
    )
  )
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected:
          'WaterMesh buffer layout receipt matching the uploaded view records and dynamic bindings',
        hint: 'rebuild the WaterMesh instance upload and layout receipt together',
      }),
    );
  const entries = waterMaterialFrameBindGroupEntries(resources);
  const result = device.createBindGroup({
    label: `water-material-frame:${resources.viewIdentity}:${resources.frameGeneration}`,
    layout,
    entries,
  });
  if (!result.ok) return result;
  return ok(Object.freeze({ ...resources, bindGroup: result.value }));
}

export type WaterMaterialBindingError =
  | {
      readonly code: 'water-material-binding-missing';
      readonly expected: string;
      readonly detail: Readonly<Record<string, unknown>>;
    }
  | {
      readonly code: 'water-material-binding-stale';
      readonly expected: string;
      readonly detail: Readonly<Record<string, unknown>>;
    };

export function waterMaterialBodyIndex(
  bindings: WaterMaterialFrameBindings,
  bodyGuid: string,
  expected: Readonly<{
    viewIdentity: string;
    zoneGeneration: number;
    deviceGeneration: number;
    frameGeneration: number;
    bodyGeneration?: number;
  }>,
): Result<number, WaterMaterialBindingError> {
  if (
    bindings.viewIdentity !== expected.viewIdentity ||
    bindings.deviceGeneration !== expected.deviceGeneration ||
    bindings.frameGeneration !== expected.frameGeneration
  ) {
    return err({
      code: 'water-material-binding-stale',
      expected: 'wave/WaterInfo binding matching the current view, device and frame generations',
      detail: {
        expected,
        actual: {
          viewIdentity: bindings.viewIdentity,
          deviceGeneration: bindings.deviceGeneration,
          frameGeneration: bindings.frameGeneration,
        },
      },
    });
  }
  const bodyIndex = bindings.bodyIndices.get(bodyGuid);
  if (bodyIndex === undefined)
    return err({
      code: 'water-material-binding-missing',
      expected:
        'generation-qualified WaterBody owner row in the submitted view WaveSet/WaterInfo closure',
      detail: { bodyGuid, viewIdentity: bindings.viewIdentity },
    });
  if (bindings.bodyZoneGenerations.get(bodyGuid) !== expected.zoneGeneration)
    return err({
      code: 'water-material-binding-stale',
      expected: 'owner Zone generation matching the current water mesh draw',
      detail: {
        bodyGuid,
        expectedZoneGeneration: expected.zoneGeneration,
        actualZoneGeneration: bindings.bodyZoneGenerations.get(bodyGuid),
      },
    });
  if (
    expected.bodyGeneration !== undefined &&
    bindings.bodyGenerations.get(bodyGuid) !== expected.bodyGeneration
  )
    return err({
      code: 'water-material-binding-stale',
      expected: 'owner body generation matching the current WaterMesh draw',
      detail: {
        bodyGuid,
        expectedBodyGeneration: expected.bodyGeneration,
        actualBodyGeneration: bindings.bodyGenerations.get(bodyGuid),
      },
    });
  return ok(bodyIndex);
}

/** Retained targets can share a body. Prefer the cohort owning its draw offset. */
function selectWaterBodyBindings(
  bindings: ReadonlyMap<string, WaterMaterialFrameBindings>,
  bodyGuid: string,
  drawKey: string | undefined,
): WaterMaterialFrameBindings | undefined {
  let first: WaterMaterialFrameBindings | undefined;
  for (const candidate of bindings.values()) {
    if (
      !candidate.bodyIndices.has(bodyGuid) ||
      candidate.bodyTargetNames.get(bodyGuid) !== candidate.waterInfoTargetName
    )
      continue;
    if (drawKey === undefined || candidate.waterMeshInstanceDynamicOffsets?.has(drawKey))
      return candidate;
    first ??= candidate;
  }
  return first;
}

export function waterMaterialDrawBinding(
  bindings: WaterMaterialFrameBindings | ReadonlyMap<string, WaterMaterialFrameBindings>,
  bodyGuid: string,
  expected: Readonly<{
    viewIdentity: string;
    zoneGeneration: number;
    deviceGeneration: number;
    frameGeneration: number;
    bodyGeneration?: number;
    targetName?: string;
  }>,
  drawKey?: string,
): Result<WaterMaterialDrawBinding, WaterMaterialBindingError> {
  const frameBindings =
    'bodyIndices' in bindings
      ? bindings
      : expected.targetName !== undefined
        ? bindings.get(expected.targetName)
        : selectWaterBodyBindings(bindings, bodyGuid, drawKey);
  if (frameBindings === undefined)
    return err({
      code: 'water-material-binding-missing',
      expected: 'Water frame binding for the accepted Body source',
      detail: {
        bodyGuid,
        targetName: expected.targetName,
        availableTargets: 'bodyIndices' in bindings ? [] : [...bindings.keys()],
      },
    });
  const validateAcceptedWaterMaterialTarget = (
    checkedBindings: WaterMaterialFrameBindings,
  ): Result<never, WaterMaterialBindingError> | undefined => {
    if (
      expected.targetName !== undefined &&
      checkedBindings.waterInfoTargetName !== expected.targetName
    )
      return err({
        code: 'water-material-binding-stale',
        expected: 'WaterInfo frame binding for the body target',
        detail: {
          bodyGuid,
          expectedTargetName: expected.targetName,
          actualTargetName: checkedBindings.waterInfoTargetName,
        },
      });
    if (
      expected.targetName !== undefined &&
      checkedBindings.bodyTargetNames.get(bodyGuid) !== expected.targetName
    )
      return err({
        code: 'water-material-binding-stale',
        expected: 'body target mapping from the accepted WaterInfo publication',
        detail: {
          bodyGuid,
          expectedTargetName: expected.targetName,
          actualTargetName: checkedBindings.bodyTargetNames.get(bodyGuid),
        },
      });
    return undefined;
  };
  const targetFailure = validateAcceptedWaterMaterialTarget(frameBindings);
  if (targetFailure !== undefined) return targetFailure;
  const index = waterMaterialBodyIndex(frameBindings, bodyGuid, expected);
  if (!index.ok) return index;
  const sourceBodyIndices = [index.value];
  const dynamicOffset = frameBindings.bodyIndexDynamicOffsets.get(bodyGuid);
  const waterInfoDynamicOffset = frameBindings.waterInfoDescriptorDynamicOffsets.get(bodyGuid);
  if (
    frameBindings.bodyTargetNames.has(bodyGuid) &&
    (waterInfoDynamicOffset === undefined ||
      !Number.isSafeInteger(waterInfoDynamicOffset) ||
      waterInfoDynamicOffset < 0 ||
      waterInfoDynamicOffset % WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES !== 0)
  ) {
    return err({
      code: 'water-material-binding-missing',
      expected: `WaterInfo descriptor with ${WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES}-byte aligned dynamic offsets`,
      detail: { bodyGuid, waterInfoDynamicOffset },
    });
  }
  if (
    dynamicOffset === undefined ||
    !Number.isSafeInteger(dynamicOffset) ||
    dynamicOffset < 0 ||
    dynamicOffset % WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES !== 0
  ) {
    return err({
      code: 'water-material-binding-missing',
      expected: `body draw data with ${WATER_MATERIAL_DRAW_DATA_STRIDE_BYTES}-byte aligned dynamic offsets`,
      detail: { bodyGuid, dynamicOffset },
    });
  }
  const captureWaterMeshDrawBinding = (
    frameBindings: WaterMaterialFrameBindings,
    index: number,
    dynamicOffset: number,
  ): Result<WaterMaterialDrawBinding, WaterMaterialBindingError> => {
    const waterMeshInstanceDynamicOffset =
      drawKey === undefined ? 0 : frameBindings.waterMeshInstanceDynamicOffsets.get(drawKey);
    if (
      waterMeshInstanceDynamicOffset === undefined ||
      !Number.isSafeInteger(waterMeshInstanceDynamicOffset) ||
      waterMeshInstanceDynamicOffset < 0 ||
      waterMeshInstanceDynamicOffset % frameBindings.waterMeshInstanceOffsetAlignment !== 0
    )
      return err({
        code: 'water-material-binding-missing',
        expected: `${frameBindings.waterMeshInstanceOffsetAlignment}-byte aligned WaterMesh storage range for this owner/bucket draw`,
        detail: { bodyGuid, drawKey, waterMeshInstanceDynamicOffset },
      });
    const transitionTargets =
      drawKey === undefined ? [] : frameBindings.waterMeshTransitionTargetsByDraw.get(drawKey);
    if (transitionTargets === undefined)
      return err({
        code: 'water-material-binding-missing',
        expected: 'transition WaveParam rows recorded for this WaterMesh draw',
        detail: { bodyGuid, drawKey },
      });
    const meshWords = new DataView(
      frameBindings.waterMeshInstanceBytes.buffer,
      frameBindings.waterMeshInstanceBytes.byteOffset,
      frameBindings.waterMeshInstanceBytes.byteLength,
    );
    const captureTransitionTargetIndices = (
      frameBindings: WaterMaterialFrameBindings,
      transitionTargets: NonNullable<
        ReturnType<WaterMaterialFrameBindings['waterMeshTransitionTargetsByDraw']['get']>
      >,
      waterMeshInstanceDynamicOffset: number,
    ): Result<never, WaterMaterialBindingError> | undefined => {
      for (const target of transitionTargets) {
        const targetIndex = frameBindings.bodyIndices.get(target.bodyGuid);
        const targetDataOffset =
          targetIndex === undefined
            ? undefined
            : frameBindings.bodyIndexDynamicOffsets.get(target.bodyGuid);
        const targetDescriptorOffset = frameBindings.waterInfoDescriptorDynamicOffsets.get(
          target.bodyGuid,
        );
        const targetName = frameBindings.bodyTargetNames.get(target.bodyGuid);
        if (
          targetIndex === undefined ||
          targetDataOffset === undefined ||
          targetDescriptorOffset === undefined
        )
          return err({
            code: 'water-material-binding-missing',
            expected:
              'generation-qualified target WaterBody, WaveSet, and WaterInfo rows for transition draws',
            detail: { bodyGuid: target.bodyGuid, drawKey },
          });
        if (
          frameBindings.bodyGenerations.get(target.bodyGuid) !== target.bodyGeneration ||
          frameBindings.bodyZoneGenerations.get(target.bodyGuid) !== target.zoneGeneration ||
          target.zoneGeneration !== expected.zoneGeneration ||
          targetName !== frameBindings.waterInfoTargetName ||
          frameBindings.bodyTargetFormats.get(target.bodyGuid) !== frameBindings.waterInfoFormat
        )
          return err({
            code: 'water-material-binding-stale',
            expected:
              'transition target WaveSet and WaterInfo target/format matching the owner draw Zone generation',
            detail: {
              bodyGuid: target.bodyGuid,
              drawKey,
              targetName,
              targetFormat: frameBindings.bodyTargetFormats.get(target.bodyGuid),
              waterInfoTargetName: frameBindings.waterInfoTargetName,
              waterInfoFormat: frameBindings.waterInfoFormat,
            },
          });
        const encodedWaveIndex = meshWords.getUint32(
          waterMeshInstanceDynamicOffset +
            target.instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES +
            WATER_MESH_INSTANCE_LAYOUT.offsets.transitionWaveIndexPlusOne,
          true,
        );
        if (encodedWaveIndex !== targetIndex + 1)
          return err({
            code: 'water-material-binding-stale',
            expected:
              'transition record WaveParamIndex matching its generation-qualified target row',
            detail: { bodyGuid: target.bodyGuid, drawKey, encodedWaveIndex, targetIndex },
          });
        sourceBodyIndices.push(targetIndex);
      }
      return undefined;
    };
    const transitionFailure = captureTransitionTargetIndices(
      frameBindings,
      transitionTargets,
      waterMeshInstanceDynamicOffset,
    );
    if (transitionFailure !== undefined) return transitionFailure;
    return ok(
      Object.freeze({
        bodyIndex: index,
        sourceBodyIndices: Object.freeze(sourceBodyIndices),
        ...(waterInfoDynamicOffset === undefined ? {} : { waterInfoDynamicOffset }),
        dynamicOffset,
        waterMeshInstanceDynamicOffset,
        frameBindings,
        bindGroup: frameBindings.bindGroup,
      }),
    );
  };
  return captureWaterMeshDrawBinding(frameBindings, index.value, dynamicOffset);
}
