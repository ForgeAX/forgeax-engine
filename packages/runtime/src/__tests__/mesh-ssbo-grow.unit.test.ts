// M1: ceiling derivation TDD (AC-01 + plan-strategy D-1).
//
// Pure helper deriveStorageBufferCeiling exports a non-zero ceiling for every
// legal limits input, even when maxStorageBufferBindingSize is 0 / undefined
// (WebKit downlevel_webgl2_defaults). The grow controller's growMeshSsbo
// closure delegates ceiling derivation to this helper so unit tests can
// exercise the derivation logic directly without a real device.
//
// Test distribution:
//   1. maxStorageBufferBindingSize === 0     -> derived ceiling != 0
//   2. maxStorageBufferBindingSize === undefined -> derived ceiling != 0
//   3. non-zero ceiling, request fits         -> grow ok, no error (happy path)
//   4. all limits zero (R-1 extreme)          -> falls to spec floor 128 MiB
//   5. absent field (R-1 edge)                -> still non-zero

import type { Buffer } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  createMeshSsboGrowController,
  deriveStorageBufferCeiling,
  type MeshSsboGrowControllerInit,
  type MeshSsboGrowErrorRegistry,
} from '../../../render/src/assembly/factory';

// ---------------------------------------------------------------------------
// Stubs (mirror createRenderer.unit.test.ts pattern — minimal device fake)
// ---------------------------------------------------------------------------

const DUMMY_BUFFER = {
  destroy: () => {},
  size: 0,
  usage: 0,
} as unknown as Buffer;

function makeDevice(limits: {
  maxStorageBufferBindingSize: number;
}): NonNullable<MeshSsboGrowControllerInit['device']> {
  return {
    limits,
    createBuffer: () => DUMMY_BUFFER,
  };
}

