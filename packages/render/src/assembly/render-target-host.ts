import type { Buffer, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import {
  RenderTargetCapabilityMissingError,
  RenderTargetDescriptorInvalidError,
  RenderTargetLayerInvalidError,
  RenderTargetOperationFailedError,
  RenderTargetStateInvalidError,
} from '../errors/render';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { resolveRenderTargetMipExtent } from '../record/frame-targets';
import type { RenderResult } from '../render-contract';
import {
  admitRenderTargetDescriptor,
  type FramebufferSnapshotData,
  type FramebufferSnapshotRequest,
  type FramebufferSnapshotTicket,
  type RenderTarget,
  type RenderTargetAdmissionLimits,
  type RenderTargetDescriptor,
  type RenderTargetReadbackData,
  type RenderTargetReadbackRequest,
  type RenderTargetReadbackTicket,
  type RenderTargetTextureSource,
  type RenderTargetTextureSourceOptions,
  renderTargetLayerCount,
} from '../targets/contracts';
import {
  createFramebufferSnapshotQueue,
  type FramebufferSnapshotSource,
} from '../targets/framebuffer-snapshot';
import {
  createRenderTargetMaterialSource,
  type RenderTargetMaterialSourceBinding,
  resolveRenderTargetMaterialSource,
} from '../targets/material-source';
import { createRenderTargetOwner, type RenderTargetOwner } from '../targets/owner';
import {
  createRenderTargetPhysical,
  destroyRenderTargetPhysical,
  type RenderTargetPhysical,
  retireRenderTargetPhysical,
} from '../targets/physical';
import {
  bindRenderTargetReadbackTicket,
  completeRenderTargetReadback,
  createRenderTargetReadbackTicket,
  type RenderTargetReadbackTicket as InternalReadbackTicket,
  type RenderTargetReadbackReceipt,
} from '../targets/readback';

export interface RenderTargetHostOptions {
  readonly onError?: (error: RenderError) => void;
  readonly rendererId?: symbol;
  readonly initialGeneration?: number;
  readonly getGeneration?: () => number;
  readonly limits?: RenderTargetAdmissionLimits;
  readonly getDevice?: () => RhiDevice;
  /**
   * Renderer-owned candidate publication gate. Progressive cube capture keeps
   * a target candidate across face submissions and returns true only after the
   * capture scheduler has committed all faces for the matching fence.
   */
  readonly canPromoteTarget?: (target: RenderTarget) => boolean;
}

const DEFAULT_LIMITS: RenderTargetAdmissionLimits = {
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBytesPerTarget: 256 * 1024 * 1024,
  renderableFormats: ['rgba16float', 'rgba8unorm', 'rgba8unorm-srgb'],
  sampleCounts: [1, 4],
  depthFormats: ['depth24plus-stencil8', 'depth32float'],
};

/** One target layer (cube face, array layer, or 3D slice) written by a frame. */
export interface RenderTargetLayerWrite {
  readonly target: RenderTarget;
  readonly layer: number;
}

interface ReadbackRecord {
  readonly target: RenderTarget;
  readonly request: RenderTargetReadbackRequest;
  readonly ticket: InternalReadbackTicket;
  readonly allocation?: { readonly device: RhiDevice; readonly buffer: Buffer };
  status: 'pending' | 'encoded' | 'submitted';
}

export interface RenderTargetHost {
  /** The logical owner for every target lifecycle operation. */
  readonly owner: 'renderer';
  /** Logical descriptions for the source publication boundary; no physical state escapes. */
  descriptions(): readonly {
    readonly target: RenderTarget;
    readonly descriptor: RenderTargetDescriptor;
  }[];
  createRenderTarget(descriptor: RenderTargetDescriptor): RenderResult<RenderTarget, RenderError>;
  resizeRenderTarget(
    target: RenderTarget,
    descriptor: RenderTargetDescriptor,
  ): RenderResult<void, RenderError>;
  createRenderTargetTextureSource(
    target: RenderTarget,
    options: RenderTargetTextureSourceOptions,
  ): RenderResult<RenderTargetTextureSource, RenderError>;
  /** @internal Resolve a source for the existing material projection path. */
  resolveRenderTargetTextureSource(
    source: RenderTargetTextureSource,
  ): RenderTargetMaterialSourceBinding | undefined;
  requestTargetReadback(
    target: RenderTarget,
    request: RenderTargetReadbackRequest,
  ): RenderResult<RenderTargetReadbackTicket, RenderError>;
  observeTargetReadbacks(
    receipt: RenderTargetReadbackReceipt,
    tickets: readonly RenderTargetReadbackTicket[],
  ): Promise<RenderResult<readonly RenderTargetReadbackData[], RenderError>>;
  requestFramebufferSnapshot(
    target: RenderTarget,
    request: FramebufferSnapshotRequest,
  ): RenderResult<FramebufferSnapshotTicket, RenderError>;
  observeFramebufferSnapshots(
    receipt: RenderTargetReadbackReceipt,
    tickets: readonly FramebufferSnapshotTicket[],
  ): Promise<RenderResult<readonly FramebufferSnapshotData[], RenderError>>;
  /** @internal Copy pending snapshot regions from a final linear-HDR scene color. */
  encodeFramebufferSnapshots(encoder: RhiCommandEncoder, source: FramebufferSnapshotSource): void;
  /** @internal Physical target used by the active Standard frame. */
  getPhysicalTarget(target: RenderTarget): RenderTargetPhysical | undefined;
  /** @internal A target write was accepted by the frame's sole queue submission. */
  markTargetSubmitted(target: RenderTarget, physical: RenderTargetPhysical): void;
  /** @internal Add pending target copies to the frame's sole encoder. */
  /**
   * Encode pending readbacks. `written` lists the target layers this command
   * buffer writes; a readback of a written layer copies the candidate.
   */
  encodePendingReadbacks(
    encoder: RhiCommandEncoder,
    written?: readonly RenderTargetLayerWrite[],
  ): void;
  destroyRenderTarget(target: RenderTarget): RenderResult<void, RenderError>;
  /** Called immediately before the existing Standard frame is interpreted. */
  beginFrame(): void;
  /** Called only after the existing Renderer frame submission is accepted. */
  onFrameSubmitted(
    completed?: Promise<RenderResult<void, RenderError>>,
    receipt?: RenderTargetReadbackReceipt,
  ): void;
  /** Called after a replacement DeviceScope generation becomes active. */
  recover(): void;
  /** Called before Renderer-owned physical resources are released. */
  dispose(): void;
}

function opaqueTicket(): RenderTargetReadbackTicket {
  return Object.freeze({}) as RenderTargetReadbackTicket;
}

function bytesPerPixel(format: RenderTargetDescriptor['format']): number {
  return format === 'rgba16float' ? 8 : 4;
}

export function createRenderTargetHost(options: RenderTargetHostOptions = {}): RenderTargetHost {
  let disposed = false;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const currentGeneration = (): number =>
    options.getGeneration?.() ?? options.initialGeneration ?? 0;
  const owner: RenderTargetOwner = createRenderTargetOwner({
    rendererId: options.rendererId ?? Symbol('renderer'),
    getGeneration: currentGeneration,
  });
  const targets = new Set<RenderTarget>();
  const staged = new Set<RenderTarget>();
  const activePhysical = new WeakMap<object, RenderTargetPhysical>();
  const candidatePhysical = new WeakMap<object, RenderTargetPhysical>();
  const submittedPhysicals = new WeakSet<RenderTargetPhysical>();
  const sources = new WeakMap<object, RenderTargetMaterialSourceBinding>();
  const readbacks = new Map<RenderTargetReadbackTicket, ReadbackRecord>();
  const frameWriters = new Set<RenderTarget>();
  const markTargetSubmitted = (target: RenderTarget, physical: RenderTargetPhysical): void => {
    if (candidatePhysical.get(target) === physical) submittedPhysicals.add(physical);
  };
  const snapshots = createFramebufferSnapshotQueue({
    owner,
    currentGeneration,
    writablePhysical: (target) => candidatePhysical.get(target) ?? activePhysical.get(target),
    activePhysical: (target) => activePhysical.get(target),
    claimedByWriter: (target) => frameWriters.has(target),
    markWritten: markTargetSubmitted,
  });
  const report = (error: RenderError) => options.onError?.(error);
  const releasePhysical = (physical: RenderTargetPhysical | undefined, failures: RenderError[]) => {
    const result = destroyRenderTargetPhysical(physical);
    if (!result.ok) failures.push(result.error);
  };
  const releaseReadback = (record: ReadbackRecord, failures: RenderError[]): void => {
    if (record.allocation === undefined) return;
    try {
      const destroyed = record.allocation.device.destroyBuffer(record.allocation.buffer);
      if (!destroyed.ok) throw destroyed.error;
    } catch (cause) {
      failures.push(
        new RenderTargetOperationFailedError({
          operation: 'destroy',
          stage: 'retire',
          generation: record.ticket.deviceGeneration,
          cause,
          recovery: 'recover',
        }),
      );
    }
  };
  const releaseTarget = (target: RenderTarget): RenderError[] => {
    const failures: RenderError[] = [];
    const physicals = new Set([activePhysical.get(target), candidatePhysical.get(target)]);
    activePhysical.delete(target);
    candidatePhysical.delete(target);
    staged.delete(target);
    for (const physical of physicals) releasePhysical(physical, failures);
    for (const [ticket, record] of readbacks) {
      if (record.target !== target) continue;
      readbacks.delete(ticket);
      releaseReadback(record, failures);
    }
    return failures;
  };
  const retirementResult = (failures: readonly RenderError[]): RenderResult<void, RenderError> =>
    failures.length === 0
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'destroy',
            stage: 'retire',
            generation: currentGeneration(),
            cause: new AggregateError(failures, 'Render target cleanup failed'),
            recovery: 'recover',
          }),
        };
  const stagePhysical = (
    target: RenderTarget,
    descriptor?: RenderTargetDescriptor,
  ): RenderResult<void, RenderError> => {
    const stagedTarget = owner.stage(target, descriptor);
    if (!stagedTarget.ok) return stagedTarget;
    const device = options.getDevice?.();
    if (device === undefined) {
      staged.add(target);
      return { ok: true, value: undefined };
    }
    const physical = createRenderTargetPhysical(
      device,
      stagedTarget.value.descriptor,
      stagedTarget.value.generation,
    );
    const previous = candidatePhysical.get(target);
    candidatePhysical.delete(target);
    if (previous !== undefined) {
      retireRenderTargetPhysical(previous, report);
    }
    if (!physical.ok) {
      staged.delete(target);
      owner.rejectCandidate(target, stagedTarget.value.generation, 'allocation');
      return physical;
    }
    candidatePhysical.set(target as object, physical.value);
    staged.add(target);
    return { ok: true, value: undefined };
  };

  return Object.freeze({
    owner: 'renderer' as const,
    descriptions() {
      return [...targets].map((target) => {
        const state = owner.inspect(target);
        if (!state.ok) throw state.error;
        return { target, descriptor: state.value.candidate?.descriptor ?? state.value.descriptor };
      });
    },
    createRenderTarget(
      descriptor: RenderTargetDescriptor,
    ): RenderResult<RenderTarget, RenderError> {
      if (disposed) {
        return {
          ok: false,
          error: new RenderTargetStateInvalidError({
            operation: 'inspect',
            reason: 'destroyed',
            state: 'destroyed',
            generation: currentGeneration(),
          }),
        };
      }
      const admitted = admitRenderTargetDescriptor(descriptor, limits);
      if (!admitted.ok) return admitted;
      const created = owner.create(admitted.value);
      if (created.ok) targets.add(created.value);
      return created;
    },
    resizeRenderTarget(
      target: RenderTarget,
      descriptor: RenderTargetDescriptor,
    ): RenderResult<void, RenderError> {
      const admitted = admitRenderTargetDescriptor(descriptor, limits);
      if (!admitted.ok) return admitted;
      return stagePhysical(target, admitted.value);
    },
    createRenderTargetTextureSource(
      target: RenderTarget,
      sourceOptions: RenderTargetTextureSourceOptions,
    ): RenderResult<RenderTargetTextureSource, RenderError> {
      const inspected = owner.inspect(target);
      if (!inspected.ok) return inspected;
      if (!inspected.value.descriptor.sampled) {
        return {
          ok: false,
          error: new RenderTargetCapabilityMissingError({
            operation: 'source',
            requested: 'sampled=true',
            capability: 'sampled',
            actual: 'false',
          }),
        };
      }
      if (sourceOptions.dimension !== inspected.value.descriptor.shape) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'dimension',
            value: sourceOptions.dimension,
            expected: `dimension matches ${inspected.value.descriptor.shape}`,
          }),
        };
      }
      if (
        !Number.isInteger(sourceOptions.mipLevel) ||
        sourceOptions.mipLevel < 0 ||
        (inspected.value.descriptor.mipLevels === 1 && sourceOptions.mipLevel !== 0)
      ) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'mipLevel',
            value: sourceOptions.mipLevel,
            expected: 'an admitted mip level for the target',
          }),
        };
      }
      const binding = createRenderTargetMaterialSource(target, inspected.value.descriptor, {
        ...sourceOptions,
        generation: inspected.value.generation,
      });
      if (!binding.ok) return binding;
      sources.set(binding.value.source as object, binding.value);
      return { ok: true, value: binding.value.source };
    },
    resolveRenderTargetTextureSource(source: RenderTargetTextureSource) {
      const binding = sources.get(source as object) ?? resolveRenderTargetMaterialSource(source);
      if (binding === undefined) return undefined;
      const physical = activePhysical.get(binding.target as object);
      if (physical === undefined) return binding;
      const view = physical.mipViews[binding.view.mipLevel] ?? physical.view;
      if (binding.generation !== physical.generation) return binding;
      return { ...binding, textureView: view };
    },
    requestTargetReadback(
      target: RenderTarget,
      request: RenderTargetReadbackRequest,
    ): RenderResult<RenderTargetReadbackTicket, RenderError> {
      const inspected = owner.inspect(target);
      if (!inspected.ok) return inspected;
      if (!inspected.value.descriptor.readback) {
        return {
          ok: false,
          error: new RenderTargetCapabilityMissingError({
            operation: 'readback',
            requested: 'readback=true',
            capability: 'readback',
            actual: 'false',
          }),
        };
      }
      if (!Number.isInteger(request.mipLevel) || request.mipLevel < 0) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'mipLevel',
            value: request.mipLevel,
            expected: 'a non-negative integer',
          }),
        };
      }
      const mipCount =
        inspected.value.descriptor.mipLevels === 1
          ? 1
          : Math.floor(
              Math.log2(
                Math.max(inspected.value.descriptor.width, inspected.value.descriptor.height),
              ),
            ) + 1;
      if (request.mipLevel >= mipCount) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'mipLevel',
            value: request.mipLevel,
            expected: `mipLevel < ${mipCount}`,
          }),
        };
      }
      const layers = renderTargetLayerCount(inspected.value.descriptor);
      if (
        request.layer !== undefined &&
        (!Number.isInteger(request.layer) || request.layer < 0 || request.layer >= layers)
      ) {
        return {
          ok: false,
          error: new RenderTargetLayerInvalidError({
            operation: 'readback',
            layer: request.layer,
            shape: inspected.value.descriptor.shape,
            layerCount: layers,
          }),
        };
      }
      const ticket = opaqueTicket();
      const extent = resolveRenderTargetMipExtent(inspected.value.descriptor, request.mipLevel);
      const device = options.getDevice?.();
      const buffer = device?.createBuffer({
        label: `render-target-readback.${request.mipLevel}.${request.layer ?? 0}`,
        size:
          Math.ceil((extent.width * bytesPerPixel(inspected.value.descriptor.format)) / 256) *
          256 *
          extent.height,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
        mappedAtCreation: false,
      });
      if (buffer !== undefined && !buffer.ok) {
        return {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'readback',
            stage: 'allocation',
            generation: inspected.value.generation,
            cause: buffer.error,
            recovery: 'retry',
          }),
        };
      }
      const internalTicket = createRenderTargetReadbackTicket(target, {
        deviceGeneration: inspected.value.generation,
        mipLevel: request.mipLevel,
        ...(request.layer === undefined ? {} : { layer: request.layer }),
        width: extent.width,
        height: extent.height,
        bytesPerPixel: bytesPerPixel(inspected.value.descriptor.format),
      });
      if (!internalTicket.ok) return internalTicket;
      const record = {
        target,
        request,
        ticket: internalTicket.value,
        ...(buffer === undefined || device === undefined
          ? {}
          : { allocation: { device, buffer: buffer.value } }),
        status: 'pending',
      } satisfies ReadbackRecord;
      readbacks.set(ticket, record);
      return { ok: true, value: ticket };
    },
    async observeTargetReadbacks(
      receipt: RenderTargetReadbackReceipt,
      tickets: readonly RenderTargetReadbackTicket[],
    ): Promise<RenderResult<readonly RenderTargetReadbackData[], RenderError>> {
      const results: RenderTargetReadbackData[] = [];
      for (const publicTicket of tickets) {
        const record = readbacks.get(publicTicket);
        if (record === undefined) {
          return {
            ok: false,
            error: new RenderTargetStateInvalidError({
              operation: 'readback',
              reason: 'foreign-renderer',
              state: 'destroyed',
              generation: receipt.deviceGeneration,
            }),
          };
        }
        const inspected = owner.inspect(record.target);
        if (!inspected.ok) return inspected;
        if (activePhysical.get(record.target) === undefined || record.status !== 'submitted') {
          return {
            ok: false,
            error: new RenderTargetStateInvalidError({
              operation: 'readback',
              reason: 'uninitialized',
              state: inspected.value.state,
              generation: inspected.value.generation,
            }),
          };
        }
        if (
          inspected.value.generation !== receipt.deviceGeneration ||
          record.ticket.frameId !== receipt.frameId ||
          record.ticket.deviceGeneration !== receipt.deviceGeneration
        ) {
          return {
            ok: false,
            error: new RenderTargetStateInvalidError({
              operation: 'readback',
              reason: 'generation-mismatch',
              state: inspected.value.state,
              generation: inspected.value.generation,
            }),
          };
        }
        let bytes = new Uint8Array(record.ticket.byteLength);
        if (
          record.allocation !== undefined &&
          typeof record.allocation.buffer.mapAsync === 'function'
        ) {
          const mapped = await record.allocation.buffer.mapAsync(1);
          if (!mapped.ok) {
            return {
              ok: false,
              error: new RenderTargetOperationFailedError({
                operation: 'readback',
                stage: 'copy',
                generation: receipt.deviceGeneration,
                cause: mapped.error,
                recovery: 'retry',
              }),
            };
          }
          const range = mapped.value.getMappedRange();
          if (!range.ok) {
            return {
              ok: false,
              error: new RenderTargetOperationFailedError({
                operation: 'readback',
                stage: 'copy',
                generation: receipt.deviceGeneration,
                cause: range.error,
                recovery: 'retry',
              }),
            };
          }
          bytes = new Uint8Array(range.value.slice(0));
          mapped.value.unmap();
        }
        const completed = completeRenderTargetReadback(record.ticket, receipt, bytes);
        if (!completed.ok) return completed;
        readbacks.delete(publicTicket);
        const failures: RenderError[] = [];
        releaseReadback(record, failures);
        const retired = retirementResult(failures);
        if (!retired.ok) return retired;
        results.push({
          ticket: publicTicket,
          bytes: completed.value.bytes,
          frameId: completed.value.frameId,
          deviceGeneration: completed.value.deviceGeneration,
          mipLevel: completed.value.mipLevel,
          ...(completed.value.layer === undefined ? {} : { layer: completed.value.layer }),
          bytesPerRow: record.ticket.bytesPerRow,
          byteLength: record.ticket.byteLength,
        });
      }
      return { ok: true, value: Object.freeze(results) };
    },
    destroyRenderTarget(target: RenderTarget): RenderResult<void, RenderError> {
      const destroyed = owner.destroy(target);
      if (!destroyed.ok) return destroyed;
      const failures = releaseTarget(target);
      snapshots.release(target);
      targets.delete(target);
      return retirementResult(failures);
    },
    requestFramebufferSnapshot: snapshots.request,
    observeFramebufferSnapshots: snapshots.observe,
    encodeFramebufferSnapshots(encoder: RhiCommandEncoder, source: FramebufferSnapshotSource) {
      if (!disposed) snapshots.encode(encoder, source);
    },
    beginFrame(): void {
      if (disposed) return;
      frameWriters.clear();
      snapshots.beginFrame();
      for (const record of readbacks.values())
        if (record.status === 'encoded') record.status = 'pending';
      for (const target of targets) {
        const inspected = owner.inspect(target);
        if (
          !inspected.ok ||
          inspected.value.state === 'active' ||
          inspected.value.state === 'candidate'
        ) {
          continue;
        }
        stagePhysical(target);
      }
    },
    onFrameSubmitted(
      completed = Promise.resolve({ ok: true, value: undefined } as const),
      receipt?: RenderTargetReadbackReceipt,
    ): void {
      if (disposed) return;
      const submittedReadbacks: ReadbackRecord[] = [];
      if (receipt !== undefined) snapshots.onFrameSubmitted(receipt, completed);
      if (receipt !== undefined) {
        for (const record of readbacks.values()) {
          if (record.status !== 'encoded') continue;
          const bound = bindRenderTargetReadbackTicket(record.ticket, receipt);
          if (!bound.ok) {
            report(bound.error);
            continue;
          }
          record.status = 'submitted';
          submittedReadbacks.push(record);
        }
      }
      const generation = currentGeneration();
      const submittedTargets = [...staged].flatMap((target) => {
        const physical = candidatePhysical.get(target);
        if (physical === undefined || !submittedPhysicals.has(physical)) return [];
        staged.delete(target);
        return [{ target, physical }];
      });
      const completeSubmission = (result: RenderResult<void, RenderError>) => {
        if (disposed || (submittedTargets.length === 0 && submittedReadbacks.length === 0)) return;
        const failures: RenderError[] = result.ok ? [] : [result.error];
        if (!result.ok) {
          for (const record of submittedReadbacks) {
            if (
              record.status !== 'submitted' ||
              record.ticket.frameId !== receipt?.frameId ||
              record.ticket.consumed
            )
              continue;
            record.status = 'pending';
            record.ticket.frameId = undefined;
          }
        }
        for (const { target, physical: submittedPhysical } of submittedTargets) {
          if (candidatePhysical.get(target) !== submittedPhysical) continue;
          const candidate = owner.inspect(target);
          if (!candidate.ok || candidate.value.candidate === undefined) continue;
          try {
            if (!result.ok) {
              owner.rejectCandidate(target, candidate.value.candidate.generation, 'submit');
              candidatePhysical.delete(target);
              releasePhysical(submittedPhysical, failures);
              continue;
            }
            // Keep progressive captures staged until their final matching face completes.
            if (options.canPromoteTarget?.(target) === false) {
              staged.add(target);
              continue;
            }
            if (submittedPhysical === undefined) {
              owner.rejectCandidate(target, candidate.value.candidate.generation, 'submit');
              continue;
            }
            const promoted = owner.promote(target, candidate.value.candidate.generation);
            if (!promoted.ok) {
              failures.push(promoted.error);
              candidatePhysical.delete(target);
              releasePhysical(submittedPhysical, failures);
              continue;
            }
            const previous = activePhysical.get(target);
            activePhysical.set(target, submittedPhysical);
            candidatePhysical.delete(target);
            releasePhysical(previous, failures);
          } catch (cause) {
            owner.rejectCandidate(target, candidate.value.candidate.generation, 'submit');
            candidatePhysical.delete(target);
            releasePhysical(submittedPhysical, failures);
            failures.push(
              new RenderTargetOperationFailedError({
                operation: 'create',
                stage: 'submit',
                generation,
                cause,
                recovery: 'retain-last-known-good',
              }),
            );
          }
        }
        for (const failure of failures) report(failure);
      };
      void completed.then(completeSubmission, (cause) =>
        completeSubmission({
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'create',
            stage: 'submit',
            generation,
            cause,
            recovery: 'retain-last-known-good',
          }),
        }),
      );
    },
    markTargetSubmitted,
    getPhysicalTarget(target: RenderTarget): RenderTargetPhysical | undefined {
      frameWriters.add(target);
      return candidatePhysical.get(target as object) ?? activePhysical.get(target as object);
    },
    encodePendingReadbacks(
      encoder: RhiCommandEncoder,
      written?: readonly RenderTargetLayerWrite[],
    ): void {
      for (const record of readbacks.values()) {
        if (record.status !== 'pending' || record.allocation === undefined) continue;
        const layer = record.ticket.layer ?? 0;
        const writtenHere =
          record.ticket.layer !== undefined &&
          (written?.some((write) => write.target === record.target && write.layer === layer) ??
            false);
        // A newly written face may use its candidate; every other face reads
        // the accepted complete target while progressive capture continues.
        const candidate = candidatePhysical.get(record.target as object);
        const physical =
          writtenHere && candidate !== undefined
            ? candidate
            : activePhysical.get(record.target as object);
        if (physical === undefined) continue;
        const source = physical.resolveTexture ?? physical.texture;
        encoder.copyTextureToBuffer(
          {
            texture: source,
            mipLevel: record.ticket.mipLevel,
            origin: { x: 0, y: 0, z: layer },
          },
          {
            buffer: record.allocation.buffer,
            bytesPerRow: record.ticket.bytesPerRow,
            rowsPerImage: record.ticket.height,
          },
          [record.ticket.width, record.ticket.height, 1],
        );
        record.status = 'encoded';
      }
    },
    recover(): void {
      if (disposed) return;
      const generation = currentGeneration();
      const failures: RenderError[] = [];
      for (const target of targets) {
        const inspected = owner.inspect(target);
        if (!inspected.ok || inspected.value.generation >= generation) continue;
        const begun = owner.beginRecovery(target, generation);
        if (!begun.ok) {
          failures.push(begun.error);
          continue;
        }
        failures.push(...releaseTarget(target));
        const finished = owner.finishRecovery(target);
        if (!finished.ok) failures.push(finished.error);
      }
      for (const failure of failures) report(failure);
    },
    dispose(): void {
      disposed = true;
      const failures: RenderError[] = [];
      for (const target of targets) {
        failures.push(...releaseTarget(target));
        const destroyed = owner.destroy(target);
        if (!destroyed.ok) failures.push(destroyed.error);
      }
      targets.clear();
      staged.clear();
      readbacks.clear();
      snapshots.clear();
      frameWriters.clear();
      for (const failure of failures) report(failure);
    },
  });
}
