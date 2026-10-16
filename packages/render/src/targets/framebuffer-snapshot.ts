import type { RhiCommandEncoder, Texture, TextureFormat } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import {
  FramebufferSnapshotFailedError,
  type FramebufferSnapshotFailureReason,
  RenderTargetStateInvalidError,
} from '../errors/render';
import type { RenderResult } from '../render-contract';
import type {
  FramebufferSnapshotData,
  FramebufferSnapshotRegion,
  FramebufferSnapshotRequest,
  FramebufferSnapshotTicket,
  RenderTarget,
  RenderTargetDescriptor,
} from './contracts';
import type { RenderTargetOwner } from './owner';
import type { RenderTargetPhysical } from './physical';
import type { RenderTargetReadbackReceipt } from './readback';

/** The linear-HDR scene color a Standard graph offers after scene features. */
export interface FramebufferSnapshotSource {
  readonly texture: Texture;
  readonly format: TextureFormat;
  readonly width: number;
  readonly height: number;
  readonly camera: number | undefined;
  /** `display` is the single-camera frame; `view` is one CameraView of a composite frame. */
  readonly role: 'display' | 'view';
}

type Point = { readonly x: number; readonly y: number };

interface SnapshotRecord {
  readonly target: RenderTarget;
  readonly region: FramebufferSnapshotRegion;
  readonly destination: Point;
  readonly camera: number | undefined;
  readonly generation: number;
  status: 'pending' | 'encoded' | 'rejected' | 'submitted' | 'failed';
  frameId?: number;
  physical?: RenderTargetPhysical;
  sourceExtent?: { readonly width: number; readonly height: number };
  error?: RenderError;
  completed?: Promise<RenderResult<void, RenderError>>;
}

export interface FramebufferSnapshotQueueOptions {
  readonly owner: RenderTargetOwner;
  readonly currentGeneration: () => number;
  /** Physical the next write lands in: the staged candidate, else the active texture. */
  readonly writablePhysical: (target: RenderTarget) => RenderTargetPhysical | undefined;
  readonly activePhysical: (target: RenderTarget) => RenderTargetPhysical | undefined;
  /** True when a camera, capture or CameraView writer resolved the target this frame. */
  readonly claimedByWriter: (target: RenderTarget) => boolean;
  /** Record an accepted write so a staged candidate is promoted after completion. */
  readonly markWritten: (target: RenderTarget, physical: RenderTargetPhysical) => void;
}

export interface FramebufferSnapshotQueue {
  request(
    target: RenderTarget,
    request: FramebufferSnapshotRequest,
  ): RenderResult<FramebufferSnapshotTicket, RenderError>;
  encode(encoder: RhiCommandEncoder, source: FramebufferSnapshotSource): void;
  beginFrame(): void;
  onFrameSubmitted(
    receipt: RenderTargetReadbackReceipt,
    completed: Promise<RenderResult<void, RenderError>>,
  ): void;
  observe(
    receipt: RenderTargetReadbackReceipt,
    tickets: readonly FramebufferSnapshotTicket[],
  ): Promise<RenderResult<readonly FramebufferSnapshotData[], RenderError>>;
  release(target: RenderTarget): void;
  clear(): void;
}

