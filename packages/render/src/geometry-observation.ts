/** One explicitly requested primary-view GPU command observation, never FPS or pixels. */
export interface GeometrySourceIdentity {
  readonly worldIdentity: string;
  readonly entityKey: number;
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
  readonly meshHandle: number;
  readonly meshGuid?: string;
  readonly sourceKey?: string;
  /** Accepted publication revision, or local RenderScene slot generation; not a content hash. */
  readonly sourceRevision: number;
  /** Producer-owned source submesh identity, never a compact-array position. */
  readonly drawItemIndex: number;
  readonly materialSlot: number;
  readonly instanceOrdinal: number;
}
export interface GeometryCommandObservation {
  readonly pass: string;
  readonly phase: 'all' | 'early' | 'late';
  readonly level: number;
  readonly batchId: number;
  readonly indirectOffset: number;
  readonly kind: 'indexed' | 'non-indexed';
  readonly topology: string;
  readonly count: number;
  readonly instanceCount: number;
  readonly first: number;
  readonly baseVertex: number;
  readonly firstInstance: number;
  readonly indexOrVertexWork: number;
  readonly members: readonly GeometrySourceIdentity[];
}
/** Copied from the submitted GPU cull uniform, rather than a later camera read. */
export interface GeometryViewObservation {
  readonly scope: 'submitted-gpu-cull-view-constants';
  readonly depthPyramid: 'unobserved';
  readonly frustumPlanes: readonly number[];
  readonly occlusionEnabled: boolean;
  readonly occlusionHistoryValid: boolean;
  readonly occlusionCamera?: {
    readonly viewProjection: readonly number[];
    readonly near: number;
    readonly far: number;
    readonly orthographic: boolean;
    readonly footprintScale: number;
  };
}
export type GeometryObservation = {
  readonly scope: 'primary-display-view-gpu-commands';
  readonly otherViews: 'unobserved';
  readonly shadows: 'unobserved';
  readonly cpuDraws: 'unobserved';
  readonly featureDraws: 'unobserved';
  readonly status: 'complete' | 'unavailable';
  readonly reason?: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration?: number;
  readonly viewKey?: string;
  readonly viewConstants?: GeometryViewObservation;
  readonly commands: readonly GeometryCommandObservation[];
  readonly commandCount: number;
  readonly indexOrVertexWork: number;
};
/** Offsets come from the same uniform ABI that writes the GPU buffer. */
export function decodeGeometryView(
  bytes: DataView,
  cameraOffset: number,
  stateOffset: number,
): GeometryViewObservation {
  if (
    !Number.isSafeInteger(cameraOffset) ||
    cameraOffset < 96 ||
    !Number.isSafeInteger(stateOffset) ||
    stateOffset < cameraOffset + 80 ||
    stateOffset + 8 > bytes.byteLength
  )
    throw Error('view-constant-range');
  const floats = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const value = bytes.getFloat32(offset + i * 4, true);
      if (!Number.isFinite(value)) throw Error('view-constant-nonfinite');
      return value;
    });
  const enabled = bytes.getUint32(stateOffset, true),
    history = bytes.getUint32(stateOffset + 4, true);
  if (enabled > 1 || history > enabled) throw Error('view-constant-state');
  const frustumPlanes = floats(0, 24);
  let occlusionCamera: GeometryViewObservation['occlusionCamera'];
  if (enabled === 1) {
    const viewProjection = floats(cameraOffset, 16);
    const [near = 0, far = 0] = floats(cameraOffset + 64, 2);
    const orthographic = bytes.getUint32(cameraOffset + 72, true);
    const [footprintScale = 0] = floats(cameraOffset + 76, 1);
    if (!(near > 0 && far > near && footprintScale > 0) || orthographic > 1)
      throw Error('view-constant-camera');
    occlusionCamera = {
      viewProjection,
      near,
      far,
      orthographic: orthographic === 1,
      footprintScale,
    };
  }
  return {
    scope: 'submitted-gpu-cull-view-constants',
    depthPyramid: 'unobserved',
    frustumPlanes,
    occlusionEnabled: enabled === 1,
    occlusionHistoryValid: history === 1,
    ...(occlusionCamera === undefined ? {} : { occlusionCamera }),
  };
}
export const GEOMETRY_OBSERVATION_MAX_BYTES = 1024 * 1024;
export const GEOMETRY_OBSERVATION_MAX_COMMANDS = 4096;
export const GEOMETRY_OBSERVATION_MAX_MEMBERS = 16384;
export function unavailableGeometry(
  reason: string,
  frameId = -1,
  deviceGeneration = -1,
): GeometryObservation {
  return {
    scope: 'primary-display-view-gpu-commands',
    otherViews: 'unobserved',
    shadows: 'unobserved',
    cpuDraws: 'unobserved',
    featureDraws: 'unobserved',
    status: 'unavailable',
    reason,
    frameId,
    deviceGeneration,
    commands: [],
    commandCount: 0,
    indexOrVertexWork: 0,
  };
}
/** Record-time command facts. The GPU supplies counts and actual visible instance rows. */
export interface GeometryCommandCapture {
  readonly pass: string;
  readonly phase: 'all' | 'early' | 'late';
  readonly level: number;
  readonly batchId: number;
  readonly indirectOffset: number;
  readonly visibleBase: number;
  readonly bufferIdentity: number;
  readonly kind: 'indexed' | 'non-indexed';
  readonly topology: string;
  readonly sources: ReadonlyMap<number, GeometrySourceIdentity>;
}
/** A visible GPU row may not disambiguate two source submeshes folded into one batch. */
export function captureGeometrySource(
  sources: Map<number, GeometrySourceIdentity>,
  row: number,
  source: GeometrySourceIdentity,
): void {
  const previous = sources.get(row);
  if (
    previous !== undefined &&
    (previous.worldIdentity !== source.worldIdentity ||
      previous.primitiveSlot !== source.primitiveSlot ||
      previous.slotGeneration !== source.slotGeneration ||
      previous.meshHandle !== source.meshHandle ||
      previous.drawItemIndex !== source.drawItemIndex ||
      previous.materialSlot !== source.materialSlot ||
      previous.instanceOrdinal !== source.instanceOrdinal ||
      previous.sourceRevision !== source.sourceRevision)
  )
    throw Error('ambiguous-instance-source');
  sources.set(row, source);
}
/** Decode the exact copied buffer regions. Early commands use the preserved early counter:
 * late finalize overwrites the first indirect region with the final union. */
