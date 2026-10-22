import { mat4 } from '@forgeax/engine-math';
import { type Buffer, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { CapsuleShadowSnapshot } from '../capsule-shadow/world-capsules';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import type { SkinSceneFrame } from '../scene/skin-scene-inputs';

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'request Skin data only while recording the accepted fixed Scene/root pair',
  });
}
function limit(expected: string): never {
  throw new RhiError({
    code: 'limit-exceeded',
    expected,
    hint: 'keep actual Skin task storage and uniform windows within device limits',
  });
}
function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** Physical linear scratch. Growth preserves already encoded buffer identities;
 * it never rebases a recorded draw or copies an obsolete prefix.
 */
class TaskBuffer {
  buffer: Buffer | undefined;
  capacity = 0;
  private cursor = 0;
  private retired: Buffer[] | undefined = [];
  constructor(
    private readonly device: RhiDevice,
    private readonly usage: number,
    private readonly maximum: number,
    private readonly label: string,
  ) {}
  begin(): void {
    this.cursor = 0;
  }
  reserve(bytes: number, alignment: number): number {
    const retired = this.retired;
    if (retired === undefined) throw invalid('a live Skin task buffer');
    const offset = align(this.cursor, alignment),
      end = offset + bytes;
    if (!Number.isSafeInteger(end) || end > this.maximum)
      limit('the actual Skin task buffer fits the device allocation/binding limit');
    if (end > this.capacity) {
      let capacity = Math.min(this.maximum, Math.max(256, this.capacity));
      while (capacity < end) capacity = Math.min(this.maximum, align(capacity * 1.5, 256));
      const buffer = this.device
        .createBuffer({
          label: this.label,
          size: capacity,
          usage: this.usage | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap();
      const retiredLength = retired.length;
      try {
        if (this.buffer !== undefined) retired.push(this.buffer);
      } catch (cause) {
        retired.length = retiredLength;
        try {
          this.device.destroyBuffer(buffer).unwrap();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Skin task buffer growth rollback failed', {
            cause,
          });
        }
        throw cause;
      }
      this.buffer = buffer;
      this.capacity = capacity;
    }
    this.cursor = end;
    return offset;
  }
  retire(completed: Promise<void> | undefined, all = false): Promise<void> | undefined {
    const buffers = this.retired,
      device = this.device;
    if (buffers === undefined) return;
    const current = all ? this.buffer : undefined;
    if (all) {
      this.retired = undefined;
      this.buffer = undefined;
      this.capacity = 0;
    } else {
      if (buffers.length === 0) return;
      this.retired = [];
    }
    if (buffers.length === 0 && current === undefined) return;
    const release = () => {
      let failures: unknown[] | undefined;
      for (const buffer of buffers) {
        try {
          device.destroyBuffer(buffer).unwrap();
        } catch (cause) {
          failures ??= [];
          failures.push(cause);
        }
      }
      if (current !== undefined) {
        try {
          device.destroyBuffer(current).unwrap();
        } catch (cause) {
          failures ??= [];
          failures.push(cause);
        }
      }
      if (failures !== undefined)
        throw new AggregateError(failures, 'Skin task buffer retirement failed');
    };
    if (completed === undefined) {
      release();
      return;
    }
    return completed.then(release, release);
  }
}

/** Borrowed actual-demand output, valid until complete(). No Scene row stores
 * this address. Storage binds the full data buffer and a 16-byte header;
 * uniform mode binds a current 255-matrix/state window and previous matrices.
 */
export interface SkinTaskBinding {
  data: Buffer;
  auxiliary: Buffer;
  dataOffset: number;
  auxiliaryOffset: number;
  dataSize: number;
  auxiliarySize: number;
}

const POSE_UNAVAILABLE = Object.freeze({ status: 'pose-unavailable' as const });
const NO_CAPSULES = Object.freeze({ status: 'no-shadow-capsules' as const });

/** One concrete device and one pending recording. Deduplication belongs only to
 * actual CPU draw demand; no Binding freshness, vertex copies or retained pose
 * results survive a recording. Numeric source/history ownership stays in Scene.
 */
