export const WATER_MESH_INSTANCE_SCHEMA_VERSION = 7 as const;
export const WATER_MESH_INSTANCE_STRIDE_BYTES = 96 as const;

const WATER_MESH_INSTANCE_OFFSETS = Object.freeze({
  originX: 0,
  originZ: 4,
  extentX: 8,
  extentZ: 12,
  waterYM: 16,
  yMinM: 20,
  yMaxM: 24,
  ownerRenderIndex: 28,
  transitionWaveIndexPlusOne: 32,
  lod0: 36,
  lod1: 40,
  lodScaleM: 44,
  materialBucket: 48,
  densityBucket: 52,
  priorityU16: 56,
  flags: 58,
  quadsPerEdge: 60,
  waveOriginOffsetX: 64,
  waveOriginOffsetZ: 68,
  coverageWordOffset: 72,
  coverageRingCount: 76,
  cameraRelativeX: 80,
  cameraRelativeZ: 84,
  maxMorphLod: 88,
  flatFarBoundaryMask: 92,
});

const WATER_MESH_INSTANCE_LAYOUT_SIGNATURE =
  'water-mesh-tile-v7|96|originX:f32@0|originZ:f32@4|extentX:f32@8|extentZ:f32@12|waterYM:f32@16|yMinM:f32@20|yMaxM:f32@24|ownerRenderIndex:u32@28|transitionWaveIndexPlusOne:u32@32|lod0:u32@36|lod1:u32@40|lodScaleM:f32@44|materialBucket:u32@48|densityBucket:u32@52|priorityU16:u16@56|flags:u16@58|quadsPerEdge:u32@60|waveOriginOffsetX:f32@64|waveOriginOffsetZ:f32@68|coverageWordOffset:u32@72|coverageRingCount:u32@76|cameraRelativeX:f32@80|cameraRelativeZ:f32@84|maxMorphLod:u32@88|flatFarBoundaryMask:u32@92';

function hashBytes(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashSignature(signature: string): string {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index++)
    hash = Math.imul(hash ^ signature.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const WATER_MESH_INSTANCE_LAYOUT = Object.freeze({
  schemaVersion: WATER_MESH_INSTANCE_SCHEMA_VERSION,
  strideBytes: WATER_MESH_INSTANCE_STRIDE_BYTES,
  offsets: WATER_MESH_INSTANCE_OFFSETS,
  layoutHash: hashSignature(WATER_MESH_INSTANCE_LAYOUT_SIGNATURE),
});

export const WATER_MESH_INSTANCE_LAYOUT_HASH = WATER_MESH_INSTANCE_LAYOUT.layoutHash;

export type WaterMeshLayoutReceipt = Readonly<{
  schemaVersion: typeof WATER_MESH_INSTANCE_SCHEMA_VERSION;
  strideBytes: typeof WATER_MESH_INSTANCE_STRIDE_BYTES;
  offsets: Readonly<Record<string, number>>;
  byteLength: number;
  coverageByteLength: number;
  layoutHash: string;
  dataHash: string;
  coverageDataHash: string;
}>;

export function createWaterMeshLayoutReceipt(
  instanceBytes: Uint8Array,
  coverageBytes: Uint8Array,
): WaterMeshLayoutReceipt {
  return Object.freeze({
    schemaVersion: WATER_MESH_INSTANCE_LAYOUT.schemaVersion,
    strideBytes: WATER_MESH_INSTANCE_LAYOUT.strideBytes,
    offsets: WATER_MESH_INSTANCE_LAYOUT.offsets,
    byteLength: instanceBytes.byteLength,
    coverageByteLength: coverageBytes.byteLength,
    layoutHash: WATER_MESH_INSTANCE_LAYOUT.layoutHash,
    dataHash: hashBytes(instanceBytes),
    coverageDataHash: hashBytes(coverageBytes),
  });
}

export function isWaterMeshLayoutReceiptValid(
  receipt: WaterMeshLayoutReceipt,
  instanceBytes: Uint8Array,
  coverageBytes?: Uint8Array,
): boolean {
  const offsets = WATER_MESH_INSTANCE_LAYOUT.offsets;
  if (
    receipt.schemaVersion !== WATER_MESH_INSTANCE_LAYOUT.schemaVersion ||
    receipt.strideBytes !== WATER_MESH_INSTANCE_LAYOUT.strideBytes ||
    receipt.byteLength !== instanceBytes.byteLength ||
    receipt.layoutHash !== WATER_MESH_INSTANCE_LAYOUT.layoutHash ||
    receipt.dataHash !== hashBytes(instanceBytes) ||
    !Number.isSafeInteger(receipt.coverageByteLength) ||
    receipt.coverageByteLength < 0 ||
    receipt.coverageByteLength % 4 !== 0 ||
    !/^[0-9a-f]{8}$/i.test(receipt.coverageDataHash) ||
    Object.keys(receipt.offsets).length !== Object.keys(offsets).length ||
    Object.entries(offsets).some(([name, offset]) => receipt.offsets[name] !== offset)
  )
    return false;
  if (coverageBytes === undefined) return true;
  return (
    receipt.coverageByteLength === coverageBytes.byteLength &&
    receipt.coverageDataHash === hashBytes(coverageBytes)
  );
}
