// @forgeax/engine-render - host-side DirectLightSlot ABI and buffer helpers.
//
// Point, Spot, Rect and additional unshadowed Directional snapshots share
// one reflected six-row Cluster slot.
// The same packer is used by the Cluster producer and every Cluster consumer.
// No-storage devices carry a bounded unshadowed point subset in the View UBO.

import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { ShaderReflection, ShaderReflectionBoundGlobal } from '@forgeax/engine-types';
import { LIGHTING_CHANNELS_DEFAULT } from './components/lighting-channels';
import type {
  DirectionalLightSnapshot,
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
  DIRECTIONAL: 3,
} as const;
export type DirectLightSlotKind = 'point' | 'spot' | 'rect-area' | 'directional';

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
export interface ReflectedDirectLightSlotLayout {
  readonly capacity: number;
  readonly byteSize: number;
  readonly rowByteOffsets: readonly number[];
  readonly positionOffset: number;
  readonly rangeOffset: number;
  readonly colorOffset: number;
  readonly firstAngleOffset: number;
  readonly primaryAxisOffset: number;
  readonly secondAngleOffset: number;
  readonly auxiliaryAxisOffset: number;
  readonly metadataByteOffset: number;
  readonly kindByteOffset: number;
  readonly shadowByteOffset: number;
  readonly iesProfileByteOffset: number;
  readonly cookieByteOffset: number;
  readonly rollDegByteOffset: number;
  readonly floatCount: number;
  readonly vec4Count: number;
  readonly lightingChannelsByteOffset: number;
}

export interface StandardClusterReflectedAbi {
  readonly directLightSlot: ReflectedDirectLightSlotLayout;
  readonly clusterUniformBytes: number;
  readonly clusterUniformOffsets: Readonly<
    Record<'grid' | 'near_far_log' | 'ao' | 'direct_ao' | 'texture' | 'cluster_layout', number>
  >;
}

type ClusterReflectionGlobal = ShaderReflectionBoundGlobal;
type ClusterReflectionMember = NonNullable<ClusterReflectionGlobal['members']>[number];
type ClusterLightDataGlobal = ClusterReflectionGlobal & {
  readonly resourceKind: 'storage-buffer';
  readonly addressSpace: 'storage';
  readonly elementStride: number;
  readonly arrayLength: number;
  readonly members: readonly ClusterReflectionMember[];
};
type ClusterUniformGlobal = ClusterReflectionGlobal & {
  readonly resourceKind: 'buffer';
  readonly addressSpace: 'uniform';
  readonly span: number;
  readonly members: readonly ClusterReflectionMember[];
};

interface ClusterReflectionRows {
  readonly position: ClusterReflectionMember;
  readonly color: ClusterReflectionMember;
  readonly direction: ClusterReflectionMember;
  readonly auxiliary: ClusterReflectionMember;
  readonly metadata: ClusterReflectionMember;
  readonly channels: ClusterReflectionMember;
  readonly grid: ClusterReflectionMember;
  readonly nearFarLog: ClusterReflectionMember;
  readonly ao: ClusterReflectionMember;
  readonly directAo: ClusterReflectionMember;
  readonly texture: ClusterReflectionMember;
  readonly clusterLayout: ClusterReflectionMember;
}

function isClusterLightDataGlobal(
  global: ClusterReflectionGlobal | undefined,
): global is ClusterLightDataGlobal {
  return (
    global?.resourceKind === 'storage-buffer' &&
    global.addressSpace === 'storage' &&
    global.elementStride !== undefined &&
    global.arrayLength !== undefined &&
    Number.isSafeInteger(global.arrayLength) &&
    global.arrayLength > 0 &&
    global.members !== undefined
  );
}

function isClusterUniformGlobal(
  global: ClusterReflectionGlobal | undefined,
): global is ClusterUniformGlobal {
  return (
    global?.resourceKind === 'buffer' &&
    global.addressSpace === 'uniform' &&
    global.span !== undefined &&
    global.members !== undefined
  );
}

function requiredClusterGlobals(
  reflection: ShaderReflection,
):
  | { readonly lightData: ClusterLightDataGlobal; readonly uniform: ClusterUniformGlobal }
  | undefined {
  const globals = reflection.boundGlobals;
  if (globals === undefined) return undefined;
  const lightData = globals.find((global) => global.group === 2 && global.binding === 3);
  const uniform = globals.find((global) => global.group === 2 && global.binding === 6);
  if (!isClusterLightDataGlobal(lightData) || !isClusterUniformGlobal(uniform)) return undefined;
  return { lightData, uniform };
}

