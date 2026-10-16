import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { concatParts, digestParts, encodeTapeParts, sliceParts } from '../protocol/codec';
import { EVENT_SEMANTICS, resourceKindForEvent } from '../protocol/event-semantics';
import type { BootstrapResource, Tape as V7Tape } from '../protocol/types';
import type { DebugRhiInstance } from '../recorder';
import type { HandleId, Tape as LegacyTape, RhiCallEvent } from '../types';

/**
 * A streamable `.rhitape` container. Buffers are borrowed, never copied:
 * `chunks()` yields bounded windows; `bytes` and `digest` are computed on
 * first access and cached.
 */
export interface TapeArtifact {
  readonly byteLength: number;
  /** SHA-256 of the whole container (`sha256:<hex>`), the artifact identity. */
  readonly digest: string;
  /** Contiguous container. Materializing costs one container-sized copy. */
  readonly bytes: Uint8Array;
  /** Ordered container windows of at most `chunkBytes`; views where possible. */
  chunks(chunkBytes: number): Iterable<{ readonly offset: number; readonly bytes: Uint8Array }>;
}

/** One captured container together with its decoded tape. */
export interface EncodedTape extends TapeArtifact {
  readonly tape: V7Tape;
}

/** Wrap container parts (or one contiguous container) without copying them. */
export function tapeArtifact(
  parts: readonly Uint8Array[],
  byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0),
): TapeArtifact {
  let digest: string | undefined;
  let bytes: Uint8Array | undefined = parts.length === 1 ? parts[0] : undefined;
  return {
    byteLength,
    get digest() {
      digest ??= digestParts(parts);
      return digest;
    },
    get bytes() {
      bytes ??= concatParts(parts, byteLength);
      return bytes;
    },
    chunks: (chunkBytes) => sliceParts(parts, chunkBytes),
  };
}

export function assembleTape(recorder: DebugRhiInstance): Result<EncodedTape, RhiDebugError> {
  const legacy = recorder.getTape();
  if (legacy === undefined) {
    return err(
      createRhiDebugError('capture-snapshot-failed', {
        stage: 'snapshot',
        cause: 'the recorder finalized without a frame event',
      }),
    );
  }
  if ('code' in legacy) {
    return err(legacy);
  }
  const tape = toV7Tape(
    legacy,
    hoistableCreates(legacy.events, recorder.bootstrapEvents()),
    recorder.omittedSeeds(),
  );
  const encoded = encodeTapeParts(tape, { contentHashes: true });
  if (!encoded.ok) return err(encoded.error);
  const artifact = tapeArtifact(encoded.value.parts, encoded.value.byteLength);
  return ok({
    tape,
    byteLength: artifact.byteLength,
    get digest() {
      return artifact.digest;
    },
    get bytes() {
      return artifact.bytes;
    },
    chunks: (chunkBytes) => artifact.chunks(chunkBytes),
  });
}

/**
 * Bootstrap resources are created before any frame command replays, so a bind
 * group that binds a TLAS after an in-frame build stays in the frame stream:
 * hoisted, it would bind the acceleration structure before that build.
 */
function hoistableCreates(
  events: readonly RhiCallEvent[],
  bootstrapEvents: readonly RhiCallEvent[],
): Set<RhiCallEvent> {
  // Only prefix creations can move into bootstrap. Later-frame resources
  // must keep their create event at its original position in the stream.
  const prefix = new Set<RhiCallEvent>();
  for (const event of events) {
    if (event.kind === 'frameMark') break;
    prefix.add(event);
  }
  const hoistable = new Set(bootstrapEvents.filter((event) => prefix.has(event)));
  let built = false;
  for (const event of events) {
    if (event.kind === 'buildAccelerationStructures') built = true;
    if (
      built &&
      event.kind === 'createBindGroup' &&
      event.entries.some((entry) => entry.resourceKind === 'accelerationStructure')
    )
      hoistable.delete(event);
  }
  return hoistable;
}