function makeSpyErrorRegistry(): MeshSsboGrowErrorRegistry & {
  fireCount: number;
  lastCode: string | null;
} {
  let fireCount = 0;
  let lastCode: string | null = null;
  const self = {
    fire(e: { code: string }) {
      fireCount += 1;
      lastCode = e.code;
    },
  } as MeshSsboGrowErrorRegistry & { fireCount: number; lastCode: string | null };
  Object.defineProperty(self, 'fireCount', {
    get: () => fireCount,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(self, 'lastCode', {
    get: () => lastCode,
    enumerable: true,
    configurable: true,
  });
  return self;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveStorageBufferCeiling (M1 AC-01 ceiling derivation)', () => {
  it('Case 1: maxStorageBufferBindingSize === 0 → derived ceiling is non-zero (128 MiB spec floor)', () => {
    const ceiling = deriveStorageBufferCeiling({ maxStorageBufferBindingSize: 0 });
    expect(ceiling).toBeGreaterThan(0);
    // Default fallback to WebGPU spec floor: 134217728 (128 MiB).
    expect(ceiling).toBe(134217728);
  });

  it('Case 2: maxStorageBufferBindingSize === undefined → derived ceiling is non-zero (128 MiB spec floor)', () => {
    const ceiling = deriveStorageBufferCeiling({});
    expect(ceiling).toBeGreaterThan(0);
    expect(ceiling).toBe(134217728);
  });

  it('Case 3: non-zero maxStorageBufferBindingSize → respect the reported limit verbatim', () => {
    const ceiling = deriveStorageBufferCeiling({ maxStorageBufferBindingSize: 268435456 }); // 256 MiB
    expect(ceiling).toBe(268435456);
  });

  it('Case 4: maxBufferSize > 0 but maxStorageBufferBindingSize === 0 → prefer maxBufferSize over spec floor', () => {
    // Plan D-1: prefer device's other limits before falling to spec floor.
    const ceiling = deriveStorageBufferCeiling({
      maxStorageBufferBindingSize: 0,
      maxBufferSize: 16777216, // 16 MiB
    });
    // 16 MiB > 0; falls to maxBufferSize since maxStorageBufferBindingSize is 0.
    expect(ceiling).toBe(16777216);
  });

  it('Case 5: all limits 0 → falls to spec floor 128 MiB (R-1 extreme guard)', () => {
    const ceiling = deriveStorageBufferCeiling({
      maxStorageBufferBindingSize: 0,
      maxBufferSize: 0,
      maxUniformBufferBindingSize: 0,
    });
    expect(ceiling).toBe(134217728);
  });

  it('Case 6: maxUniformBufferBindingSize fallback when maxStorageBufferBindingSize === 0 and maxBufferSize unavailable', () => {
    const ceiling = deriveStorageBufferCeiling({
      maxStorageBufferBindingSize: 0,
      maxUniformBufferBindingSize: 65536,
    });
    expect(ceiling).toBe(65536);
  });
});

describe('growMeshSsbo with ceiling derivation (M1 integration)', () => {
  it('happy path: non-zero maxStorageBufferBindingSize + request fits → grow ok', () => {
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      device: makeDevice({ maxStorageBufferBindingSize: 134217728 }), // 128 MiB
      errorRegistry: spy,
      initialSlotCount: 1,
      materialStride: 256,
      meshUsage: 0,
      materialUsage: 0,
    });
    // Request 1024 slots = 1024 * 256 = 262144 bytes, well under 128 MiB.
    const result = ctrl.growMeshSsbo(1024, 1024);
    expect(result.ok).toBe(true);
    expect(spy.fireCount).toBe(0);
  });

  it('ceiling=0 (WebKit downlevel) + moderate request → derived ceiling used, grow ok', () => {
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      device: makeDevice({ maxStorageBufferBindingSize: 0 }), // WebKit
      errorRegistry: spy,
      initialSlotCount: 1,
      materialStride: 256,
      meshUsage: 0,
      materialUsage: 0,
    });
    // Request 4096 slots = 4096 * 256 = 1 MiB < spec floor 128 MiB → fits.
    const result = ctrl.growMeshSsbo(4096, 4096);
    expect(result.ok).toBe(true);
    expect(spy.fireCount).toBe(0);
  });

  it('ceiling=0 + request exceeds derived ceiling → ceiling-reached error (derived ceiling in effect)', () => {
    // Force a low derived ceiling to trigger the error path without needing
    // a real device that reports a tiny limit.
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      device: makeDevice({ maxStorageBufferBindingSize: 0 }), // 0 triggers derivation
      errorRegistry: spy,
      initialSlotCount: 1,
      materialStride: 256,
      meshUsage: 0,
      materialUsage: 0,
    });
    const MAX_SLOTS = Math.floor(134217728 / 256) + 1; // just beyond spec floor
    const result = ctrl.growMeshSsbo(MAX_SLOTS, MAX_SLOTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('mesh-ssbo-ceiling-reached');
    }
    expect(spy.fireCount).toBe(1);
    expect(spy.lastCode).toBe('mesh-ssbo-ceiling-reached');
  });

  it('ceiling=undefined + moderate request → derived ceiling used, grow ok', () => {
    // Though device limits always has maxStorageBufferBindingSize in reality,
    // test the derivation guard treats undefined the same as 0.
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      // The init type requires maxStorageBufferBindingSize: number, so we
      // test undefined via the pure helper; integration test with 0 covers
      // the grow path. (The device interface is typed strictly to match
      // real device.limits which always has the field.)
      device: makeDevice({ maxStorageBufferBindingSize: 0 }),
      errorRegistry: spy,
      initialSlotCount: 1,
      materialStride: 256,
      meshUsage: 0,
      materialUsage: 0,
    });
    const result = ctrl.growMeshSsbo(512, 512);
    expect(result.ok).toBe(true);
    expect(spy.fireCount).toBe(0);
  });
});

