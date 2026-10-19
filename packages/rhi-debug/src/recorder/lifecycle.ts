// @forgeax/engine-rhi-debug/src/recorder/lifecycle -- capture state and snapshot lifecycle.

/// <reference types="@webgpu/types" />

import type { Result, Texture } from '@forgeax/engine-rhi';
import { err as makeErr, ok as makeOk } from '@forgeax/engine-types';
import { recordReplayCapabilities } from '../capabilities';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { digestBytesAsync } from '../protocol/codec';
import { createdHandles, handleAccess } from '../protocol/event-semantics';
import {
  readbackBufferBytes,
  readbackBufferBytesBatch,
  readbackTexturePixels,
  readbackTexturePixelsBatch,
} from '../readback';
import { readbackDepthTexture } from '../readback-depth';
import { computeTextureLayout, projectTextureExtent } from '../texel-layout';
import type { HandleId, RhiCallEvent, Tape } from '../types';
import { _collectFrameReferencedHandleIds, _computeClosure, _topoSortClosure } from './closure';
import {
  type CreateShaderModuleFn,
  isMappableBuffer,
  isSnapshottableTexture,
  pushSnapshotEvent,
  type RecorderInternal,
  RecorderState,
  reconcileSwapchainViewFormats,
  recorderDeviceIdentity,
  SNAPSHOT_RESOURCE_BATCH_SIZE,
  SNAPSHOT_STAGING_BYTES,
  SNAPSHOT_TIMEOUT_MS,
  type SnapshotProgress,
  snapshotProgressDetail,
  snapshotResourceBytes,
  snapshotStageOf,
  snapshotTimeoutDetail,
  TAPE_FORMAT_VERSION,
} from './core';
import { flushDeferredAccelerationStructureBuilds } from './encoder';

const NO_CURRENT_RESOURCE = {
  currentHandleId: null,
  currentKind: null,
  currentSizeBytes: null,
} as const satisfies Partial<SnapshotProgress>;

