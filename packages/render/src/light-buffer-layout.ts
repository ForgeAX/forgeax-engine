// @forgeax/engine-render - host-side DirectLightSlot ABI and buffer helpers.
//
// Point, Spot, and Rect snapshots share one six-row, 96-byte Cluster slot.
// The same packer is used by the Cluster producer and every Cluster consumer.
// No-storage devices carry a bounded unshadowed point subset in the View UBO.

import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { LIGHTING_CHANNELS_DEFAULT } from './components/lighting-channels';
import type {
  PointLightSnapshot,
  RectAreaDirectLightSnapshot,
  SpotLightSnapshot,
} from './render-system-extract';
// Owns the byte-frozen std430 layout (D-S2). Point, Spot, and Rect all use the
// same six-row DirectLightSlot; the kind and resource identities are carried
// by the metadata row. Point uses the angular lanes as neutral values. Spot
// uses row 3's x/y/z lanes for volume shadow receiver controls and w for the
// extended-lighting roll angle. Rect uses row 2/3 for its two tangent axes.
//
// AC anchor: requirements AC-04 (c) + C-7 (16 B alignment); plan-strategy
// section 2 D-S2 (byte-frozen layout); research Finding 2 (Bevy
// invRangeSquared naming) + Finding 9 (Bevy storage buffer pattern).
//
// Cap gate: maxStorageBuffersPerShaderStage >= 4 (Cluster occupies four
// storage entries: meshSSBO + light_data + cluster_grid + light_index_list;
// default WebGPU minimum is 8, requirements assumption A-7 + plan R-4). The closed
// `RhiErrorCode` union has no `'rhi-not-supported'` member; the
// plan-strategy phrasing collapses onto the spec-aligned `'limit-exceeded'`
// arm which already documents "input value exceeded device.limits.<name>"
// (RhiError JSDoc on packages/rhi/src/errors.ts). Reusing `'limit-exceeded'`
// keeps `RhiErrorCode` count at 18 (AGENTS.md error model evolution
// contract: minor add-only; w20a explicitly forbids count drift).

/**
 * Minimum storage-buffer count needed by the M3 record stage.
 *
 *   1. Mesh SSBO (current/previous entity_world + temporal; per-renderable dynamic
 *      offset, 256 B stride).
 *   2. Cluster light_data SSBO.
 *   3. Cluster membership grid SSBO.
 *   4. Cluster light-index-list SSBO.
 *
 * Cluster needs four storage-backed resources in the Standard bind group.
 * This is the complete local-light transport.
 */
export const STORAGE_BUFFER_MIN_REQUIRED = 4;

/** Byte size of one Point/Spot/Rect DirectLightSlot. */
export const BYTES_PER_DIRECT_LIGHT_SLOT = 96;

/**
 * Cap gate at createRenderer time: check whether the device has enough
 * storage-buffer slots for the PBR pipeline (M3 requires
 * `STORAGE_BUFFER_MIN_REQUIRED = 4`). Returns a three-way signal:
 *
 *  - `Result.ok(true)`  — storage buffer capable (cap >= 4);
 *  - `Result.ok(false)` — no storage buffer capability at all (cap === 0);
 *    consumer walks the uniform-fallback path;
 *  - `Result.err(RhiError)` — cap in (0, 4); not enough storage slots to run
 *    but also not a clean zero-cap uniform-fallback case (e.g. downlevel
 *    adapter with 1-3 slots). The error carries `'limit-exceeded'` with
 *    `LimitExceededDetail` shape.
 *
 * Uniform-fallback path decision (plan D-5): `cap === 0` is the wgpu
 * WebGL2 backend signal (`downlevel_webgl2_defaults().limits.
 * maxStorageBuffersPerShaderStage = 0`). It remains a mesh/instance fallback;
 * other local-light frames require a Cluster storage transport; up to four
 * unshadowed point lights use the View-uniform raster lane.
 */
/** Closed direct-light kind carried by the unified six-row slot. */
export const DirectLightSlotKind = {
  POINT: 0,
  SPOT: 1,
  RECT_AREA: 2,
} as const;
export type DirectLightSlotKind = 'point' | 'spot' | 'rect-area';

