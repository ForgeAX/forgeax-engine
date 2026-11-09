import type { Buffer, RhiCommandEncoder, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { BootstrapResource, RhiCallEvent, Tape } from '../protocol/types';
import { projectTextureExtent, textureBlockLayout } from '../texel-layout';
import type { ResourceTable } from './resources';

const BUFFER_MAP_READ = 0x1;
const BUFFER_MAP_WRITE = 0x2;
const BUFFER_COPY_SRC = 0x4;
const BUFFER_COPY_DST = 0x8;
const TEXTURE_COPY_SRC = 0x1;
const TEXTURE_COPY_DST = 0x2;

const DESTROY_KINDS = new Set<RhiCallEvent['kind']>([
  'destroyBuffer',
  'destroyTexture',
  'destroyQuerySet',
]);

interface TextureCopy {
  readonly mipLevel: number;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
}

interface RestoredBuffer {
  readonly handleId: string;
  readonly size: number;
  readonly pristine: Buffer;
}

interface RestoredTexture {
  readonly handleId: string;
  readonly bytes: number;
  readonly copies: readonly TextureCopy[];
  readonly pristine: Texture;
}

/** What steady replay restores between replays, for the benchmark report. */
export interface SteadyRestoreSummary {
  readonly buffers: number;
  readonly textures: number;
  /** Bytes copied on the GPU before each replay. */
  readonly bytes: number;
  /** Mutable resources steady replay cannot restore (multisampled or mappable for reading). */
  readonly unrestored: readonly string[];
}

/** @internal Pristine capture-start copies of every mutable bootstrap resource. */
export interface SteadySnapshot {
  readonly buffers: readonly RestoredBuffer[];
  readonly textures: readonly RestoredTexture[];
  readonly summary: SteadyRestoreSummary;
}

type TextureDesc = {
  readonly size?: unknown;
  readonly format?: string;
  readonly usage?: number;
  readonly mipLevelCount?: number;
  readonly sampleCount?: number;
  readonly dimension?: string;
};

type BufferDesc = { readonly size?: number; readonly usage?: number };

/**
 * Why a tape cannot keep its resources across replays, or undefined when it
 * can. Destroyed bootstrap objects, mappable upload buffers and acceleration
 * structures would need re-creation, so those tapes reload every replay.
 */
export function steadyBlocker(tape: Tape, retained: ReadonlySet<string>): string | undefined {
  const bootstrap = new Set(tape.bootstrap.map((resource) => resource.handleId));
  for (const event of tape.events) {
    if (!DESTROY_KINDS.has(event.kind)) continue;
    const handleId = (event as { handleId?: unknown }).handleId;
    if (typeof handleId === 'string' && bootstrap.has(handleId))
      return `event ${event.kind} destroys bootstrap resource ${handleId}`;
  }
  for (const resource of tape.bootstrap) {
    if (retained.has(resource.handleId)) continue;
    if (resource.kind === 'acceleration-structure')
      return `bootstrap acceleration structure ${resource.handleId} is rebuilt per replay`;
    const usage = (resource.create as { desc?: BufferDesc }).desc?.usage ?? 0;
    if (resource.kind === 'buffer' && usage & BUFFER_MAP_WRITE)
      return `bootstrap buffer ${resource.handleId} is mappable for writing`;
  }
  return undefined;
}

/** Every bootstrap handle plus the immutable `retained` set; steady replay keeps all of them. */
export function steadyRetainedHandles(tape: Tape, retained: ReadonlySet<string>): Set<string> {
  const kept = new Set(retained);
  for (const resource of tape.bootstrap) kept.add(resource.handleId);
  return kept;
}

/**
 * Add the copy usages steady replay needs to snapshot and restore a mutable
 * bootstrap buffer or texture. Mappable buffers and multisampled textures
 * cannot carry them and keep their recorded usage.
 */
export function withSteadyCopyUsage(event: RhiCallEvent): RhiCallEvent {
  if (event.kind === 'createBuffer') {
    const usage = event.desc.usage;
    if (usage & (BUFFER_MAP_READ | BUFFER_MAP_WRITE)) return event;
    return { ...event, desc: { ...event.desc, usage: usage | BUFFER_COPY_SRC | BUFFER_COPY_DST } };
  }
  if (event.kind === 'createTexture') {
    if ((event.desc.sampleCount ?? 1) > 1) return event;
    const usage = event.desc.usage;
    return {
      ...event,
      desc: { ...event.desc, usage: usage | TEXTURE_COPY_SRC | TEXTURE_COPY_DST },
    };
  }
  return event;
}

/**
 * Copy the freshly seeded mutable bootstrap resources into pristine twins on
 * the GPU. Call right after a full prepare, before any recorded event runs.
 */
export function snapshotSteadyState(
  device: RhiDevice,
  table: ResourceTable,
  tape: Tape,
  retained: ReadonlySet<string>,
): Result<SteadySnapshot, RhiDebugError> {
  const buffers: RestoredBuffer[] = [];
  const textures: RestoredTexture[] = [];
  const unrestored: string[] = [];
  const snapshot = (): SteadySnapshot => ({
    buffers,
    textures,
    summary: summarize(buffers, textures, unrestored),
  });
  const encoder = device.createCommandEncoder({ label: 'rhi-debug:steady-snapshot' });
  if (!encoder.ok) return steadyFailure(`snapshot encoder: ${encoder.error.code}`);
  for (const resource of tape.bootstrap) {
    if (retained.has(resource.handleId)) continue;
    const added = snapshotResource(device, table, encoder.value, resource, {
      buffers,
      textures,
      unrestored,
    });
    if (!added.ok) {
      destroySteadySnapshot(device, snapshot());
      return added;
    }
  }
  const submitted = submit(device, encoder.value, 'snapshot');
  if (!submitted.ok) {
    destroySteadySnapshot(device, snapshot());
    return submitted;
  }
  return ok(snapshot());
}

/** Encode and submit GPU copies that put every mutable resource back to its capture-start bytes. */
export function restoreSteadyState(
  device: RhiDevice,
  table: ResourceTable,
  snapshot: SteadySnapshot,
): Result<void, RhiDebugError> {
  if (snapshot.buffers.length === 0 && snapshot.textures.length === 0) return ok(undefined);
  const encoder = device.createCommandEncoder({ label: 'rhi-debug:steady-restore' });
  if (!encoder.ok) return steadyFailure(`restore encoder: ${encoder.error.code}`);
  for (const restored of snapshot.buffers) {
    const live = table.get(restored.handleId)?.resource;
    if (live?.kind !== 'buffer') return steadyFailure(`buffer ${restored.handleId} was released`);
    encoder.value.copyBufferToBuffer(restored.pristine, 0, live.value, 0, restored.size);
  }
  for (const restored of snapshot.textures) {
    const live = table.get(restored.handleId)?.resource;
    if (live?.kind !== 'texture') return steadyFailure(`texture ${restored.handleId} was released`);
    copyTexture(encoder.value, restored.pristine, live.value, restored.copies);
  }
  return submit(device, encoder.value, 'restore');
}

export function destroySteadySnapshot(device: RhiDevice, snapshot: SteadySnapshot): void {
  for (const restored of snapshot.buffers) device.destroyBuffer(restored.pristine);
  for (const restored of snapshot.textures) device.destroyTexture(restored.pristine);
}

interface SnapshotSink {
  readonly buffers: RestoredBuffer[];
  readonly textures: RestoredTexture[];
  readonly unrestored: string[];
}

function snapshotResource(
  device: RhiDevice,
  table: ResourceTable,
  encoder: RhiCommandEncoder,
  resource: BootstrapResource,
  sink: SnapshotSink,
): Result<void, RhiDebugError> {
  const live = table.get(resource.handleId)?.resource;
  if (resource.kind === 'buffer' && live?.kind === 'buffer') {
    const desc = (resource.create as { desc?: BufferDesc }).desc ?? {};
    // A MAP_READ buffer can only be a copy destination; no GPU work reads it.
    if ((desc.usage ?? 0) & BUFFER_MAP_READ) return ok(undefined);
    const size = desc.size ?? 0;
    if (size === 0) return ok(undefined);
    const pristine = device.createBuffer({ size, usage: BUFFER_COPY_SRC | BUFFER_COPY_DST });
    if (!pristine.ok)
      return steadyFailure(`pristine buffer ${resource.handleId}: ${pristine.error.code}`);
    encoder.copyBufferToBuffer(live.value, 0, pristine.value, 0, size);
    sink.buffers.push({ handleId: resource.handleId, size, pristine: pristine.value });
    return ok(undefined);
  }
  if (resource.kind === 'texture' && live?.kind === 'texture') {
    const desc = (resource.create as { desc?: TextureDesc }).desc ?? {};
    const copies = textureCopies(desc);
    if ((desc.sampleCount ?? 1) > 1 || copies === undefined) {
      sink.unrestored.push(resource.handleId);
      return ok(undefined);
    }
    const pristine = device.createTexture({
      ...desc,
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST,
      viewFormats: [],
    } as never);
    if (!pristine.ok)
      return steadyFailure(`pristine texture ${resource.handleId}: ${pristine.error.code}`);
    copyTexture(encoder, live.value, pristine.value, copies);
    sink.textures.push({
      handleId: resource.handleId,
      bytes: textureBytes(desc, copies),
      copies,
      pristine: pristine.value,
    });
  }
  return ok(undefined);
}

/** Whole-subresource copies of every mip, all layers at once; undefined for unknown formats. */
export function textureCopies(desc: TextureDesc): TextureCopy[] | undefined {
  const extent = projectTextureExtent(desc.size);
  const block = textureBlockLayout(desc.format as GPUTextureFormat | undefined);
  if (extent === undefined || block === undefined) return undefined;
  const is3d = desc.dimension === '3d';
  const copies: TextureCopy[] = [];
  for (let mip = 0; mip < Math.max(1, desc.mipLevelCount ?? 1); mip++) {
    const width = Math.max(1, extent.width >> mip);
    const height = Math.max(1, extent.height >> mip);
    copies.push({
      mipLevel: mip,
      width: Math.ceil(width / block.blockWidth) * block.blockWidth,
      height: Math.ceil(height / block.blockHeight) * block.blockHeight,
      depthOrArrayLayers: is3d ? Math.max(1, extent.layerCount >> mip) : extent.layerCount,
    });
  }
  return copies;
}

function textureBytes(desc: TextureDesc, copies: readonly TextureCopy[]): number {
  const block = textureBlockLayout(desc.format as GPUTextureFormat | undefined);
  if (block === undefined) return 0;
  let bytes = 0;
  for (const copy of copies)
    bytes +=
      (copy.width / block.blockWidth) *
      (copy.height / block.blockHeight) *
      block.bytesPerBlock *
      copy.depthOrArrayLayers;
  return bytes;
}

function copyTexture(
  encoder: RhiCommandEncoder,
  source: Texture,
  destination: Texture,
  copies: readonly TextureCopy[],
): void {
  for (const copy of copies)
    encoder.copyTextureToTexture(
      { texture: source, mipLevel: copy.mipLevel, origin: { x: 0, y: 0, z: 0 } } as never,
      { texture: destination, mipLevel: copy.mipLevel, origin: { x: 0, y: 0, z: 0 } } as never,
      { width: copy.width, height: copy.height, depthOrArrayLayers: copy.depthOrArrayLayers },
    );
}

function submit(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  stage: string,
): Result<void, RhiDebugError> {
  const finished = encoder.finish();
  if (!finished.ok) return steadyFailure(`${stage} finish: ${finished.error.code}`);
  const submitted = device.queue.submit([finished.value]);
  return submitted.ok ? ok(undefined) : steadyFailure(`${stage} submit: ${submitted.error.code}`);
}

function summarize(
  buffers: readonly RestoredBuffer[],
  textures: readonly RestoredTexture[],
  unrestored: readonly string[],
): SteadyRestoreSummary {
  let bytes = 0;
  for (const restored of buffers) bytes += restored.size;
  for (const restored of textures) bytes += restored.bytes;
  return { buffers: buffers.length, textures: textures.length, bytes, unrestored };
}

function steadyFailure(cause: string): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('replay-event-failed', {
      eventIndex: -1,
      kind: 'steady-restore',
      stage: 'submit',
      cause,
    }),
  );
}