export class SkinTasks {
  /** Actual successful current/previous matrix writes in this recording; excludes task headers. */
  paletteUploadBytes = 0;
  private frame: SkinSceneFrame | undefined;
  private disposed = false;
  private readonly data: TaskBuffer;
  private readonly auxiliary: TaskBuffer;
  private readonly demanded = new Map<number, number>();
  private readonly rows: SkinTaskBinding[] = [];
  private count = 0;
  private readonly capsuleDemanded = new Map<number, CapsuleShadowSnapshot>();
  private readonly capsuleRows: {
    storage: Float32Array;
    state: { status: 'ready'; capsules: Float32Array };
  }[] = [];
  private capsuleRowsUsed = 0;
  private current = new Float32Array(0);
  private previous = new Float32Array(0);
  private readonly matrix = mat4.create();
  private readonly inverse = mat4.create();
  private readonly words = new Uint32Array(8);
  /** Last physical submission on this one device; an aborted recording keeps its fence. */
  private completion: Promise<void> | undefined;
  private readonly dataAlignment: number;
  private readonly auxiliaryAlignment: number;
  private readonly maxJoints: number;
  constructor(
    private readonly device: RhiDevice,
    readonly storage: boolean,
  ) {
    // Structural RHI carriers may omit optional limit observations; retain
    // portable floors while every reported physical limit remains authoritative.
    const maximum = Number(device.limits.maxBufferSize ?? 256 * 1024 * 1024);
    const binding = Number(
      storage
        ? (device.limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024)
        : (device.limits.maxUniformBufferBindingSize ?? 16384),
    );
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 16336 ||
      !Number.isSafeInteger(binding) ||
      binding < (storage ? 160 : 16336)
    )
      limit('qualified Skin task buffer limits');
    this.dataAlignment = storage
      ? 16
      : Number(device.limits.minUniformBufferOffsetAlignment ?? 256);
    this.auxiliaryAlignment = Number(device.limits.minUniformBufferOffsetAlignment ?? 256);
    if (!Number.isSafeInteger(this.auxiliaryAlignment) || this.auxiliaryAlignment < 1)
      throw invalid('the device uniform offset alignment');
    const dataLimit = storage ? Math.min(maximum, binding) : maximum;
    this.maxJoints = storage ? Math.floor((dataLimit - 32) / 128) : 255;
    this.data = new TaskBuffer(
      device,
      storage ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM,
      dataLimit,
      'skin-task-data',
    );
    this.auxiliary = new TaskBuffer(
      device,
      GPU_BUFFER_USAGE_UNIFORM,
      maximum,
      'skin-task-auxiliary',
    );
  }
  begin(frame: SkinSceneFrame): void {
    if (this.disposed || this.frame !== undefined) throw invalid('one live Skin task recording');
    this.frame = frame;
    this.paletteUploadBytes = 0;
    this.count = 0;
    this.capsuleRowsUsed = 0;
    this.capsuleDemanded.clear();
    this.demanded.clear();
    this.data.begin();
    this.auxiliary.begin();
  }
  demand(record: RenderSceneSlot): SkinTaskBinding | undefined {
    const slot = record.slot;
    const frame = this.frame;
    if (this.disposed || frame === undefined) throw invalid('a live Skin task recording');
    const selected = frame.slots.slotAt(slot);
    if (selected !== record || selected.snapshot.skinBinding === undefined)
      throw invalid('the true Scene slot of an admitted Skin Binding');
    const previousDemand = this.demanded.get(slot);
    if (previousDemand !== undefined)
      return previousDemand < 0 ? undefined : this.rows[previousDemand];
    const count = frame.current.jointCount(slot);
    if (count === undefined) {
      this.demanded.set(slot, -1);
      return undefined;
    }
    if (count > this.maxJoints)
      limit(
        this.storage
          ? 'Skin current/previous palettes fit the storage task'
          : 'uniform Skin demand has at most 255 joints',
      );
    if (this.current.length < count * 16) {
      const capacity = Math.min(this.maxJoints * 16, Math.max(count * 16, this.current.length * 2));
      const current = new Float32Array(capacity),
        previous = new Float32Array(capacity);
      this.current = current;
      this.previous = previous;
    }
    const flags = frame.current.palettes(
      slot,
      frame.previous,
      this.current,
      this.previous,
      this.matrix,
      this.inverse,
    );
    if (flags === 0) {
      this.demanded.set(slot, -1);
      return undefined;
    }
    const dataOffset = this.data.reserve(
      this.storage ? 32 + count * 128 : 16336,
      this.dataAlignment,
    );
    const auxiliaryOffset = this.auxiliary.reserve(
      this.storage ? 16 : 16320,
      this.auxiliaryAlignment,
    );
    const data = this.data.buffer,
      auxiliary = this.auxiliary.buffer;
    if (data === undefined || auxiliary === undefined) throw invalid('allocated Skin task buffers');
    const queue = this.device.queue;
    if (this.storage) {
      this.words[0] = slot + 1;
      this.words[1] = count;
      this.words[2] = dataOffset / 16 + 2;
      this.words[3] = flags;
      this.words[4] = 0;
      this.words[5] = 0;
      this.words[6] = 0;
      this.words[7] = 0;
      queue.writeBuffer(data, dataOffset, this.words.buffer, 0, 32).unwrap();
      queue.writeBuffer(data, dataOffset + 32, this.current.buffer, 0, count * 64).unwrap();
      this.paletteUploadBytes += count * 64;
      queue
        .writeBuffer(data, dataOffset + 32 + count * 64, this.previous.buffer, 0, count * 64)
        .unwrap();
      this.paletteUploadBytes += count * 64;
      this.words[0] = dataOffset / 16 + 1;
      this.words[1] = dataOffset / 16;
      this.words[2] = 0;
      this.words[3] = 0;
      queue.writeBuffer(auxiliary, auxiliaryOffset, this.words.buffer, 0, 16).unwrap();
    } else {
      queue.writeBuffer(data, dataOffset, this.current.buffer, 0, count * 64).unwrap();
      this.paletteUploadBytes += count * 64;
      this.words[0] = count;
      this.words[1] = flags;
      this.words[2] = 0;
      this.words[3] = 0;
      queue.writeBuffer(data, dataOffset + 255 * 64, this.words.buffer, 0, 16).unwrap();
      queue.writeBuffer(auxiliary, auxiliaryOffset, this.previous.buffer, 0, count * 64).unwrap();
      this.paletteUploadBytes += count * 64;
    }
    let row = this.rows[this.count];
    if (row === undefined) {
      row = {
        data,
        auxiliary,
        dataOffset: 0,
        auxiliaryOffset: 0,
        dataSize: 0,
        auxiliarySize: 0,
      };
      this.rows.push(row);
    }
    row.data = data;
    row.auxiliary = auxiliary;
    row.dataOffset = this.storage ? 0 : dataOffset;
    row.auxiliaryOffset = auxiliaryOffset;
    row.dataSize = this.storage ? this.data.capacity : 16336;
    row.auxiliarySize = this.storage ? 16 : 16320;
    this.demanded.set(slot, this.count++);
    return row;
  }
  /** Actual capsule task scratch, scoped to the same fixed Scene/root pair. */
  capsules(record: RenderSceneSlot): CapsuleShadowSnapshot {
    const frame = this.frame,
      slot = record.slot;
    if (this.disposed || frame === undefined || frame.slots.slotAt(slot) !== record)
      throw invalid('the actual capsule task belongs to this fixed Skin frame');
    const known = this.capsuleDemanded.get(slot);
    if (known !== undefined) return known;
    const count = frame.current.capsuleCount(slot);
    let state: CapsuleShadowSnapshot;
    if (!frame.current.available(slot)) state = POSE_UNAVAILABLE;
    else if (count === undefined || count === 0) state = NO_CAPSULES;
    else {
      let row = this.capsuleRows[this.capsuleRowsUsed];
      if (row === undefined) {
        const storage = new Float32Array(count * 8);
        row = { storage, state: { status: 'ready', capsules: storage } };
        this.capsuleRows.push(row);
      } else if (row.storage.length < count * 8) {
        row.storage = new Float32Array(count * 8);
      }
      if (
        row.state.capsules.buffer !== row.storage.buffer ||
        row.state.capsules.length !== count * 8
      )
        row.state.capsules =
          row.storage.length === count * 8 ? row.storage : row.storage.subarray(0, count * 8);
      if (!frame.current.capsules(slot, row.state.capsules, this.matrix, this.inverse))
        state = POSE_UNAVAILABLE;
      else {
        this.capsuleRowsUsed++;
        state = row.state;
      }
    }
    this.capsuleDemanded.set(slot, state);
    return state;
  }
  /** Called at physical submission, before callbacks can retire this owner. */
  trackSubmittedWork(completed: Promise<void>): void {
    this.completion = completed;
  }
  private retireBuffers(all: boolean): Promise<void> | undefined {
    let pending: Promise<void>[] | undefined, failures: unknown[] | undefined;
    for (let index = 0; index < 2; index++) {
      try {
        const retired = (index === 0 ? this.data : this.auxiliary).retire(this.completion, all);
        if (retired !== undefined) {
          pending ??= [];
          pending.push(retired);
        }
      } catch (cause) {
        failures ??= [];
        failures.push(cause);
      }
    }
    if (pending === undefined) {
      if (failures !== undefined) throw new AggregateError(failures, 'Skin task retirement failed');
      return;
    }
    return Promise.allSettled(pending).then((results) => {
      for (const result of results)
        if (result.status === 'rejected') {
          failures ??= [];
          failures.push(result.reason);
        }
      if (failures !== undefined) throw new AggregateError(failures, 'Skin task retirement failed');
    });
  }
  complete(): Promise<void> | undefined {
    if (this.frame === undefined) return;
    this.frame = undefined;
    this.capsuleDemanded.clear();
    this.demanded.clear();
    return this.retireBuffers(this.disposed);
  }
  dispose(): Promise<void> | undefined {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) return;
    return this.retireBuffers(true);
  }
}