/** Metadata identity used for absent shadow, IES, and Cookie resources. */
export const DIRECT_LIGHT_SLOT_METADATA_SENTINEL = 0xffffffff;
/**
 * SpotLight projector marker carried in the shared shadow identity word. The
 * lower 30 bits retain the selected shadow tile; projector-only spots use tile
 * zero because their matrix is deliberately published in View lane zero.
 */
export const DIRECT_LIGHT_SLOT_PROJECTOR_FLAG = 0x40000000;
export const DIRECT_LIGHT_SLOT_TILE_MASK = DIRECT_LIGHT_SLOT_PROJECTOR_FLAG - 1;
/**
 * The kind word keeps the closed kind in its low byte; Spot packs its live PCF
 * kernel width above it so the receiver filter follows the component per frame.
 */
export const DIRECT_LIGHT_SLOT_KIND_MASK = 0xff;
export const DIRECT_LIGHT_SLOT_PCF_SHIFT = 8;
const PUNCTUAL_PCF_KERNEL_MAX = 5;

function punctualPcfKernel(value: number | undefined): number {
  return Math.min(PUNCTUAL_PCF_KERNEL_MAX, Math.max(1, Math.round(value ?? 3)));
}
/** Byte size of the six-row Point/Spot/Rect transport slot. */
export const DIRECT_LIGHT_SLOT_FLOAT_COUNT =
  BYTES_PER_DIRECT_LIGHT_SLOT / Float32Array.BYTES_PER_ELEMENT;

/** Six vec4 rows shared by host packing and the WGSL direct-light consumer. */
export const DIRECT_LIGHT_SLOT_LAYOUT = {
  byteSize: BYTES_PER_DIRECT_LIGHT_SLOT,
  rowByteOffsets: [0, 16, 32, 48, 64, 80],
  positionOffset: 0,
  rangeOffset: 12,
  colorOffset: 16,
  firstAngleOffset: 28,
  primaryAxisOffset: 32,
  secondAngleOffset: 44,
  auxiliaryAxisOffset: 48,
  metadataByteOffset: 64,
  kindByteOffset: 64,
  shadowByteOffset: 68,
  iesProfileByteOffset: 72,
  cookieByteOffset: 76,
  /** Spot-only roll angle stored in the fourth row's w lane. */
  rollDegByteOffset: 60,
  floatCount: DIRECT_LIGHT_SLOT_FLOAT_COUNT,
  vec4Count: 6,
  lightingChannelsByteOffset: 80,
} as const;

export type DirectLightSnapshot =
  | PointLightSnapshot
  | SpotLightSnapshot
  | RectAreaDirectLightSnapshot;

function directLightMetadata(value: number | undefined): number {
  return value === undefined ? DIRECT_LIGHT_SLOT_METADATA_SENTINEL : value >>> 0;
}

/**
 * Pack one Point, Spot, or Rect snapshot into the unified six-row slot.
 *
 * Row 0 is position plus inverse range. Row 1 is color plus the first
 * angular/size fact. Row 2 is the primary axis plus the second angular/size
 * fact. Row 3 is the auxiliary Rect axis. Row 4 is four u32 identities.
 */
