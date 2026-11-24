import { ok } from '@forgeax/engine-types';
import { createIndexAllocator, type IndexRun } from './index-allocator';
import { rayReferenceFailure } from './scene';
import { type SdfSurfaceCoverage, sdfSurfaceCoveragePattern } from './sdf-surface-coverage';

interface Payload {
  readonly key: string;
  readonly run: IndexRun;
  references: number;
}

/** Shared with WGSL and the generated native parity layout; not a second wire schema. */
export const WORLD_ACCELERATION_TABLE_LAYOUT = { rowWords: 4, modeBits: 2 } as const;

export interface WorldAccelerationCoverage {
  readonly mode: 0 | 1 | 2;
  readonly primitives: number;
  readonly firstWord: number;
  readonly payload: Payload | undefined;
}

/** Three affine rows and one state vector per traced row. */
export const WORLD_ACCELERATION_MOTION_ROW_WORDS = 16;

export function worldAccelerationMotionStart(instances: number, triangles: number): number {
  const words = WORLD_ACCELERATION_TABLE_LAYOUT.rowWords;
  return (instances + 1) * words + Math.ceil(triangles / words) * words;
}

/** The motion rows follow the padded coverage capacity, with no second GPU binding. */
export function worldAccelerationTableWords(instances: number, triangles: number): number {
  return (
    worldAccelerationMotionStart(instances, triangles) +
    instances * WORLD_ACCELERATION_MOTION_ROW_WORDS
  );
}

/** Content reuse inside one acceleration owner. The table is the only retained bitmap image. */
export function createWorldAccelerationCoverage(
  table: Uint32Array,
  firstWord: number,
  capacity: number,
) {
  const allocator = createIndexAllocator(capacity);
  const payloads = new Map<string, Payload>();
  const dirty = new Set<Payload>();
  let words = 0;
  return {
    get words() {
      return words;
    },
    acquire(geometry: number, primitives: number, coverage: SdfSurfaceCoverage | undefined) {
      const checked = sdfSurfaceCoveragePattern(coverage, primitives);
      if (!checked.ok) return checked;
      const { mode, bits } = checked.value;
      if (bits === undefined)
        return ok<WorldAccelerationCoverage>({
          mode,
          primitives,
          firstWord: 0,
          payload: undefined,
        });
      const key = `${geometry}:${bits.join(',')}`;
      let payload = payloads.get(key);
      if (payload === undefined) {
        const run = allocator.allocate(bits.length);
        if (run === undefined)
          return rayReferenceFailure('world acceleration exceeds its coverage word budget', true);
        payload = { key, run, references: 0 };
        // Copy the accepted source before it can be mutated by its caller.
        table.set(bits, firstWord + run.first);
        payloads.set(key, payload);
        dirty.add(payload);
        words += bits.length;
      }
      payload.references++;
      return ok<WorldAccelerationCoverage>({
        mode,
        primitives,
        firstWord: firstWord + payload.run.first,
        payload,
      });
    },
    release(coverage: WorldAccelerationCoverage) {
      const payload = coverage.payload;
      if (payload === undefined || --payload.references !== 0) return;
      payloads.delete(payload.key);
      dirty.delete(payload);
      allocator.free(payload.run);
      words -= payload.run.end - payload.run.first;
    },
    /** Recovery replaces the GPU buffer, so every still-owned immutable payload is dirty. */
    recover() {
      for (const payload of payloads.values()) dirty.add(payload);
    },
    pending() {
      return [...dirty].map((payload) => ({
        firstWord: firstWord + payload.run.first,
        data: table.subarray(firstWord + payload.run.first, firstWord + payload.run.end),
      }));
    },
    committed() {
      dirty.clear();
    },
  };
}