function toV7Tape(
  legacy: LegacyTape,
  bootstrapEvents: ReadonlySet<RhiCallEvent>,
  omittedSeeds: ReadonlySet<HandleId>,
): V7Tape {
  const firstFrame = legacy.events.findIndex((event) => event.kind === 'frameMark');
  const boundary = firstFrame < 0 ? legacy.events.length : firstFrame;
  const bootstrap: BootstrapResource[] = [];
  const bootstrapIds = new Set<HandleId>();
  const initialData = new Map<HandleId, string[]>();
  for (const event of legacy.events.slice(0, boundary)) {
    if (event.kind === 'initialData') {
      const hashes = initialData.get(event.handleId) ?? [];
      hashes.push(event.dataHash);
      initialData.set(event.handleId, hashes);
      continue;
    }
    if (!bootstrapEvents.has(event)) continue;
    const kind = resourceKindForEvent(event.kind);
    const [handleId] = EVENT_SEMANTICS[event.kind].created(event);
    if (handleId === undefined || kind === undefined || bootstrapIds.has(handleId)) continue;
    bootstrapIds.add(handleId);
    bootstrap.push({
      handleId,
      kind,
      create: toJsonRecord(event),
      initialData: [],
    });
  }
  const allBlobs = Array.from(legacy.blobPool, ([hash, data]) => ({
    hash,
    bytes: new Uint8Array(data),
    compression: 'none' as const,
  }));
  const referenced = collectReferencedHandleIds(legacy.events, bootstrapEvents);
  const closure = collectBootstrapClosure(referenced, bootstrap);
  const keptBootstrap = bootstrap
    .filter((resource) => closure.has(resource.handleId))
    .map((resource) => {
      const hashes = initialData.get(resource.handleId) ?? [];
      const slices = hashes.flatMap((hash) => {
        const blob = legacy.blobPool.get(hash);
        return blob === undefined ? [] : [{ hash, byteOffset: 0, byteLength: blob.byteLength }];
      });
      return omittedSeeds.has(resource.handleId)
        ? { ...resource, initialData: slices, seed: 'omitted' as const }
        : { ...resource, initialData: slices };
    });
  const events = legacy.events
    .filter((event) => event.kind !== 'initialData' && !bootstrapEvents.has(event))
    .map(toJsonSafe);
  const keptHashes = new Set(
    keptBootstrap.flatMap((resource) => resource.initialData.map((slice) => slice.hash)),
  );
  for (const event of events) {
    if ('dataHash' in event && typeof event.dataHash === 'string') keptHashes.add(event.dataHash);
  }
  const blobs = allBlobs.filter((blob) => keptHashes.has(blob.hash));
  return {
    header: {
      formatVersion: 7,
      rhiCaps: { ...legacy.rhiCapsRecorded },
      eventCount: events.length,
      blobCount: blobs.length,
    },
    bootstrap: keptBootstrap,
    events,
    blobs,
  };
}

function collectReferencedHandleIds(
  events: readonly RhiCallEvent[],
  bootstrapEvents: ReadonlySet<RhiCallEvent>,
): Set<HandleId> {
  const ids = new Set<HandleId>();
  for (const event of events) {
    if (event.kind === 'initialData' || bootstrapEvents.has(event)) continue;
    collectHandleStrings(event, ids);
  }
  return ids;
}

function collectHandleStrings(value: unknown, ids: Set<HandleId>): void {
  if (typeof value === 'string' && /^[a-zA-Z][a-zA-Z-]*:\S+$/.test(value)) {
    ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHandleStrings(entry, ids);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectHandleStrings(entry, ids);
  }
}

function collectBootstrapClosure(
  referenced: ReadonlySet<HandleId>,
  resources: readonly BootstrapResource[],
): Set<HandleId> {
  const byId = new Map(resources.map((resource) => [resource.handleId, resource]));
  const closure = new Set<HandleId>();
  const pending = [...referenced];
  while (pending.length > 0) {
    const handleId = pending.pop();
    if (handleId === undefined || closure.has(handleId)) continue;
    const resource = byId.get(handleId);
    if (resource === undefined) continue;
    closure.add(handleId);
    const dependencies = new Set<HandleId>();
    collectHandleStrings(resource.create, dependencies);
    pending.push(...dependencies);
  }
  return closure;
}

function toJsonSafe(event: RhiCallEvent): RhiCallEvent {
  return JSON.parse(JSON.stringify(event)) as RhiCallEvent;
}

function toJsonRecord(event: RhiCallEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event));
}