export function packDirectLightSlot(
  snapshot: DirectLightSnapshot,
  projectorSelected?: boolean,
): Float32Array {
  const out = new Float32Array(DIRECT_LIGHT_SLOT_FLOAT_COUNT);
  out[0] = snapshot.position[0] ?? 0;
  out[1] = snapshot.position[1] ?? 0;
  out[2] = snapshot.position[2] ?? 0;
  out[3] = snapshot.invRangeSquared;
  out[4] = snapshot.color[0] ?? 0;
  out[5] = snapshot.color[1] ?? 0;
  out[6] = snapshot.color[2] ?? 0;

  if (snapshot.kind === 'point') {
    out[7] = snapshot.decay ?? 2;
    if (snapshot.iesProfileSlice !== undefined) {
      out.set(snapshot.axisY ?? [0, 1, 0], 8);
      out.set(snapshot.axisX ?? [1, 0, 0], 12);
    }
  } else if (snapshot.kind === 'spot') {
    out[7] = snapshot.cosInner;
    out[8] = snapshot.direction[0] ?? 0;
    out[9] = snapshot.direction[1] ?? 0;
    out[10] = snapshot.direction[2] ?? 0;
    out[11] = snapshot.cosOuter;
    // Row 3 is the Rect auxiliary axis for RectArea lights. Spot uses x/y/z
    // for its receiver controls and w for roll; the surface direct-light
    // owner only consumes w, while the volume owner consumes the full row.
    out[12] = snapshot.depthBias ?? 0.00001;
    out[13] = snapshot.normalBias ?? 0.05;
    out[14] = snapshot.shadowIntensity ?? 1;
    out[15] = snapshot.rollDeg ?? 0;
  } else {
    out[7] = snapshot.halfWidth;
    out[8] = snapshot.axisY[0] ?? 0;
    out[9] = snapshot.axisY[1] ?? 0;
    out[10] = snapshot.axisY[2] ?? 0;
    out[11] = snapshot.halfHeight;
    out[12] = snapshot.axisX[0] ?? 0;
    out[13] = snapshot.axisX[1] ?? 0;
    out[14] = snapshot.axisX[2] ?? 0;
  }

  const metadata = new Uint32Array(out.buffer);
  metadata[16] =
    snapshot.kind === 'point'
      ? DirectLightSlotKind.POINT |
        (punctualPcfKernel(snapshot.pcfKernelSize) << DIRECT_LIGHT_SLOT_PCF_SHIFT)
      : snapshot.kind === 'spot'
        ? DirectLightSlotKind.SPOT |
          (punctualPcfKernel(snapshot.pcfKernelSize) << DIRECT_LIGHT_SLOT_PCF_SHIFT)
        : DirectLightSlotKind.RECT_AREA;
  const spotProjectorSelected =
    snapshot.kind === 'spot' &&
    (projectorSelected ??
      (snapshot.projectorAsset !== undefined && snapshot.lightViewProj !== undefined));
  const spotShadowMetadata =
    snapshot.kind === 'spot'
      ? spotProjectorSelected
        ? DIRECT_LIGHT_SLOT_PROJECTOR_FLAG |
          ((snapshot.shadowAtlasTile >= 0 ? snapshot.shadowAtlasTile : 0) &
            DIRECT_LIGHT_SLOT_TILE_MASK)
        : directLightMetadata(snapshot.shadowAtlasTile)
      : undefined;
  metadata[17] = directLightMetadata(
    snapshot.kind === 'point'
      ? snapshot.shadowAtlasLayer
      : snapshot.kind === 'spot'
        ? spotShadowMetadata
        : undefined,
  );
  metadata[18] = directLightMetadata(snapshot.iesProfileSlice);
  metadata[19] = directLightMetadata(
    spotProjectorSelected && snapshot.kind === 'spot'
      ? snapshot.projectorSlice
      : snapshot.kind === 'point'
        ? undefined
        : snapshot.cookieSlice,
  );
  metadata[20] = snapshot.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT;
  return out;
}

export function assertStorageBufferCap(cap: number): Result<boolean, RhiError> {
  if (cap >= STORAGE_BUFFER_MIN_REQUIRED) {
    return ok(true);
  }
  if (cap === 0) {
    return ok(false);
  }
  return err(
    new RhiError({
      code: 'limit-exceeded',
      expected: `device.limits.maxStorageBuffersPerShaderStage >= ${STORAGE_BUFFER_MIN_REQUIRED}, or exactly 0 for the mesh-only fallback`,
      hint: `device.limits.maxStorageBuffersPerShaderStage = ${cap} < ${STORAGE_BUFFER_MIN_REQUIRED} and != 0. WebGPU spec default minimum is 8; this adapter cannot run the unified Cluster local-light path.`,
      detail: {
        maxStorageBufferBindingSize: cap,
        requestedBytes: STORAGE_BUFFER_MIN_REQUIRED,
      },
    }),
  );
}