function failure(
  reason: FramebufferSnapshotFailureReason,
  expected: string,
  actual: unknown,
  frameId?: number,
): FramebufferSnapshotFailedError {
  return new FramebufferSnapshotFailedError({
    reason,
    expected,
    actual,
    ...(frameId === undefined ? {} : { frameId }),
  });
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function fits(
  origin: Point,
  region: FramebufferSnapshotRegion,
  extent: { readonly width: number; readonly height: number },
): boolean {
  return origin.x + region.width <= extent.width && origin.y + region.height <= extent.height;
}

function compatible(descriptor: RenderTargetDescriptor): boolean {
  return (
    descriptor.shape === '2d' &&
    descriptor.format === 'rgba16float' &&
    descriptor.sampleCount === 1 &&
    descriptor.mipLevels === 1
  );
}

export function createFramebufferSnapshotQueue(
  options: FramebufferSnapshotQueueOptions,
): FramebufferSnapshotQueue {
  const records = new Map<FramebufferSnapshotTicket, SnapshotRecord>();
  const reject = (record: SnapshotRecord, error: RenderError) => {
    record.status = 'rejected';
    record.error = error;
  };
  const stateInvalid = (
    reason: 'foreign-renderer' | 'destroyed' | 'generation-mismatch',
    generation: number,
  ): RenderTargetStateInvalidError =>
    new RenderTargetStateInvalidError({
      operation: 'snapshot',
      reason,
      state: reason === 'generation-mismatch' ? 'active' : 'destroyed',
      generation,
    });

  return {
    request(target, request) {
      const { region } = request;
      const destination = request.destination ?? { x: 0, y: 0 };
      if (
        typeof region !== 'object' ||
        region === null ||
        !nonNegativeInteger(region.x) ||
        !nonNegativeInteger(region.y) ||
        !nonNegativeInteger(region.width) ||
        !nonNegativeInteger(region.height) ||
        region.width < 1 ||
        region.height < 1 ||
        !nonNegativeInteger(destination.x) ||
        !nonNegativeInteger(destination.y) ||
        (request.camera !== undefined && !nonNegativeInteger(request.camera))
      ) {
        return {
          ok: false,
          error: failure(
            'request-invalid',
            'integer region x/y >= 0, width/height >= 1, destination x/y >= 0, camera entity key',
            { region, destination, camera: request.camera },
          ),
        };
      }
      const inspected = options.owner.inspect(target);
      if (!inspected.ok) return inspected;
      const descriptor = inspected.value.candidate?.descriptor ?? inspected.value.descriptor;
      if (!compatible(descriptor)) {
        return {
          ok: false,
          error: failure('target-incompatible', '2d rgba16float, sampleCount 1, mipLevels 1', {
            shape: descriptor.shape,
            format: descriptor.format,
            sampleCount: descriptor.sampleCount,
            mipLevels: descriptor.mipLevels,
          }),
        };
      }
      if (!fits(destination, region, descriptor)) {
        return {
          ok: false,
          error: failure(
            'destination-out-of-bounds',
            `destination + region <= ${descriptor.width}x${descriptor.height}`,
            { destination, region },
          ),
        };
      }
      for (const record of records.values()) {
        if (record.target === target && record.status !== 'submitted' && record.status !== 'failed')
          return {
            ok: false,
            error: failure(
              'writer-conflict',
              'one pending snapshot per target',
              'pending snapshot',
            ),
          };
      }
      const ticket = Object.freeze({}) as FramebufferSnapshotTicket;
      records.set(ticket, {
        target,
        region: Object.freeze({ ...region }),
        destination: Object.freeze({ x: destination.x, y: destination.y }),
        camera: request.camera,
        generation: options.currentGeneration(),
        status: 'pending',
      });
      return { ok: true, value: ticket };
    },
    encode(encoder, source) {
      for (const record of records.values()) {
        if (record.status !== 'pending') continue;
        if (
          record.camera === undefined ? source.role !== 'display' : record.camera !== source.camera
        )
          continue;
        if (record.generation !== options.currentGeneration()) {
          reject(record, stateInvalid('generation-mismatch', options.currentGeneration()));
          continue;
        }
        if (source.format !== 'rgba16float') {
          reject(
            record,
            failure('source-unavailable', 'rgba16float linear-HDR scene color', source.format),
          );
          continue;
        }
        if (!fits(record.region, record.region, source)) {
          reject(
            record,
            failure('source-out-of-bounds', 'region inside the scene-color extent', {
              width: source.width,
              height: source.height,
            }),
          );
          continue;
        }
        if (options.claimedByWriter(record.target)) {
          reject(
            record,
            failure(
              'writer-conflict',
              'no camera or capture writes the target in the same frame',
              'camera writer',
            ),
          );
          continue;
        }
        const physical = options.writablePhysical(record.target);
        if (physical === undefined || !compatible(physical.descriptor)) {
          reject(
            record,
            failure('destination-invalidated', 'a compatible physical target', undefined),
          );
          continue;
        }
        if (!fits(record.destination, record.region, physical.descriptor)) {
          reject(
            record,
            failure(
              'destination-out-of-bounds',
              `destination + region <= ${physical.descriptor.width}x${physical.descriptor.height}`,
              { destination: record.destination, region: record.region },
            ),
          );
          continue;
        }
        encoder.copyTextureToTexture(
          {
            texture: source.texture as never,
            mipLevel: 0,
            origin: { x: record.region.x, y: record.region.y, z: 0 },
          },
          {
            texture: physical.texture as never,
            mipLevel: 0,
            origin: { x: record.destination.x, y: record.destination.y, z: 0 },
          },
          { width: record.region.width, height: record.region.height, depthOrArrayLayers: 1 },
        );
        record.status = 'encoded';
        record.physical = physical;
        record.sourceExtent = { width: source.width, height: source.height };
      }
    },
    beginFrame() {
      for (const record of records.values()) {
        if (record.status !== 'encoded' && record.status !== 'rejected') continue;
        record.status = 'pending';
        delete record.error;
        delete record.physical;
        delete record.sourceExtent;
      }
    },
    onFrameSubmitted(receipt, completed) {
      for (const record of records.values()) {
        if (record.status === 'submitted' || record.status === 'failed') continue;
        record.frameId = receipt.frameId;
        if (record.status === 'encoded' && record.physical !== undefined) {
          options.markWritten(record.target, record.physical);
          record.status = 'submitted';
          record.completed = completed;
          continue;
        }
        record.status = 'failed';
        record.error ??= failure(
          'source-unavailable',
          record.camera === undefined
            ? 'a single-camera frame with Standard scene color'
            : `camera ${record.camera} rendering Standard scene color in this frame`,
          { camera: record.camera },
          receipt.frameId,
        );
      }
    },
    async observe(receipt, tickets) {
      const results: FramebufferSnapshotData[] = [];
      for (const ticket of tickets) {
        const record = records.get(ticket);
        if (record === undefined)
          return { ok: false, error: stateInvalid('foreign-renderer', receipt.deviceGeneration) };
        if (
          record.frameId !== receipt.frameId ||
          record.generation !== receipt.deviceGeneration ||
          (record.status !== 'submitted' && record.status !== 'failed')
        ) {
          return {
            ok: false,
            error: stateInvalid('generation-mismatch', receipt.deviceGeneration),
          };
        }
        records.delete(ticket);
        if (record.status === 'failed') {
          return {
            ok: false,
            error: record.error ?? failure('source-unavailable', 'an encoded snapshot', undefined),
          };
        }
        const completion = await (record.completed ??
          Promise.resolve({ ok: true, value: undefined } as const));
        if (!completion.ok) return completion;
        const inspected = options.owner.inspect(record.target);
        if (!inspected.ok) return inspected;
        if (
          options.currentGeneration() !== record.generation ||
          options.activePhysical(record.target) !== record.physical
        ) {
          return {
            ok: false,
            error: failure(
              'destination-invalidated',
              'the written physical target is still active',
              inspected.value.state,
              receipt.frameId,
            ),
          };
        }
        results.push({
          ticket,
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          camera: record.camera,
          region: record.region,
          destination: record.destination,
          sourceExtent: record.sourceExtent ?? { width: 0, height: 0 },
        });
      }
      return { ok: true, value: Object.freeze(results) };
    },
    release(target) {
      for (const [ticket, record] of records) if (record.target === target) records.delete(ticket);
    },
    clear() {
      records.clear();
    },
  };
}
