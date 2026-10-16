import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import {
  DEPTH_MIN_PARAMS_BYTE_SIZE,
  entryHasDepthRead,
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
} from '../fullscreen-post-process-pass';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { PostProcessError } from '../post-process-errors';
import type { RenderSystemInternals } from '../record/render-context';
import type { RecoveryPostProcessResources } from '../recovery/types';

interface PostProcessParamsCandidate {
  readonly buffers: ReadonlyMap<string, Buffer>;
  readonly created: readonly Buffer[];
}

/** Own post-process declarations and their device-bound parameter buffer lifecycle. */
export function createPostProcessParamsOwner(
  internals: Pick<RenderSystemInternals, 'device' | 'errorRegistry'>,
  invalidate: (id: string, moduleLabel: string) => void,
) {
  // CPU post-process declarations are owned by the feature host and remain live
  // across recovery. Only device-bound buffers and pipelines are rebuilt here.
  // D-3 / D-8: per-shader params UBO resource table (id -> GPU Buffer).
  // Eager-created at register time when entry.params is present (byteSize >= 16,
  // defaultValue.length === byteSize); reused frame-to-frame via queue.writeBuffer.
  let postProcessParamsBuffers = new Map<string, Buffer>();
  let postProcessParamsDevice = internals.device;
  const builtinPostProcessEntries = new Map<string, PostProcessShaderEntry>();
  let activeFeaturePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry> = new Map();
  const lookupPostProcess = (id: string): PostProcessShaderEntry | undefined =>
    builtinPostProcessEntries.get(id) ?? activeFeaturePostProcessEntries.get(id);
  // feat-20260621 M-A2 / w8: expose the eager-created per-id params UBO through
  // the narrow runtime surface so dispatchFullscreenPass can writeBuffer the
  // per-frame snapshot + bind it at group(1) binding(2).
  const getPostProcessParamsBuffer = (id: string): Buffer | undefined =>
    postProcessParamsBuffers.get(id);
  const postProcessDeclarations = (): readonly (readonly [string, PostProcessShaderEntry])[] => [
    ...builtinPostProcessEntries.entries(),
    ...activeFeaturePostProcessEntries.entries(),
  ];
  const disposePostProcessResources = (resources: RecoveryPostProcessResources): void => {
    for (const buffer of resources.paramsBuffers.values()) {
      const destroyed = resources.device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  const prepareRecoveryPostProcessResources = (
    device: RhiDevice,
  ): Result<RecoveryPostProcessResources, RhiError> => {
    const paramsBuffers = new Map<string, Buffer>();
    try {
      for (const [id, entry] of postProcessDeclarations()) {
        if (id === 'forgeax.taa-resolve') continue;
        let buffer: Buffer | undefined;
        if (entry.params !== undefined) {
          const created = device.createBuffer({
            label: `post-process-params-${id}`,
            size: entry.params.byteSize,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) throw created.error;
          buffer = created.value;
          paramsBuffers.set(id, buffer);
          const written = device.queue.writeBuffer(buffer, 0, entry.params.defaultValue);
          if (!written.ok) throw written.error;
        } else if (entryHasDepthRead(entry)) {
          const created = device.createBuffer({
            label: `post-process-params-${id}`,
            size: DEPTH_MIN_PARAMS_BYTE_SIZE,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) throw created.error;
          buffer = created.value;
        }
        if (buffer !== undefined) paramsBuffers.set(id, buffer);
      }
    } catch (cause) {
      disposePostProcessResources({ device, paramsBuffers });
      if (cause instanceof RhiError) return err(cause);
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'post-process recovery resources are created on the candidate device',
          hint: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
    return ok({ device, paramsBuffers });
  };
  const publishRecoveryPostProcessResources = (candidate: RecoveryPostProcessResources): void => {
    if (candidate.paramsBuffers === postProcessParamsBuffers) return;
    const previous = { device: postProcessParamsDevice, paramsBuffers: postProcessParamsBuffers };
    postProcessParamsDevice = candidate.device;
    postProcessParamsBuffers = candidate.paramsBuffers;
    disposePostProcessResources(previous);
  };
  const discardRecoveryPostProcessResources = (candidate: RecoveryPostProcessResources): void => {
    if (candidate.paramsBuffers === postProcessParamsBuffers) {
      postProcessParamsBuffers = new Map();
      disposePostProcessResources(candidate);
      return;
    }
    disposePostProcessResources(candidate);
  };
  const postProcessParamsByteSize = (entry: PostProcessShaderEntry): number =>
    entry.params?.byteSize ?? (entryHasDepthRead(entry) ? DEPTH_MIN_PARAMS_BYTE_SIZE : 0);
  const destroyPostProcessParams = (buffers: readonly Buffer[]): void => {
    for (const buffer of buffers) {
      const destroyed = internals.device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  const disposeActivePostProcessResources = (): void => {
    const resources = { device: postProcessParamsDevice, paramsBuffers: postProcessParamsBuffers };
    postProcessParamsBuffers = new Map();
    disposePostProcessResources(resources);
  };
  const preparePostProcessParamsResources = (
    featureEntries: ReadonlyMap<string, PostProcessShaderEntry>,
  ): Result<PostProcessParamsCandidate, RhiError> => {
    const declarations = new Map<string, PostProcessShaderEntry>([
      ...builtinPostProcessEntries.entries(),
      ...featureEntries.entries(),
    ]);
    const next = new Map<string, Buffer>();
    const allocated: Buffer[] = [];
    const discardCreated = (): void => destroyPostProcessParams(allocated);
    for (const [id, entry] of declarations) {
      if (id === 'forgeax.taa-resolve') continue;
      const byteSize = postProcessParamsByteSize(entry);
      if (byteSize === 0) continue;
      const existing = postProcessParamsBuffers.get(id);
      const accepted = lookupPostProcess(id);
      if (
        existing !== undefined &&
        accepted !== undefined &&
        postProcessShaderEntrySignature(accepted) === postProcessShaderEntrySignature(entry)
      ) {
        next.set(id, existing);
        continue;
      }
      const created = internals.device.createBuffer({
        label: `post-process-params-${id}`,
        size: byteSize,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      });
      if (!created.ok) {
        discardCreated();
        return err(created.error);
      }
      const buffer = created.value;
      allocated.push(buffer);
      if (entry.params !== undefined) {
        const written = internals.device.queue.writeBuffer(buffer, 0, entry.params.defaultValue);
        if (!written.ok) {
          discardCreated();
          return err(written.error);
        }
      }
      next.set(id, buffer);
    }
    return ok({ buffers: next, created: Object.freeze([...allocated]) });
  };
  const discardPostProcessParamsCandidate = (candidate: PostProcessParamsCandidate): void => {
    destroyPostProcessParams(candidate.created);
  };
  const retirePostProcessParams = (buffers: readonly Buffer[]): void => {
    if (buffers.length === 0) return;
    const release = (): void => destroyPostProcessParams(buffers);
    try {
      void internals.device.queue.onSubmittedWorkDone().then(release, release);
    } catch {
      release();
    }
  };
  const acceptPostProcessParamsCandidate = (candidate: PostProcessParamsCandidate): void => {
    const previous = [...postProcessParamsBuffers.values()];
    const next = new Set(candidate.buffers.values());
    postProcessParamsBuffers.clear();
    for (const [id, buffer] of candidate.buffers) {
      postProcessParamsBuffers.set(id, buffer);
    }
    retirePostProcessParams(previous.filter((buffer) => !next.has(buffer)));
  };
  return {
    get builtinEntries(): ReadonlyMap<string, PostProcessShaderEntry> {
      return builtinPostProcessEntries;
    },
    get featureEntries(): ReadonlyMap<string, PostProcessShaderEntry> {
      return activeFeaturePostProcessEntries;
    },
    set featureEntries(entries: ReadonlyMap<string, PostProcessShaderEntry>) {
      activeFeaturePostProcessEntries = entries;
    },
    lookup: lookupPostProcess,
    getBuffer: getPostProcessParamsBuffer,
    prepare: preparePostProcessParamsResources,
    accept: acceptPostProcessParamsCandidate,
    discard: discardPostProcessParamsCandidate,
    dispose: disposeActivePostProcessResources,
    prepareRecovery: prepareRecoveryPostProcessResources,
    publishRecovery: publishRecoveryPostProcessResources,
    discardRecovery: discardRecoveryPostProcessResources,
    registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void {
      // D-3: eager-create params UBO at register time + fail-fast
      // byteSize / defaultValue validation (q5=A).
      let paramsBuffer: Buffer | undefined;
      try {
        if (id !== 'forgeax.taa-resolve' && entry.params !== undefined) {
          const { byteSize, defaultValue } = entry.params;
          if (byteSize < 16 || defaultValue.length !== byteSize) {
            throw new PostProcessError({
              code: 'params-size-mismatch',
              detail: { byteSize, actualLength: defaultValue.length },
            });
          }
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: byteSize,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          paramsBuffer = paramsBufferResult.value;
          const writeResult = internals.device.queue.writeBuffer(paramsBuffer, 0, defaultValue);
          if (!writeResult.ok) throw writeResult.error;
        } else if (id !== 'forgeax.taa-resolve' && entryHasDepthRead(entry)) {
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: DEPTH_MIN_PARAMS_BYTE_SIZE,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          paramsBuffer = paramsBufferResult.value;
        }
        if (builtinPostProcessEntries.has(id)) {
          throw new PostProcessError({
            code: 'post-process-already-registered',
            detail: { id },
          });
        }
        builtinPostProcessEntries.set(id, entry);
        if (paramsBuffer !== undefined) postProcessParamsBuffers.set(id, paramsBuffer);
        const moduleLabel = postProcessShaderModuleLabel(entry.source);
        return () => {
          if (builtinPostProcessEntries.get(id) === entry) {
            builtinPostProcessEntries.delete(id);
          }
          const current = postProcessParamsBuffers.get(id);
          if (current !== undefined) {
            internals.device.destroyBuffer(current);
            postProcessParamsBuffers.delete(id);
          }
          invalidate(id, moduleLabel);
        };
      } catch (cause) {
        if (paramsBuffer !== undefined) internals.device.destroyBuffer(paramsBuffer);
        throw cause;
      }
    },
  };
}
