import type { RhiCallEvent, Tape } from '../protocol/types';

const BUFFER_MAP_READ = 0x1;
const BUFFER_MAP_WRITE = 0x2;
const BUFFER_STORAGE = 0x80;
const BUFFER_QUERY_RESOLVE = 0x200;
const TEXTURE_STORAGE_BINDING = 0x8;
const TEXTURE_RENDER_ATTACHMENT = 0x10;

const IMMUTABLE_CREATE_KINDS = new Set<RhiCallEvent['kind']>([
  'createShaderModule',
  'createRenderPipeline',
  'createComputePipeline',
  'createBindGroupLayout',
  'createPipelineLayout',
  'getBindGroupLayout',
  'createSampler',
]);

const MUTATING_KINDS = new Set<RhiCallEvent['kind']>([
  'writeBuffer',
  'writeTexture',
  'copyExternalImageToTexture',
  'copyBufferToBuffer',
  'copyBufferToTexture',
  'copyTextureToBuffer',
  'copyTextureToTexture',
  'clearBuffer',
  'resolveQuerySet',
  'destroyBuffer',
  'destroyTexture',
  'destroyQuerySet',
]);

/**
 * Replay objects whose content no recorded event can change. They survive
 * replay resets, so repeated reads skip re-uploading immutable bootstrap
 * bytes and recompiling shaders and pipelines. The analysis is conservative:
 * any handle named by a copy, upload, clear, resolve or destroy event, and any
 * resource whose usage permits GPU writes or mapping, is replayed fresh.
 */
export function retainedReplayHandles(tape: Tape): ReadonlySet<string> {
  const touched = new Set<string>();
  for (const event of tape.events) {
    if (MUTATING_KINDS.has(event.kind)) collectStrings(event, touched);
  }
  const retained = new Set<string>();
  const textures = new Set<string>();
  for (const resource of tape.bootstrap) {
    if (touched.has(resource.handleId)) continue;
    const desc = (resource.create as { desc?: { usage?: number; format?: string } }).desc;
    const usage = desc?.usage ?? 0;
    if (resource.kind === 'buffer') {
      if (usage & (BUFFER_MAP_READ | BUFFER_MAP_WRITE | BUFFER_STORAGE | BUFFER_QUERY_RESOLVE))
        continue;
      retained.add(resource.handleId);
    } else if (resource.kind === 'texture') {
      if (usage & (TEXTURE_STORAGE_BINDING | TEXTURE_RENDER_ATTACHMENT)) continue;
      if (desc?.format?.startsWith('depth') || desc?.format?.startsWith('stencil')) continue;
      retained.add(resource.handleId);
      textures.add(resource.handleId);
    } else if (IMMUTABLE_CREATE_KINDS.has(resource.create.kind as RhiCallEvent['kind'])) {
      retained.add(resource.handleId);
    }
  }
  for (const resource of tape.bootstrap) {
    if (resource.kind !== 'texture-view') continue;
    const source = (resource.create as { sourceHandleId?: unknown }).sourceHandleId;
    if (typeof source === 'string' && textures.has(source)) retained.add(resource.handleId);
  }
  for (const event of tape.events) {
    if (!IMMUTABLE_CREATE_KINDS.has(event.kind)) continue;
    const handleId = (event as { handleId?: unknown }).handleId;
    if (typeof handleId === 'string') retained.add(handleId);
  }
  // A bind group is immutable once its layout and every bound resource are retained.
  const bindGroups = [
    ...tape.bootstrap.map((resource) => resource.create as unknown as RhiCallEvent),
    ...tape.events,
  ];
  for (const event of bindGroups) {
    if (event.kind !== 'createBindGroup' || touched.has(event.handleId)) continue;
    if (!retained.has(event.layoutHandleId)) continue;
    if (event.resourceHandleIds.every((id) => id !== undefined && retained.has(id)))
      retained.add(event.handleId);
  }
  return retained;
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}