export function createRecorderLifecycle(
  s: RecorderInternal,
  createShaderModule: CreateShaderModuleFn,
) {
  async function storeSnapshotBlob(
    handleId: HandleId,
    kind: 'buffer' | 'texture',
    bytes: ArrayBuffer,
    isCurrent: () => boolean,
  ) {
    advanceProgress(() => ({
      stage: 'resource-hash',
      currentHandleId: handleId,
      currentKind: kind,
      currentSizeBytes: bytes.byteLength,
    }));
    const hash = await digestBytesAsync(new Uint8Array(bytes));
    // Hash completion can arrive after timeout, device loss or a new capture.
    // Only the generation that requested these bytes may publish them.
    if (!isCurrent()) return undefined;
    if (!s.blobPool.has(hash)) s.blobPool.set(hash, bytes);
    return hash;
  }

  function arm(frames: number): Result<void, RhiDebugError> {
    if (
      s.state === RecorderState.Armed ||
      s.state === RecorderState.Snapshotting ||
      s.state === RecorderState.Recording
    ) {
      return makeErr(
        createRhiDebugError('capture-busy', {
          stage: 'capture',
          cause: 'arm() called while the recorder is already capturing',
        }),
      );
    }
    if (s.state === RecorderState.Error) {
      return makeErr(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: 'the recorder is in an error state; dispose the failed capture before re-arming',
        }),
      );
    }

    flushDeferredAccelerationStructureBuilds(s);
    s.state = RecorderState.Armed;
    // A previous bounded snapshot may still be unwinding after its timeout.
    // Its generation fence prevents stale cleanup from touching this capture;
    // reset the suppression latch here so the new capture can record normally.
    s._skipRecord = false;
    s.snapshotGeneration += 1;
    s.requestedFrames = frames;
    s.recordedFrames = 0;
    s.events = [];
    s.blobPool = new Map();
    s.snapshotSeededHandles.clear();
    s.omittedSeeds = new Set();
    s.snapshotProgress = undefined;
    s.frameIdx = 0;
    s.bootstrap = true;
    s.valid = true;
    return makeOk(undefined);
  }

  function onFrameEnd(): void {
    if (s.frameEndReleases.length > 0) {
      const releases = s.frameEndReleases;
      s.frameEndReleases = [];
      for (const release of releases) release();
    }
    if (s.state === RecorderState.Idle) {
      s.frameIdx++;
      s.bootstrap = false;
      return;
    }

    // Snapshotting = the async frame-header snapshot loop is mid-flight. Its
    // readbacks await between resources, so the host rAF loop CAN fire
    // onFrameEnd while the loop is still pushing initialData events. If we let
    // that tick advance the state machine (Recording -> frameMark -> Idle),
    // the still-running snapshot loop's later pushEvent() calls hit the Idle
    // gate and are silently dropped -- the exact race that lost every texture
    // initialData (material default textures all-zero -> black cube).
    // Ignore the tick entirely: snapshotAllLiveResources() sets Recording when
    // it completes, and the NEXT onFrameEnd records the real frame.
    if (s.state === RecorderState.Snapshotting) {
      s.bootstrap = false;
      return;
    }

    // Armed at frame end -> recording. This is the fallback for hosts that
    // never call snapshotAllLiveResources() (the snapshot loop is opt-in at the
    // seam); they record straight from Armed with no frame-header snapshot.
    if (s.state === RecorderState.Armed) {
      s.state = RecorderState.Recording;
      s.bootstrap = false;
    }

    if (s.state === RecorderState.Recording) {
      // Emit frameMark at end of this frame
      s.events.push({ kind: 'frameMark', frameIdx: s.frameIdx });
      s.recordedFrames++;
      s.frameIdx++;

      if (s.recordedFrames >= s.requestedFrames) s.state = RecorderState.Idle;
      return;
    }

    // error: no-op
    s.frameIdx++;
  }

  function getTape(): Tape | RhiDebugError | undefined {
    if (s.events.length === 0) return undefined;

    reconcileSwapchainViewFormats(s);

    // Pre-scan s.events for create* declarations: handleIds whose
    // create event is already carried by the frame events (transient
    // per-frame resources like swapchain textures, command encoders).
    // These handles do NOT need bootstrap prefixing -- they were born
    // during the recorded frame and their create event is in s.events.
    // Collect handleIds that are directly declared by create* events in s.events.
    // Only include the handleId field of the create event itself — NOT backward-refs
    // (layoutHandleId, resourceHandleIds, etc.) from handleAccess read edges.
    //
    // Backward-refs from in-frame create events often point to persistent resources
    // (buffers, textures, pipelines) that were created before arm(). Including them
    // in inFrameHandleIds would exclude those resources from bootstrap prefixing,
    // causing tapes to be non-self-contained (missing create* events for early handles).
    //
    // Swapchain textures that have no createTexture event are handled elsewhere:
    // createTextureView (line 1237) detects missing bootstrap entries and constructs
    // faithful createTexture events at capture time, so they are already in both
    // bootstrapCreates and s.events.
    const inFrameHandleIds = new Set<HandleId>();
    for (const e of s.events) {
      for (const handleId of createdHandles(e)) inFrameHandleIds.add(handleId);
    }

    // Collect frame-referenced handleIds from per-frame events.
    const allFrameHandleIds = _collectFrameReferencedHandleIds(s.events);

    // Exclude handles whose create event is already in s.events:
    // only compute bootstrap closure for handles that need prefixing.
    const prefixSeedIds = new Set<HandleId>();
    for (const hId of allFrameHandleIds) {
      if (!inFrameHandleIds.has(hId)) {
        prefixSeedIds.add(hId);
      }
    }

    // Transitive closure from bootstrapCreates
    const { closure, missing } = _computeClosure(
      prefixSeedIds,
      s.bootstrapCreates,
      inFrameHandleIds,
    );

    if (missing !== null) {
      // Missing create — return error (hint refined in w9)
      const referencingEventIndex = s.events.findIndex((event) => {
        try {
          return JSON.stringify(event).includes(missing);
        } catch {
          return false;
        }
      });
      const referencingEventKind =
        referencingEventIndex >= 0 ? s.events[referencingEventIndex]?.kind : undefined;
      const referencingCreate = [...s.bootstrapCreates.entries()].find(([, event]) =>
        handleAccess(event).read.includes(missing),
      );
      return createRhiDebugError('tape-invalid', {
        stage: 'validate',
        cause: `handleId '${missing}' has no create event in bootstrap table; referenced by event ${referencingEventIndex} (${referencingEventKind ?? 'unknown'}) and bootstrap ${referencingCreate?.[0] ?? 'unknown'} (${referencingCreate?.[1].kind ?? 'unknown'})`,
        handleId: missing,
        eventIndex: referencingEventIndex,
      });
    }

    // Topological sort: dependencies (leaf resources) before dependents
    const prefixEvents: RhiCallEvent[] = _topoSortClosure(closure, s.bootstrapCreates);

    // dedup: only prefix create events not already in s.events.
    const dedupedPrefx = prefixEvents.filter((e) => {
      if ('handleId' in e && typeof (e as { handleId: unknown }).handleId === 'string') {
        return !inFrameHandleIds.has((e as { handleId: HandleId }).handleId);
      }
      return true;
    });

    return {
      formatVersion: TAPE_FORMAT_VERSION,
      rhiCapsRecorded: {
        ...(s.recordedCaps ?? {
          canvasFormat: 'bgra8unorm' as GPUTextureFormat,
          canvasColorSpace: 'srgb' as const,
          ...recordReplayCapabilities(),
        }),
        ...s.canvasConfiguration,
      },
      events: [...dedupedPrefx, ...s.events],
      blobPool: s.blobPool,
    };
  }

  function getState(): string {
    return s.state;
  }
  function getEvents(): readonly RhiCallEvent[] {
    return s.events;
  }
  function getBlobPool(): ReadonlyMap<string, ArrayBuffer> {
    return s.blobPool;
  }

  function transitionToError(): void {
    if (
      s.state === RecorderState.Recording ||
      s.state === RecorderState.Armed ||
      s.state === RecorderState.Snapshotting
    ) {
      s.state = RecorderState.Error;
      s.snapshotGeneration += 1;
      s._skipRecord = false;
      s.valid = false;
    }
  }

  function releaseTape(): void {
    if (s.state !== RecorderState.Idle) return;
    s.events = [];
    s.blobPool = new Map();
  }

  function disposeError(): void {
    if (s.state === RecorderState.Error) {
      s.state = RecorderState.Idle;
      s.snapshotGeneration += 1;
      s._skipRecord = false;
      s.events = [];
      s.blobPool = new Map();
      s.valid = true;
      s.snapshotProgress = undefined;
    }
  }

  /**
   * Snapshot a resource's GPU bytes into the tape as an initialData event.
   *
   * Reads the resource shape from the descriptor registry, copies the bytes
   * back from the GPU via readbackBufferBytes (buffer) / readbackTexturePixels
   * (texture), stores them in the blobPool (SHA-256 deduplication), and pushes an
   * `initialData` event into the stream. The snapshot's own copy/submit are
   * wrapped in `_skipRecord = true` so they never leak into the tape event
   * stream (D-8 isolation).
   *
   * Async because the GPU readback chain (copyToBuffer -> submit ->
   * onSubmittedWorkDone -> mapAsync) is inherently asynchronous; the M1 stub
   * locked a sync signature, but no caller existed yet — the frame-header loop
   * added here is the first consumer (Change stance: optimal > compatible).
   *
   * Returns Result with {handleId, dataHash} on success, or
   * capture-snapshot-failed (with structured snapshot detail) on a
   * failure, so AI users can switch-exhaustive narrow the code (D-3).
   */
  async function snapshotResource(
    handleId: HandleId,
    snapshotGeneration?: number,
  ): Promise<Result<{ handleId: HandleId; dataHash: string }, RhiDebugError>> {
    type SnapshotResult = Result<{ handleId: HandleId; dataHash: string }, RhiDebugError>;
    const fail = (
      stage: 'copy' | 'map' | 'store',
      _expected: string,
      hint: string,
    ): SnapshotResult =>
      makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: `${stage}: ${hint}`,
          handleId,
        }),
      );

    const entry = s.descriptorTable.get(handleId);
    if (entry === undefined) {
      return fail(
        'copy',
        'handleId present in descriptor registry',
        `no live resource registered for handleId '${handleId}'; it may have been destroyed or never created through the recorder proxy`,
      );
    }

    const device = s.capturedDevice;
    if (device === undefined) {
      return fail(
        'copy',
        'a captured RhiDevice to drive GPU readback',
        'no device has been acquired through the recorder proxy yet; drive requestAdapter().requestDevice() before snapshotting',
      );
    }

    // Resolve the unwrapped real device — readback issues copy/submit/mapAsync
    // through it. The proxy device would re-record those calls were it not for
    // the _skipRecord guard below; using the real device sidesteps the proxy
    // entirely for the readback staging buffer.
    const realDevice = recorderDeviceIdentity(device) ?? device;
    const snapshotIsActive = () =>
      s.descriptorTable.has(handleId) &&
      (snapshotGeneration === undefined ||
        (s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration));
    const cancelled = () =>
      makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause:
            'snapshot was cancelled after a timeout or recorder error; discard this capture and retry',
          handleId,
        }),
      );

    let bytes: ArrayBuffer;
    const prevSkip = s._skipRecord;
    s._skipRecord = true;
    try {
      if (entry.kind === 'buffer') {
        const size = typeof entry.size === 'number' ? entry.size : 0;
        if (s.indexBufferShadow.has(handleId)) {
          const shadow = s.indexBufferShadow.get(handleId);
          if (shadow === null || shadow === undefined)
            return fail(
              'copy',
              'known INDEX buffer contents',
              'WebGL2 INDEX buffer was modified outside queue.writeBuffer; its GPU copy readback is unreliable',
            );
          bytes = shadow.slice().buffer as ArrayBuffer;
        } else {
          const res = await readbackBufferBytes(realDevice, entry.resource, size);
          if (!res.ok) return fail(snapshotStageOf(res.error), res.error.expected, res.error.hint);
          bytes = res.value;
        }
        if (!snapshotIsActive()) return cancelled();
      } else {
        const extent = projectTextureExtent(entry.size);
        if (extent === undefined)
          return fail(
            'copy',
            'a positive recorded texture extent',
            'the texture descriptor has invalid dimensions',
          );
        const { width, height, layerCount } = extent;
        const layout = computeTextureLayout(
          entry.format,
          width,
          height,
          layerCount,
          entry.mipLevelCount ?? 1,
        );
        if (layout === undefined) {
          // Should not happen: the snapshot loop's isSnapshottableTexture
          // gate already excludes formats with no texel size. Fail fast rather
          // than emit a corrupt seed.
          return fail(
            'copy',
            'a snapshottable color format with a known texel size',
            `format '${entry.format}' has no byte layout; the snapshot gate should have skipped it`,
          );
        }
        try {
          // Read every (layer, mip) subresource and concatenate tight into one
          // blob in the canonical order computeTextureLayout defines; the seed
          // side walks the same layout to writeTexture each slice back.
          const blob = new Uint8Array(layout.totalBytes);
          for (const slice of layout.slices) {
            if (!snapshotIsActive()) return cancelled();
            const depth =
              entry.format === 'depth32float'
                ? await readbackDepthTexture(
                    realDevice,
                    entry.resource as Texture,
                    slice.width,
                    slice.height,
                    slice.mip,
                    slice.layer,
                    createShaderModule,
                    layerCount > 1 || entry.textureBindingViewDimension === '2d-array',
                    () => !snapshotIsActive(),
                  )
                : undefined;
            if (depth !== undefined && !depth.ok) return depth;
            const sub =
              depth?.value ??
              (await readbackTexturePixels(realDevice, entry.resource, slice.width, slice.height, {
                bytesPerBlock: layout.bytesPerBlock,
                blockWidth: layout.blockWidth,
                blockHeight: layout.blockHeight,
                mipLevel: slice.mip,
                baseArrayLayer: slice.layer,
              }));
            if (!snapshotIsActive()) return cancelled();
            blob.set(sub.subarray(0, slice.byteLength), slice.byteOffset);
          }
          bytes = blob.buffer as ArrayBuffer;
        } catch (e) {
          return fail(
            'copy',
            'texture GPU byte readback to succeed',
            `readbackTexturePixels failed: ${String(e)}`,
          );
        }
      }
    } finally {
      // A retry may begin before a timed-out readback promise settles. Do not
      // let the stale generation restore its old suppression bit over the new
      // capture's active snapshot; only the generation that acquired it may
      // release it.
      if (snapshotGeneration === undefined || s.snapshotGeneration === snapshotGeneration) {
        s._skipRecord = prevSkip;
      }
    }

    if (!snapshotIsActive()) return cancelled();

    // SHA-256 dedup takes ownership of the detached readback (no separate
    // init-data pool). Reuses the same tag space as writeBuffer/writeTexture.
    let dataHash: string;
    try {
      const hash = await storeSnapshotBlob(handleId, entry.kind, bytes, snapshotIsActive);
      if (hash === undefined) return cancelled();
      dataHash = hash;
    } catch (e) {
      return fail(
        'store',
        'native SHA-256 to hash and retain the current snapshot bytes',
        `snapshot digest failed: ${String(e)}`,
      );
    }

    pushSnapshotEvent(s, { kind: 'initialData', handleId, dataHash });
    s.snapshotSeededHandles.add(handleId);
    return makeOk({ handleId, dataHash });
  }

  /**
   * Frame-header snapshot loop (D-5, C-3, C-4): with the recorder in the
   * Snapshotting middle state, await all submitted work, then snapshot every
   * live resource in the descriptor registry (full-table dump, no size
   * threshold / allowlist trimming — that for-loop is the single Phase 2
   * policy seam, OOS-4 / OOS-5). On full success the recorder advances to
   * Recording; a single snapshot failure aborts with its Result so the
   * caller fails fast (architecture §5) rather than recording a partial seed.
   */
  async function snapshotAllLiveResources(
    timeoutMs = SNAPSHOT_TIMEOUT_MS,
    maxResourceBytes = Number.POSITIVE_INFINITY,
  ): Promise<Result<void, RhiDebugError>> {
    if (s.state !== RecorderState.Armed && s.state !== RecorderState.Snapshotting) {
      return makeErr(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `snapshotAllLiveResources called while recorder is in '${s.state}' state; arm() before the frame-header snapshot`,
        }),
      );
    }
    const snapshotGeneration = s.snapshotGeneration;
    s.state = RecorderState.Snapshotting;

    const timeoutError = () =>
      createRhiDebugError('capture-timeout', snapshotTimeoutDetail(s.snapshotProgress, timeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<Result<void, RhiDebugError>>((resolve) => {
      timer = setTimeout(() => {
        // The caller may have timed out first, disposed the failed capture,
        // and already started a new generation. A late timer from that stale
        // snapshot must not poison the retry that now owns the recorder.
        if (s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration) {
          transitionToError();
        }
        resolve(makeErr(timeoutError()));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        runSnapshotAllLiveResources(snapshotGeneration, maxResourceBytes),
        timeoutResult,
      ]);
      if (
        !result.ok &&
        s.state === RecorderState.Snapshotting &&
        s.snapshotGeneration === snapshotGeneration
      ) {
        transitionToError();
      }
      return result;
    } catch (error) {
      const progress =
        s.snapshotGeneration === snapshotGeneration
          ? snapshotProgressDetail(s.snapshotProgress)
          : undefined;
      if (s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration) {
        transitionToError();
      }
      return makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: String(error),
          ...(progress === undefined ? {} : { progress }),
        }),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Snapshot progress transitions. A reset (arm / disposeError / device loss)
  // clears the record; a run still unwinding must not resurrect it.
  function advanceProgress(next: (progress: SnapshotProgress) => Partial<SnapshotProgress>): void {
    if (s.snapshotProgress !== undefined)
      s.snapshotProgress = { ...s.snapshotProgress, ...next(s.snapshotProgress) };
  }
  function startProgressResource(
    handleId: HandleId,
    kind: 'buffer' | 'texture',
    sizeBytes: number | null,
  ): void {
    advanceProgress(() => ({
      stage: 'resource-readback',
      currentHandleId: handleId,
      currentKind: kind,
      currentSizeBytes: sizeBytes,
    }));
  }
  function completeProgressResource(): void {
    advanceProgress((progress) => ({
      completedResources: progress.completedResources + 1,
      ...NO_CURRENT_RESOURCE,
    }));
  }
  function skipProgressResource(): void {
    advanceProgress((progress) => ({
      skippedResources: progress.skippedResources + 1,
      ...NO_CURRENT_RESOURCE,
    }));
  }

  async function runSnapshotAllLiveResources(
    snapshotGeneration: number,
    maxResourceBytes: number,
  ): Promise<Result<void, RhiDebugError>> {
    s.snapshotProgress = {
      startedAt: Date.now(),
      stage: 'queue-drain',
      totalResources: s.descriptorTable.size,
      completedResources: 0,
      skippedResources: 0,
      ...NO_CURRENT_RESOURCE,
    };

    const liveEntries = [...s.descriptorTable.entries()];
    const candidates = liveEntries.filter(([handleId, entry]) => {
      // Mappable buffers are staging scratch, not seedable authored resources.
      if (entry.kind === 'buffer' && isMappableBuffer(entry.usage)) {
        skipProgressResource();
        return false;
      }
      // Only formats with an exact snapshot and restore path may be seeded.
      if (
        entry.kind === 'texture' &&
        !isSnapshottableTexture(entry.format, entry.size, entry.sampleCount)
      ) {
        skipProgressResource();
        return false;
      }
      if (snapshotResourceBytes(entry).payload > maxResourceBytes) {
        s.omittedSeeds.add(handleId);
        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            skippedResources: s.snapshotProgress.skippedResources + 1,
          };
        }
        return false;
      }
      return true;
    });

    // A capture that explicitly omits every live seed has no historical GPU
    // bytes to synchronize. Avoid waiting on an unrelated queue drain before
    // recording its next frame; captures with candidates still use C-3.
    const device = s.capturedDevice;
    const realDevice =
      device === undefined ? undefined : (recorderDeviceIdentity(device) ?? device);
    if (realDevice !== undefined && candidates.length > 0) {
      const prevSkip = s._skipRecord;
      s._skipRecord = true;
      try {
        await realDevice.queue.onSubmittedWorkDone();
      } finally {
        if (s.snapshotGeneration === snapshotGeneration) s._skipRecord = prevSkip;
      }
      advanceProgress(() => ({ stage: 'resource-readback' }));
      if (s.state !== RecorderState.Snapshotting || s.snapshotGeneration !== snapshotGeneration) {
        return makeErr(
          createRhiDebugError('capture-snapshot-failed', {
            stage: 'snapshot',
            cause: 'snapshot was cancelled while queued GPU work was draining',
          }),
        );
      }
    }

    const snapshotIsActive = () =>
      s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration;
    const cancelledResult = () =>
      makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: 'snapshot was cancelled while live resources were being seeded',
        }),
      );

    // No captured device is an existing error path for snapshotResource. Keep
    // it serial and deterministic rather than manufacturing a batch surface.
    if (realDevice === undefined) {
      for (const [handleId, entry] of candidates) {
        startProgressResource(
          handleId,
          entry.kind,
          entry.kind === 'buffer' && typeof entry.size === 'number' ? entry.size : null,
        );
        const result = await snapshotResource(handleId, snapshotGeneration);
        if (!result.ok) return result;
        completeProgressResource();
      }
    } else {
      let offset = 0;
      while (offset < candidates.length) {
        const first = candidates[offset];
        if (first === undefined) break;
        const kind = first[1].kind;
        const batchEntries: typeof candidates = [];
        let stagingBytes = 0;
        while (
          offset < candidates.length &&
          batchEntries.length < SNAPSHOT_RESOURCE_BATCH_SIZE &&
          candidates[offset]?.[1].kind === kind
        ) {
          const candidate = candidates[offset];
          // Earlier batches await GPU work, allowing graph retirement to
          // remove later candidates. Recheck at the synchronous copy-admission
          // boundary so the recorder never submits a destroyed resource.
          if (candidate !== undefined) {
            if (s.descriptorTable.has(candidate[0])) {
              const bytes = snapshotResourceBytes(candidate[1]).staging;
              if (batchEntries.length > 0 && stagingBytes + bytes > SNAPSHOT_STAGING_BYTES) break;
              batchEntries.push(candidate);
              stagingBytes += bytes;
            } else {
              skipProgressResource();
            }
          }
          offset += 1;
        }
        if (batchEntries.length === 0) continue;

        advanceProgress(() => ({
          stage: 'resource-readback',
          currentHandleId: batchEntries[0]?.[0] ?? null,
          currentKind: kind,
          currentSizeBytes:
            kind === 'buffer' && typeof batchEntries[0]?.[1].size === 'number'
              ? batchEntries[0][1].size
              : null,
        }));

        if (kind === 'buffer') {
          const gpuEntries = batchEntries.filter(
            ([handleId]) => !s.indexBufferShadow.has(handleId),
          );
          const batch =
            gpuEntries.length === 0
              ? makeOk(new Map<HandleId, ArrayBuffer>())
              : await readbackBufferBytesBatch(
                  realDevice,
                  gpuEntries.map(([handleId, entry]) => ({
                    handleId,
                    buffer: entry.resource,
                    size: typeof entry.size === 'number' ? entry.size : 0,
                  })),
                  {
                    onResourceStart: (handleId) => {
                      const entry = s.descriptorTable.get(handleId);
                      if (entry !== undefined)
                        startProgressResource(
                          handleId,
                          'buffer',
                          typeof entry.size === 'number' ? entry.size : null,
                        );
                    },
                    isCancelled: () => !snapshotIsActive(),
                  },
                );
          if (!batch.ok) return batch;
          if (!snapshotIsActive()) return cancelledResult();
          for (const [handleId] of batchEntries) {
            const shadow = s.indexBufferShadow.get(handleId);
            if (s.indexBufferShadow.has(handleId) && (shadow === null || shadow === undefined)) {
              return makeErr(
                createRhiDebugError('capture-snapshot-failed', {
                  stage: 'snapshot',
                  cause:
                    'WebGL2 INDEX buffer was modified outside queue.writeBuffer; its GPU copy readback is unreliable',
                  handleId,
                  resourceKind: 'buffer',
                }),
              );
            }
            const bytes = shadow?.slice().buffer ?? batch.value.get(handleId);
            if (bytes === undefined) {
              return makeErr(
                createRhiDebugError('capture-snapshot-failed', {
                  stage: 'snapshot',
                  cause: 'the batched GPU readback returned no bytes for a live buffer',
                  handleId,
                  resourceKind: 'buffer',
                }),
              );
            }
            const dataHash = await storeSnapshotBlob(handleId, 'buffer', bytes, snapshotIsActive);
            if (dataHash === undefined) return cancelledResult();
            pushSnapshotEvent(s, { kind: 'initialData', handleId, dataHash });
            s.snapshotSeededHandles.add(handleId);
            completeProgressResource();
          }
        } else {
          // Depth copies are unavailable on WebGL2. Use the same exact float
          // load as replay, one resource at a time, and keep color copies batched.
          for (const [handleId, entry] of batchEntries) {
            if (entry.format !== 'depth32float') continue;
            if (!s.descriptorTable.has(handleId)) {
              skipProgressResource();
              continue;
            }
            startProgressResource(handleId, 'texture', null);
            const depth = await snapshotResource(handleId, snapshotGeneration);
            if (!snapshotIsActive()) return cancelledResult();
            if (!s.descriptorTable.has(handleId)) {
              skipProgressResource();
              continue;
            }
            if (!depth.ok) return depth;
            completeProgressResource();
          }
          const colorEntries = batchEntries.filter(([handleId, entry]) => {
            if (entry.format === 'depth32float') return false;
            if (s.descriptorTable.has(handleId)) return true;
            skipProgressResource();
            return false;
          });
          const requests = colorEntries
            .filter(([handleId]) => !s.tinyTextureShadow.has(handleId))
            .map(([handleId, entry]) => {
              const extent = projectTextureExtent(entry.size);
              if (extent === undefined)
                throw new Error(`texture '${handleId}' has invalid dimensions`);
              const { width, height, layerCount } = extent;
              const layout = computeTextureLayout(
                entry.format,
                width,
                height,
                layerCount,
                entry.mipLevelCount ?? 1,
              );
              if (layout === undefined) {
                throw new Error(`texture '${handleId}' has no snapshottable byte layout`);
              }
              return {
                handleId,
                texture: entry.resource,
                bytesPerBlock: layout.bytesPerBlock,
                blockWidth: layout.blockWidth,
                blockHeight: layout.blockHeight,
                totalBytes: layout.totalBytes,
                slices: layout.slices,
              };
            });
          const batch =
            requests.length === 0
              ? makeOk(new Map<HandleId, ArrayBuffer>())
              : await readbackTexturePixelsBatch(realDevice, requests, {
                  onResourceStart: (handleId) => startProgressResource(handleId, 'texture', null),
                  isCancelled: () => !snapshotIsActive(),
                });
          if (!batch.ok) return batch;
          if (!snapshotIsActive()) return cancelledResult();
          for (const [handleId] of colorEntries) {
            // A transient texture can be released while its batch is waiting
            // on the GPU. The copy was intentionally isolated and cleaned up,
            // but the released handle must not become a seed for the next
            // frame. Buffers retain the historical batch behavior above.
            if (!s.descriptorTable.has(handleId)) {
              skipProgressResource();
              continue;
            }
            const shadow = s.tinyTextureShadow.get(handleId);
            if (shadow !== undefined) startProgressResource(handleId, 'texture', null);
            const bytes = shadow?.slice().buffer ?? batch.value.get(handleId);
            if (bytes === undefined) {
              return makeErr(
                createRhiDebugError('capture-snapshot-failed', {
                  stage: 'snapshot',
                  cause: 'the batched GPU readback returned no bytes for a live texture',
                  handleId,
                  resourceKind: 'texture',
                }),
              );
            }
            const dataHash = await storeSnapshotBlob(handleId, 'texture', bytes, snapshotIsActive);
            if (dataHash === undefined) return cancelledResult();
            pushSnapshotEvent(s, { kind: 'initialData', handleId, dataHash });
            s.snapshotSeededHandles.add(handleId);
            completeProgressResource();
          }
        }
        if (!snapshotIsActive()) return cancelledResult();
      }
    }

    advanceProgress(() => NO_CURRENT_RESOURCE);

    if (s.state !== RecorderState.Snapshotting || s.snapshotGeneration !== snapshotGeneration) {
      return makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: 'snapshot was cancelled before the full live-resource table was seeded',
        }),
      );
    }
    s.state = RecorderState.Recording;
    return makeOk(undefined);
  }

  // --------------------------------------------------
  // proxy construction
  // --------------------------------------------------

  return {
    arm,
    onFrameEnd,
    getTape,
    getState,
    getEvents,
    getBlobPool,
    transitionToError,
    disposeError,
    releaseTape,
    snapshotResource,
    snapshotAllLiveResources,
  };
}