export function decodeGeometryCommands(input: {
  readonly bytes: DataView;
  readonly commands: readonly GeometryCommandCapture[];
  readonly indirectBytes: number;
  readonly visibleBytes: number;
  readonly countersOffset: number;
  readonly earlyCountOffsets: ReadonlyMap<string, number>;
  readonly firstInstanceIndirect: boolean;
}): readonly GeometryCommandObservation[] {
  if (input.commands.length > GEOMETRY_OBSERVATION_MAX_COMMANDS) throw Error('command-budget');
  let memberCount = 0;
  return input.commands.map((command) => {
    const p = command.indirectOffset;
    if (!Number.isSafeInteger(p) || p < 0 || p + 20 > input.indirectBytes)
      throw Error('indirect-range');
    const count = input.bytes.getUint32(p, true),
      union = input.bytes.getUint32(p + 4, true);
    const first = input.bytes.getUint32(p + 8, true);
    const baseVertex = command.kind === 'indexed' ? input.bytes.getInt32(p + 12, true) : 0;
    const firstInstance = input.bytes.getUint32(p + (command.kind === 'indexed' ? 16 : 12), true);
    // Raster either binds the whole visible buffer and uses the GPU offset, or
    // binds this segment and requires zero. Never attribute another segment's draw.
    if (firstInstance !== (input.firstInstanceIndirect ? command.visibleBase : 0))
      throw Error('first-instance-mismatch');
    const earlyOffset = input.earlyCountOffsets.get(`${command.batchId}:${command.level}`);
    if (command.phase === 'early' && earlyOffset === undefined)
      throw Error('early-counter-unavailable');
    const instanceCount =
      command.phase === 'early'
        ? input.bytes.getUint32(input.countersOffset + (earlyOffset ?? 0), true)
        : union;
    if (instanceCount > union) throw Error('early-counter-mismatch');
    const members: GeometrySourceIdentity[] = [];
    // Zero-count commands invoke no vertices even if their instance list is nonempty.
    if (count > 0)
      for (let i = 0; i < instanceCount; i++) {
        if (++memberCount > GEOMETRY_OBSERVATION_MAX_MEMBERS) throw Error('member-budget');
        const offset = (command.visibleBase + i) * 16;
        if (offset < 0 || offset + 16 > input.visibleBytes) throw Error('visible-range');
        const row = input.bytes.getUint32(input.indirectBytes + offset, true);
        const source = command.sources.get(row);
        if (source === undefined) throw Error('source-unavailable');
        members.push(source);
      }
    const indexOrVertexWork = count * instanceCount;
    if (!Number.isSafeInteger(indexOrVertexWork)) throw Error('work-overflow');
    return {
      pass: command.pass,
      phase: command.phase,
      level: command.level,
      batchId: command.batchId,
      indirectOffset: p,
      kind: command.kind,
      topology: command.topology,
      count,
      instanceCount,
      first,
      baseVertex,
      firstInstance,
      indexOrVertexWork,
      members,
    };
  });
}
