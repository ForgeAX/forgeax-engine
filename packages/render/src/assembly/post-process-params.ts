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
import {
  isDeferredPostProcessEntry,
  preparedPostProcessSource,
} from './deferred-post-process-entry';

interface PostProcessParamsCandidate {
  readonly buffers: Map<string, Buffer>;
  readonly created: Buffer[];
}

/** Own post-process declarations and their device-bound parameter buffer lifecycle. */
export function createPostProcessParamsOwner(
  internals: Pick<RenderSystemInternals, 'device' | 'errorRegistry'>,
  invalidate: (id: string, moduleLabel: string | undefined) => void,
  afterSubmission?: (device: RhiDevice, release: () => void) => void,
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
  // Queue writes issued before a submit are visible to every command in that
  // submit. Each overlapping draw needs its own physical uniform contents.
  const writtenIn = new WeakMap<Buffer, number>();
  const repeated = new Map<Buffer, { slots: Buffer[]; used: number }>();
  let sequence = 0;
  let recording = false;
  const getPostProcessParamsBuffer = (id: string, access?: 'write'): Buffer | undefined => {
    const base = postProcessParamsBuffers.get(id);
    if (base === undefined || access !== 'write' || !recording) return base;
    if (writtenIn.get(base) !== sequence) {
      writtenIn.set(base, sequence);
      return base;
    }
    let row = repeated.get(base);
    if (row === undefined) {
      row = { slots: [], used: 0 };
      repeated.set(base, row);
    }
    let buffer = row.slots[row.used];
    if (buffer === undefined) {
      const params = lookupPostProcess(id)?.params;
      if (params === undefined) return base;
      buffer = postProcessParamsDevice
        .createBuffer({
          label: `post-process-params-${id}-draw-${row.used + 2}`,
          size: params.byteSize,
          usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap();
      row.slots.push(buffer);
    }
    row.used++;
    return buffer;
  };
  const finishRecording = (): void => {
    if (!recording) return;
    recording = false;
    if (repeated.size === 0) return;
    for (const [base, row] of repeated) {
      if (row.used < row.slots.length) retirePostProcessParams(row.slots.splice(row.used));
      if (row.used === 0) repeated.delete(base);
      row.used = 0;
    }
  };
  const releaseRepeated = (): void => {
    for (const row of repeated.values()) retirePostProcessParams(row.slots);
    repeated.clear();
    recording = false;
  };
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
    releaseRepeated();
    const previous = { device: postProcessParamsDevice, paramsBuffers: postProcessParamsBuffers };
    postProcessParamsDevice = candidate.device;
    postProcessParamsBuffers = candidate.paramsBuffers;
    disposePostProcessResources(previous);
  };
  const discardRecoveryPostProcessResources = (candidate: RecoveryPostProcessResources): void => {
    if (candidate.paramsBuffers === postProcessParamsBuffers) {
      releaseRepeated();
      postProcessParamsBuffers = new Map();
      disposePostProcessResources(candidate);
      return;
    }
    disposePostProcessResources(candidate);
  };
  const postProcessParamsByteSize = (entry: PostProcessShaderEntry): number =>
    entry.params?.byteSize ?? (entryHasDepthRead(entry) ? DEPTH_MIN_PARAMS_BYTE_SIZE : 0);
  const destroyPostProcessParams = (
    buffers: readonly Buffer[],
    device = postProcessParamsDevice,
  ): void => {
    for (const buffer of buffers) {
      const destroyed = device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  const disposeActivePostProcessResources = (): void => {
    releaseRepeated();
    const resources = { device: postProcessParamsDevice, paramsBuffers: postProcessParamsBuffers };
    postProcessParamsBuffers = new Map();
    disposePostProcessResources(resources);
  };
  /** Whether the active params buffer still serves this declaration (0 = needs none). */
  const retainsParamsBuffer = (id: string, entry: PostProcessShaderEntry): boolean | 0 => {
    if (id === 'forgeax.taa-resolve' || postProcessParamsByteSize(entry) === 0) return 0;
    const accepted = postProcessParamsBuffers.has(id) ? lookupPostProcess(id) : undefined;
    return (
      accepted !== undefined &&
      ((accepted === entry && isDeferredPostProcessEntry(entry)) ||
        postProcessShaderEntrySignature(accepted) === postProcessShaderEntrySignature(entry))
    );
  };
  /**
   * Allocation-free steady-state check run before every frame's preparation:
   * every declaration keeps its active buffer and no active buffer is
   * orphaned, so the active map itself is the candidate.
   */
  const paramsBuffersUnchanged = (
    featureEntries: ReadonlyMap<string, PostProcessShaderEntry>,
  ): boolean => {
    let retained = 0;
    for (const id of builtinPostProcessEntries.keys()) {
      // The declaration map below lets a feature entry replace a builtin one.
      const entry = (featureEntries.get(id) ??
        builtinPostProcessEntries.get(id)) as PostProcessShaderEntry;
      const kept = retainsParamsBuffer(id, entry);
      if (kept === false) return false;
      if (kept) retained++;
    }
    for (const id of featureEntries.keys()) {
      if (builtinPostProcessEntries.has(id)) continue;
      const kept = retainsParamsBuffer(id, featureEntries.get(id) as PostProcessShaderEntry);
      if (kept === false) return false;
      if (kept) retained++;
    }
    return retained === postProcessParamsBuffers.size;
  };
  const preparePostProcessParamsResources = (
    featureEntries: ReadonlyMap<string, PostProcessShaderEntry>,
  ): Result<PostProcessParamsCandidate, RhiError> => {
    if (paramsBuffersUnchanged(featureEntries))
      return ok({ buffers: postProcessParamsBuffers, created: [] });
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
        ((accepted === entry && isDeferredPostProcessEntry(entry)) ||
          postProcessShaderEntrySignature(accepted) === postProcessShaderEntrySignature(entry))
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
    return ok({ buffers: next, created: allocated });
  };
  const discardPostProcessParamsCandidate = (candidate: PostProcessParamsCandidate): void => {
    destroyPostProcessParams(candidate.created);
    candidate.created.length = 0;
  };
  const retirePostProcessParams = (buffers: readonly Buffer[]): void => {
    if (buffers.length === 0) return;
    const device = postProcessParamsDevice;
    const release = (): void => destroyPostProcessParams(buffers, device);
    if (afterSubmission !== undefined) {
      afterSubmission(device, release);
      return;
    }
    try {
      void device.queue.onSubmittedWorkDone().then(release, release);
    } catch {
      release();
    }
  };
  const acceptPostProcessParamsCandidate = (candidate: PostProcessParamsCandidate): void => {
    if (candidate.buffers === postProcessParamsBuffers) return;
    let retired: Buffer[] | undefined;
    let retained: Set<Buffer> | undefined;
    postProcessParamsBuffers.forEach((buffer, id) => {
      if (candidate.buffers.get(id) === buffer) return;
      retained ??= new Set(candidate.buffers.values());
      if (!retained.has(buffer)) {
        retired ??= [];
        retired.push(buffer);
      }
    });
    postProcessParamsBuffers = candidate.buffers;
    // Admission transfers disposal ownership to the active map. A later
    // frame abort cannot destroy an admitted or already retired allocation.
    candidate.created.length = 0;
    if (retired !== undefined) retirePostProcessParams(retired);
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
    beginRecording(): void {
      finishRecording();
      recording = true;
      sequence++;
    },
    finishRecording,
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
        if (paramsBuffer !== undefined)
          postProcessParamsBuffers = new Map(postProcessParamsBuffers).set(id, paramsBuffer);
        const registeredModuleLabel = isDeferredPostProcessEntry(entry)
          ? undefined
          : postProcessShaderModuleLabel(entry);
        let registered = true;
        return () => {
          if (!registered) return;
          registered = false;
          if (builtinPostProcessEntries.get(id) !== entry) return;
          builtinPostProcessEntries.delete(id);
          const current = postProcessParamsBuffers.get(id);
          if (current !== undefined) {
            const duplicates = repeated.get(current);
            if (duplicates !== undefined) repeated.delete(current);
            retirePostProcessParams(
              duplicates === undefined ? [current] : [current, ...duplicates.slots],
            );
            postProcessParamsBuffers = new Map(postProcessParamsBuffers);
            postProcessParamsBuffers.delete(id);
          }
          const source =
            registeredModuleLabel === undefined ? preparedPostProcessSource(entry) : undefined;
          invalidate(
            id,
            registeredModuleLabel ??
              (source === undefined ? undefined : postProcessShaderModuleLabel(source)),
          );
        };
      } catch (cause) {
        if (paramsBuffer !== undefined) internals.device.destroyBuffer(paramsBuffer);
        throw cause;
      }
    },
  };
}
