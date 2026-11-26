import {
  type Buffer,
  err,
  type MappedBuffer,
  ok,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';

/** Spec normative GPUMapMode bits (research §4.2 step 7). */
const MAP_MODE_READ = 0x1;
const MAP_MODE_WRITE = 0x2;
/** GPUBufferUsage MAP_READ / MAP_WRITE bits (research §4.2 step 9 / F-8 row 3). */
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_MAP_WRITE = 0x0002;

function rangeError(args: { expected: string; hint: string }): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: args.expected,
      hint: args.hint,
    }),
  );
}

/** The WebGPU handle owns its physical buffer, validation facts and lifecycle. */
export class WebGpuBuffer
  implements Pick<MappedBuffer, 'mapState' | 'mapAsync' | 'getMappedRange' | 'unmap'>
{
  readonly #raw: GPUBuffer;
  readonly #size: number;
  readonly #usage: GPUBufferUsageFlags;
  #destroyed = false;
  #knownUnmapped = false;

  constructor(raw: GPUBuffer, size: number, usage: GPUBufferUsageFlags) {
    this.#raw = raw;
    this.#size = size;
    this.#usage = usage;
  }

  static native(handle: Buffer): GPUBuffer {
    return isObject(handle) && #raw in handle ? handle.#raw : (handle as unknown as GPUBuffer);
  }

  static size(handle: Buffer): number | undefined {
    return isObject(handle) && #raw in handle ? handle.#size : undefined;
  }

  static usage(handle: Buffer): number | undefined {
    return isObject(handle) && #raw in handle ? handle.#usage : undefined;
  }

  static destroy(handle: Buffer): Result<void, RhiError> {
    if (!isObject(handle) || !(#raw in handle)) return ok(undefined);
    if (handle.#destroyed)
      return err(
        new RhiError({
          code: 'destroy-after-destroy',
          expected: 'GPU buffer handle has not been destroyed yet',
          hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
        }),
      );
    try {
      if (typeof handle.#raw.destroy === 'function') handle.#raw.destroy();
    } catch (error) {
      return rangeError({
        expected: 'underlying GPUBuffer.destroy() to succeed',
        hint: `destroy raised: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    handle.#destroyed = true;
    return ok(undefined);
  }

  // A native read is needed after mapping starts or while it remains active.
  get mapState(): Buffer['mapState'] {
    if (this.#knownUnmapped) return 'unmapped';
    const state = this.#raw.mapState;
    if (state === 'unmapped') this.#knownUnmapped = true;
    return state;
  }

  // Mapping callbacks remain callable when borrowed from their owning handle.
  readonly mapAsync = async (
    mode: GPUMapModeFlags,
    offset?: number | undefined,
    sizeArg?: number | undefined,
  ): Promise<Result<MappedBuffer, RhiError>> => {
    const size = this.#size,
      usage = this.#usage;
    // F-8 row 1: mapState must be 'unmapped' (research §4.2 step 1).
    const cur = this.mapState;
    if (cur !== 'unmapped') {
      return rangeError({
        expected: 'buffer.mapState === "unmapped" before mapAsync',
        hint: `got mapState=${cur}; call buffer.unmap() before mapAsync, or wait for the previous mapAsync to settle`,
      });
    }
    const off = offset ?? 0;
    const rangeSize = sizeArg === undefined ? Math.max(0, size - off) : sizeArg;
    // step 4: offset % 8 == 0
    if (off % 8 !== 0) {
      return rangeError({
        expected: 'mapAsync offset % 8 == 0 (spec normative)',
        hint: `got offset=${off}; align offset to 8 bytes`,
      });
    }
    // step 5: rangeSize % 4 == 0
    if (rangeSize % 4 !== 0) {
      return rangeError({
        expected: 'mapAsync rangeSize % 4 == 0 (spec normative)',
        hint: `got rangeSize=${rangeSize}; align rangeSize to 4 bytes`,
      });
    }
    // step 6: offset + rangeSize <= size
    if (off + rangeSize > size) {
      return rangeError({
        expected: 'mapAsync offset + rangeSize <= buffer.size',
        hint: `got offset=${off}, rangeSize=${rangeSize}; buffer.size=${size}`,
      });
    }
    // step 7: mode contains only allowed bits
    const allowed = MAP_MODE_READ | MAP_MODE_WRITE;
    if ((mode & ~allowed) !== 0) {
      return rangeError({
        expected: 'mapAsync mode contains only READ or WRITE bits',
        hint: `got mode=0x${mode.toString(16)}; pass GPUMapMode.READ (0x1) or GPUMapMode.WRITE (0x2)`,
      });
    }
    // step 8: mode is exactly READ or WRITE (not both)
    if (mode !== MAP_MODE_READ && mode !== MAP_MODE_WRITE) {
      return rangeError({
        expected: 'mapAsync mode is exactly one of READ | WRITE (not both)',
        hint: `got mode=0x${mode.toString(16)}; pass GPUMapMode.READ (0x1) or GPUMapMode.WRITE (0x2), not the OR-combined mask`,
      });
    }
    // step 9: mode-usage cross-check (F-8 row 3)
    if ((mode & MAP_MODE_READ) !== 0 && (usage & BUFFER_USAGE_MAP_READ) === 0) {
      return rangeError({
        expected: 'mapAsync mode READ requires buffer.usage to contain MAP_READ',
        hint: `got mode=READ, buffer.usage=0x${usage.toString(16)}; create buffer with GPUBufferUsage.MAP_READ`,
      });
    }
    if ((mode & MAP_MODE_WRITE) !== 0 && (usage & BUFFER_USAGE_MAP_WRITE) === 0) {
      return rangeError({
        expected: 'mapAsync mode WRITE requires buffer.usage to contain MAP_WRITE',
        hint: `got mode=WRITE, buffer.usage=0x${usage.toString(16)}; create buffer with GPUBufferUsage.MAP_WRITE`,
      });
    }
    // Delegate to raw GPUBuffer; raw rejection wraps as webgpu-runtime-error.
    this.#knownUnmapped = false;
    try {
      if (sizeArg === undefined && offset === undefined) {
        await this.#raw.mapAsync(mode);
      } else if (sizeArg === undefined) {
        await this.#raw.mapAsync(mode, off);
      } else {
        await this.#raw.mapAsync(mode, off, sizeArg);
      }
      // D-P2 #6: the structural wrapper carries both Buffer + MappedBuffer
      // members; on the success path we surface the same JS object typed as
      // the branded MappedBuffer (charter proposition 5: brand is structural,
      // no runtime cost).
      return ok(this as unknown as MappedBuffer);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return rangeError({
        expected: 'underlying GPUBuffer.mapAsync to succeed',
        hint: `mapAsync raised: ${message}`,
      });
    }
  };

  readonly getMappedRange = (
    offset?: number | undefined,
    sizeArg?: number | undefined,
  ): Result<ArrayBuffer, RhiError> => {
    // F-8 row 2 detach guard: mapState must be 'mapped'.
    const cur = this.mapState;
    if (cur !== 'mapped') {
      return rangeError({
        expected: 'buffer.mapState === "mapped" before getMappedRange',
        hint: 'call buffer.mapAsync(MODE) and await it before getMappedRange',
      });
    }
    try {
      if (typeof this.#raw.getMappedRange !== 'function') {
        return rangeError({
          expected: 'underlying GPUBuffer.getMappedRange to be available',
          hint: 'mock or driver does not expose getMappedRange; use a real GPUBuffer',
        });
      }
      const view =
        sizeArg === undefined
          ? offset === undefined
            ? this.#raw.getMappedRange()
            : this.#raw.getMappedRange(offset)
          : this.#raw.getMappedRange(offset ?? 0, sizeArg);
      return ok(view);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return rangeError({
        expected: 'underlying GPUBuffer.getMappedRange to succeed',
        hint: `getMappedRange raised: ${message}`,
      });
    }
  };

  readonly unmap = (): void => {
    // Spec normative silent no-op (research §4.4): unmap on a destroyed or
    // already-unmapped buffer must NOT throw / return an error.
    try {
      if (typeof this.#raw.unmap === 'function') {
        this.#raw.unmap();
      }
    } catch {
      // swallow per spec; the forgeax form does not surface unmap failures.
    }
  };
}

function isObject(handle: Buffer): boolean {
  return typeof handle === 'object' && handle !== null;
}