function requiredClusterRows(
  lightData: ClusterLightDataGlobal,
  uniform: ClusterUniformGlobal,
  fields: readonly string[],
  expectedUniformFields: readonly string[],
): ClusterReflectionRows | undefined {
  const slot = new Map(lightData.members.map((member) => [member.name, member]));
  const slotMembers = fields.map((name) => slot.get(name));
  const uniformMembers = new Map(uniform.members.map((member) => [member.name, member]));
  const uniformRows = expectedUniformFields.map((name) => uniformMembers.get(name));
  if (
    slotMembers.some(
      (member, index) =>
        member === undefined ||
        member.size !== 16 ||
        member.alignment !== 16 ||
        member.offset !== index * 16 ||
        member.type !== (index >= 4 ? 'vec4<u32>' : 'vec4<f32>'),
    ) ||
    lightData.elementStride !== fields.length * 16 ||
    uniformRows.some(
      (member, index) =>
        member === undefined ||
        member.size !== 16 ||
        member.alignment !== 16 ||
        member.offset !== index * 16 ||
        member.type !== (index === 1 || index === 3 ? 'vec4<f32>' : 'vec4<u32>'),
    ) ||
    uniform.span !== expectedUniformFields.length * 16
  )
    return undefined;
  const [position, color, direction, auxiliary, metadata, channels] = slotMembers;
  const [grid, nearFarLog, ao, directAo, texture, clusterLayout] = uniformRows;
  if (
    position === undefined ||
    color === undefined ||
    direction === undefined ||
    auxiliary === undefined ||
    metadata === undefined ||
    channels === undefined ||
    grid === undefined ||
    nearFarLog === undefined ||
    ao === undefined ||
    directAo === undefined ||
    texture === undefined ||
    clusterLayout === undefined
  )
    return undefined;
  return {
    position,
    color,
    direction,
    auxiliary,
    metadata,
    channels,
    grid,
    nearFarLog,
    ao,
    directAo,
    texture,
    clusterLayout,
  };
}

/** Resolve the host Cluster layout from the compiler reflection published with Standard PBR. */
export function deriveStandardClusterReflectedAbi(
  reflections: readonly (ShaderReflection | undefined)[],
): StandardClusterReflectedAbi | undefined {
  if (reflections.length === 0) return undefined;
  let resolved: StandardClusterReflectedAbi | undefined;
  for (const reflection of reflections) {
    const candidate = deriveStandardClusterAbiFromReflection(reflection);
    if (candidate === undefined) return undefined;
    if (resolved !== undefined && JSON.stringify(candidate) !== JSON.stringify(resolved))
      return undefined;
    resolved = candidate;
  }
  return resolved;
}

function deriveStandardClusterAbiFromReflection(
  reflection: ShaderReflection | undefined,
): StandardClusterReflectedAbi | undefined {
  if (reflection?.schemaVersion !== 'shader-reflection/3') return undefined;
  const globals = requiredClusterGlobals(reflection);
  if (globals === undefined) return undefined;
  const fields = [
    'position',
    'colorTimesIntensity',
    'direction',
    'auxiliary',
    'metadata',
    'channels',
  ];
  const expectedUniformFields = [
    'grid',
    'near_far_log',
    'ao',
    'direct_ao',
    'texture',
    'cluster_layout',
  ] as const;
  const { lightData, uniform } = globals;
  const rows = requiredClusterRows(lightData, uniform, fields, expectedUniformFields);
  if (rows === undefined) return undefined;
  const { position, color, direction, auxiliary, metadata, channels } = rows;
  const { grid, nearFarLog, ao, directAo, texture, clusterLayout } = rows;
  const rowByteOffsets = [
    position.offset,
    color.offset,
    direction.offset,
    auxiliary.offset,
    metadata.offset,
    channels.offset,
  ];
  const directLightSlot = {
    capacity: lightData.arrayLength,
    byteSize: lightData.elementStride,
    rowByteOffsets,
    positionOffset: position.offset,
    rangeOffset: position.offset + 12,
    colorOffset: color.offset,
    firstAngleOffset: color.offset + 12,
    primaryAxisOffset: direction.offset,
    secondAngleOffset: direction.offset + 12,
    auxiliaryAxisOffset: auxiliary.offset,
    metadataByteOffset: metadata.offset,
    kindByteOffset: metadata.offset,
    shadowByteOffset: metadata.offset + 4,
    iesProfileByteOffset: metadata.offset + 8,
    cookieByteOffset: metadata.offset + 12,
    rollDegByteOffset: auxiliary.offset + 12,
    floatCount: lightData.elementStride / Float32Array.BYTES_PER_ELEMENT,
    vec4Count: lightData.elementStride / 16,
    lightingChannelsByteOffset: channels.offset,
  } as const;
  return {
    directLightSlot,
    clusterUniformBytes: uniform.span,
    clusterUniformOffsets: {
      grid: grid.offset,
      near_far_log: nearFarLog.offset,
      ao: ao.offset,
      direct_ao: directAo.offset,
      texture: texture.offset,
      cluster_layout: clusterLayout.offset,
    },
  };
}

export type DirectLightSnapshot =
  | PointLightSnapshot
  | SpotLightSnapshot
  | RectAreaDirectLightSnapshot
  | DirectionalLightSnapshot;