// ── M2: graceful degradation (degradedToSlotCount) ───────────────────────
describe('growMeshSsbo degradedToSlotCount (M2 AC-02/AC-03)', () => {
  it('ceiling-reached returns degradedToSlotCount === pre-grow capacity', () => {
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      device: makeDevice({ maxStorageBufferBindingSize: 0 }),
      errorRegistry: spy,
      initialSlotCount: 1,
      materialStride: 256,
      meshUsage: 0,
      materialUsage: 0,
    });
    ctrl.initialBuild();
    expect(ctrl.state.meshSlotCount).toBe(1);
    // Spec floor 134217728 / 256 = 524288; request 524289 exceeds.
    const beyondCeiling = Math.floor(134217728 / 256) + 1;
    const result = ctrl.growMeshSsbo(beyondCeiling, beyondCeiling);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('mesh-ssbo-ceiling-reached');
      expect(result.degradedTo.meshSlotCount).toBe(1);
    }
    expect(spy.fireCount).toBe(1);
  });

  it('grow fail carries pre-grow slotCount as degradedToSlotCount', () => {
    const spy = makeSpyErrorRegistry();
    const smallCeiling = 256 * 256;
    const ctrl = createMeshSsboGrowController({
      device: makeDevice({ maxStorageBufferBindingSize: smallCeiling }),
      errorRegistry: spy,
      initialSlotCount: 1,
      materialStride: 256,
      meshUsage: 0,
      materialUsage: 0,
    });
    ctrl.initialBuild();
    const result1 = ctrl.growMeshSsbo(256, 256);
    expect(result1.ok).toBe(true);
    expect(ctrl.state.meshSlotCount).toBe(256);
    // Request 1024 slots = 262144 B > 65536 B ceiling.
    const result2 = ctrl.growMeshSsbo(1024, 1024);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.degradedTo.meshSlotCount).toBe(256);
    }
  });
});

describe('growMeshSsbo non-power-of-two slot ceiling', () => {
  const ceiling = 134217728;
  const stride = 1280;
  const maxSlots = Math.floor(ceiling / stride);

  it('fits 100000 material-stride slots without allocating power-of-two headroom past the limit', () => {
    const sizes: number[] = [];
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      device: {
        limits: { maxStorageBufferBindingSize: ceiling },
        createBuffer: (descriptor) => {
          sizes.push(descriptor.size);
          return DUMMY_BUFFER;
        },
      },
      errorRegistry: spy,
      initialSlotCount: 1024,
      materialStride: stride,
      meshUsage: 0,
      materialUsage: 0,
    });
    ctrl.initialBuild();
    sizes.length = 0;

    expect(ctrl.growMeshSsbo(100000, 100000)).toEqual({ ok: true });
    expect(ctrl.state.meshSlotCount).toBeGreaterThanOrEqual(100000);
    expect(ctrl.state.meshSlotCount).toBeLessThanOrEqual(maxSlots);
    expect(sizes).toHaveLength(2);
    for (const size of sizes) {
      expect(size).toBe(ctrl.state.meshSlotCount * stride);
      expect(size).toBeLessThanOrEqual(ceiling);
    }
    expect(spy.fireCount).toBe(0);
  });

  it('rejects one slot past the real ceiling without allocating or changing the current capacity', () => {
    const sizes: number[] = [];
    const spy = makeSpyErrorRegistry();
    const ctrl = createMeshSsboGrowController({
      device: {
        limits: { maxStorageBufferBindingSize: ceiling },
        createBuffer: (descriptor) => {
          sizes.push(descriptor.size);
          return DUMMY_BUFFER;
        },
      },
      errorRegistry: spy,
      initialSlotCount: 1024,
      materialStride: stride,
      meshUsage: 0,
      materialUsage: 0,
    });
    ctrl.initialBuild();
    sizes.length = 0;

    expect(ctrl.growMeshSsbo(maxSlots + 1, maxSlots + 1)).toEqual({
      ok: false,
      code: 'mesh-ssbo-ceiling-reached',
      degradedTo: { meshSlotCount: 1024, materialSlotCount: 1024 },
    });
    expect(sizes).toEqual([]);
    expect(ctrl.state.meshSlotCount).toBe(1024);
    expect(spy.fireCount).toBe(1);
    expect(spy.lastCode).toBe('mesh-ssbo-ceiling-reached');
  });
});