function directLightMetadata(value: number | undefined): number {
  return value === undefined ? DIRECT_LIGHT_SLOT_METADATA_SENTINEL : value >>> 0;
}

/**
 * Pack a direct-light snapshot into its reflected unified six-row slot.
 *
 * Row 0 is position plus inverse range. Row 1 is color plus the first
 * angular/size fact. Row 2 is the primary axis plus the second angular/size
 * fact. Row 3 is the auxiliary Rect axis. Row 4 is four u32 identities.
 */
export function packDirectLightSlot(
  snapshot: DirectLightSnapshot,
  layout: ReflectedDirectLightSlotLayout,
  projectorSelected?: boolean,
): Float32Array {
  if (snapshot.kind === 'directional') return packDirectionalLightSlot(snapshot, layout);
  const out = new Float32Array(layout.floatCount);
  const view = new DataView(out.buffer);
  const writeFloat = (offset: number, value: number) => view.setFloat32(offset, value, true);
  const writeVec3 = (offset: number, value: ArrayLike<number>) => {
    writeFloat(offset, value[0] ?? 0);
    writeFloat(offset + 4, value[1] ?? 0);
    writeFloat(offset + 8, value[2] ?? 0);
  };
  writeVec3(layout.positionOffset, snapshot.position);
  writeFloat(layout.rangeOffset, snapshot.invRangeSquared);
  writeVec3(layout.colorOffset, snapshot.color);

  if (snapshot.kind === 'point') {
    writeFloat(layout.firstAngleOffset, snapshot.decay ?? 2);
    if (snapshot.iesProfileSlice !== undefined) {
      writeVec3(layout.primaryAxisOffset, snapshot.axisY ?? [0, 1, 0]);
      writeVec3(layout.auxiliaryAxisOffset, snapshot.axisX ?? [1, 0, 0]);
    }
  } else if (snapshot.kind === 'spot') {
    writeFloat(layout.firstAngleOffset, snapshot.cosInner);
    writeVec3(layout.primaryAxisOffset, snapshot.direction);
    writeFloat(layout.secondAngleOffset, snapshot.cosOuter);
    // Row 3 is the Rect auxiliary axis for RectArea lights. Spot uses x/y/z
    // for its receiver controls and w for roll; the surface direct-light
    // owner only consumes w, while the volume owner consumes the full row.
    writeFloat(layout.auxiliaryAxisOffset, snapshot.depthBias ?? 0.00001);
    writeFloat(layout.auxiliaryAxisOffset + 4, snapshot.normalBias ?? 0.05);
    writeFloat(layout.auxiliaryAxisOffset + 8, snapshot.shadowIntensity ?? 1);
    writeFloat(layout.rollDegByteOffset, snapshot.rollDeg ?? 0);
  } else {
    writeFloat(layout.firstAngleOffset, snapshot.halfWidth);
    writeVec3(layout.primaryAxisOffset, snapshot.axisY);
    writeFloat(layout.secondAngleOffset, snapshot.halfHeight);
    writeVec3(layout.auxiliaryAxisOffset, snapshot.axisX);
  }

  const metadata = new Uint32Array(out.buffer);
  metadata[layout.kindByteOffset / 4] =
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
  metadata[layout.shadowByteOffset / 4] = directLightMetadata(
    snapshot.kind === 'point'
      ? snapshot.shadowAtlasLayer
      : snapshot.kind === 'spot'
        ? spotShadowMetadata
        : undefined,
  );
  metadata[layout.iesProfileByteOffset / 4] = directLightMetadata(snapshot.iesProfileSlice);
  metadata[layout.cookieByteOffset / 4] = directLightMetadata(
    spotProjectorSelected && snapshot.kind === 'spot'
      ? snapshot.projectorSlice
      : snapshot.kind === 'point'
        ? undefined
        : snapshot.cookieSlice,
  );
  metadata[layout.lightingChannelsByteOffset / 4] =
    snapshot.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT;
  return out;
}

/** Additional directional members have neutral range and resource identities. */
function packDirectionalLightSlot(
  snapshot: DirectionalLightSnapshot,
  layout: ReflectedDirectLightSlotLayout,
): Float32Array {
  const out = new Float32Array(layout.floatCount);
  const view = new DataView(out.buffer);
  for (let component = 0; component < 3; component++) {
    view.setFloat32(layout.colorOffset + component * 4, snapshot.color[component] ?? 0, true);
    view.setFloat32(
      layout.primaryAxisOffset + component * 4,
      snapshot.direction[component] ?? (component === 1 ? -1 : 0),
      true,
    );
  }
  view.setUint32(layout.kindByteOffset, DirectLightSlotKind.DIRECTIONAL, true);
  for (const offset of [
    layout.shadowByteOffset,
    layout.iesProfileByteOffset,
    layout.cookieByteOffset,
  ])
    view.setUint32(offset, DIRECT_LIGHT_SLOT_METADATA_SENTINEL, true);
  view.setUint32(
    layout.lightingChannelsByteOffset,
    snapshot.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT,
    true,
  );
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
