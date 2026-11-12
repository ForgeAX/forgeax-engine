import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { deriveStandardClusterReflectedAbi } from '../light-buffer-layout';
import { createStandardClusterLayout } from '../pipeline/standard-lighting/layout';
import {
  type PreparedStandardLighting,
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';
import { standardClusterTextureLayout } from '../pipeline/standard-lighting/texture';
import type { StandardClusterCapabilities } from '../pipeline/standard-lighting/transport';
import { selectStandardClusterTransport as selectWithoutReflectedAbi } from '../pipeline/standard-lighting/transport';
import {
  packTestClusterUniform,
  STANDARD_CLUSTER_TEST_ABI,
  STANDARD_CLUSTER_TEST_REFLECTION,
  selectTestStandardClusterTransport as selectStandardClusterTransport,
} from './cluster-test-abi';

function frame(localCount: number): StandardLightFrame {
  return {
    directional: undefined,
    local: Array.from({ length: localCount }, (_, index) => ({
      kind: index % 2 === 0 ? ('point' as const) : ('spot' as const),
      shadowed: false,
      position: vec3.create((index % 4) - 1.5, 0, -4 - (index % 8)),
      range: 2,
    })),
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: 256,
    renderPath: 'forward',
  };
}

function prepared(localCount: number): PreparedStandardLighting {
  const result = prepareStandardLighting(frame(localCount));
  if (!result.ok) throw result.error;
  return result.value;
}

const STORAGE_FIXTURES: readonly [string, StandardClusterCapabilities, 'cpu' | 'gpu'][] = [
  [
    'compute + storage',
    { compute: true, storageBuffer: true, membershipPipelineReady: true },
    'gpu',
  ],
  [
    'storage without compute',
    { compute: false, storageBuffer: true, membershipPipelineReady: false },
    'cpu',
  ],
];

describe('Standard Cluster transport capability closure', () => {
  it('packs AO lookup and direct-light strength into disjoint uniform rows', () => {
    const reflectedAbi = STANDARD_CLUSTER_TEST_ABI;
    expect(reflectedAbi?.clusterUniformBytes).toBe(96);
    expect(reflectedAbi?.clusterUniformOffsets).toEqual({
      grid: 0,
      near_far_log: 16,
      ao: 32,
      direct_ao: 48,
      texture: 64,
      cluster_layout: 80,
    });
    const payload = packTestClusterUniform({
      grid: { x: 16, y: 9, z: 24 },
      near: 0.1,
      far: 100,
      ssaoIntensity: 2,
      lightCount: 12,
      aoLayout: { baseWord: 6144, width: 128, height: 64, rowWords: 128 },
      directLightingStrength: 0.75,
      textureAddressing: { width: 1024, gridOffset: 6144, indexOffset: 6260 },
    });
    const u32 = new Uint32Array(payload);
    const f32 = new Float32Array(payload);

    expect(payload.byteLength).toBe(96);
    expect(Array.from(u32.subarray(8, 12))).toEqual([6144, 128, 64, 128]);
    expect(f32[12]).toBe(0.75);
    expect(Array.from(f32.subarray(13, 16))).toEqual([0, 0, 0]);
    expect(f32[12]).not.toBe(f32[7]);
    expect(Array.from(u32.subarray(16, 20))).toEqual([6, 6144, 6260, 1024]);
    expect(Array.from(u32.subarray(20, 24))).toEqual([2, 1, 0, 0]);
  });

  it('maps AO words through a contiguous physical Cluster texture viewport', () => {
    const texture = standardClusterTextureLayout(
      createStandardClusterLayout(STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity),
      STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
      { width: 128, height: 128 },
    );

    expect(texture.ao).toMatchObject({
      width: 128,
      height: 128,
      packedWidth: 32,
      rowWords: 128,
      textureWidth: 1024,
      writeHeight: 4,
    });
    expect(texture.height).toBe((texture.ao?.originY ?? 0) + 4);
    expect(texture.ao?.baseWord).toBe((texture.ao?.originY ?? 0) * 1024 * 4);
  });

  it('admits all 256 lights and the identical CPU membership through a baseline integer texture', () => {
    const corpus = prepared(256);
    const result = selectStandardClusterTransport(
      {
        compute: true,
        storageBuffer: false,
        membershipPipelineReady: true,
        maxTextureDimension2D: 2048,
      },
      corpus,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      kind: 'cpu-texture',
      producer: 'cpu',
      requestedLightCount: 256,
      admittedLightCount: 256,
      membershipEntryCount: corpus.membershipEntryCount,
      lightDataBytes: 256 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    });
    expect(
      selectStandardClusterTransport(
        {
          compute: false,
          storageBuffer: false,
          membershipPipelineReady: false,
          maxTextureDimension2D: 1023,
        },
        corpus,
      ).ok,
    ).toBe(false);
  });
  it.each(STORAGE_FIXTURES)('selects %s from the prepared corpus', (_name, caps, producer) => {
    const preparedFrame = prepared(33);
    const selected = selectStandardClusterTransport(caps, preparedFrame);

    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.requestedLightCount).toBe(33);
    expect(selected.value.admittedLightCount).toBe(33);
    expect(selected.value.membershipEntryCount).toBe(preparedFrame.membershipEntryCount);
    expect(selected.value.lightBoundsBytes).toBe(preparedFrame.lightBounds.byteLength);
    expect(selected.value.layout).toBe(preparedFrame.layout);
    expect(selected.value.kind).toBe(producer === 'gpu' ? 'compute-storage' : 'cpu-storage');
    expect(selected.value.producer).toBe(producer);
  });

  it('keeps CPU and GPU preparation on the same cluster corpus', () => {
    const canonical = prepared(33);
    const cpuTransport = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      canonical,
    );
    const gpuTransport = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      canonical,
    );
    expect(cpuTransport.ok && gpuTransport.ok).toBe(true);
    if (!cpuTransport.ok || !gpuTransport.ok) return;
    expect(Array.from(canonical.clusterGrid)).not.toEqual([]);
    expect(Array.from(canonical.lightBounds)).not.toEqual([]);
    expect(canonical.membershipEntryCount).toBeGreaterThan(0);
    expect(cpuTransport.value.membershipEntryCount).toBe(gpuTransport.value.membershipEntryCount);
    expect(cpuTransport.value.requestedLightCount).toBe(gpuTransport.value.requestedLightCount);
  });

  it('does not forge a GPU producer when the membership pipeline is not ready', () => {
    const result = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: false },
      prepared(33),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.producer).toBe('cpu');
    expect(result.value.kind).toBe('cpu-storage');
  });

  it('fails closed when no proven storage transport exists', () => {
    const result = selectStandardClusterTransport(
      { compute: true, storageBuffer: false, membershipPipelineReady: false },
      prepared(33),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'standard-cluster-transport-unavailable') return;
    expect(result.error.detail).toEqual({ requested: 33, admitted: 0 });
    expect(result.error.hint).toContain('storage');
    expect(JSON.stringify(result.error)).not.toContain('four');
  });

  it('rejects even an empty frame without storage so no second cluster ABI exists', () => {
    const result = selectStandardClusterTransport(
      { compute: false, storageBuffer: false, membershipPipelineReady: false },
      prepared(0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'standard-cluster-transport-unavailable') return;
    expect(result.error.detail).toEqual({ requested: 0, admitted: 0 });
  });

  it('rejects an absent reflected ABI before selecting any transport', () => {
    const result = selectWithoutReflectedAbi(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      prepared(0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-cluster-transport-unavailable');
    expect(result.error.hint).toContain('reflection');
  });

  it('does not assemble an ABI by mixing fields from different pipeline variants', () => {
    const lightOnly = {
      ...STANDARD_CLUSTER_TEST_REFLECTION,
      boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.filter(
        (global) => global.name === 'light_data',
      ),
    };
    const uniformOnly = {
      ...STANDARD_CLUSTER_TEST_REFLECTION,
      boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.filter(
        (global) => global.name === 'cluster_uniform',
      ),
    };
    expect(deriveStandardClusterReflectedAbi([lightOnly, uniformOnly])).toBeUndefined();
  });

  it('rejects a DirectLightSlot publication without its fixed array capacity', () => {
    const withoutCapacity = {
      ...STANDARD_CLUSTER_TEST_REFLECTION,
      boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.map((global) => {
        if (global.group !== 2 || global.binding !== 3) return global;
        const { arrayLength: _arrayLength, ...legacy } = global;
        return legacy;
      }),
    };
    expect(deriveStandardClusterReflectedAbi([withoutCapacity])).toBeUndefined();
  });

  it('derives the published ABI from binding coordinates when Naga composes global names', () => {
    const composed = {
      ...STANDARD_CLUSTER_TEST_REFLECTION,
      boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.map((global) => ({
        ...global,
        name: `${global.name}X_naga_oil_mod_composed`,
      })),
    };
    expect(deriveStandardClusterReflectedAbi([composed])).toEqual(STANDARD_CLUSTER_TEST_ABI);
  });
});

it('reserves disjoint half-float screen tiles without moving the existing AO payload', () => {
  const layout = createStandardClusterLayout(STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity);
  const before = standardClusterTextureLayout(
    layout,
    STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    { width: 65, height: 33 },
  );
  const after = standardClusterTextureLayout(
    layout,
    STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    { width: 65, height: 33, screen: { width: 129, height: 67 } },
  );
  expect(after.ao).toEqual(before.ao);
  expect(after.gridOffset).toBe(before.gridOffset);
  expect(after.indexOffset).toBe(before.indexOffset);
  const screen = after.screen;
  if (screen === undefined || after.ao === undefined) throw new Error('missing screen/AO region');
  expect(screen.baseWord).toBeGreaterThanOrEqual(
    after.ao.baseWord + after.ao.rowWords * after.ao.height,
  );
  expect(screen.baseWord % 4096).toBe(0);
  expect(after.height * 4096).toBeGreaterThanOrEqual(screen.baseWord + 129 * 67 * 8);
  const payload = packTestClusterUniform({
    grid: { x: 16, y: 9, z: 24 },
    near: 0.1,
    far: 100,
    aoLayout: after.ao,
    screen,
  });
  expect(Array.from(new Float32Array(payload).subarray(13, 16))).toEqual([1, 129, 67]);
  expect(new Uint32Array(payload)[22]).toBe(screen.baseWord);
});

it('keeps full atmosphere tables disjoint from host light, AO and screen regions', () => {
  const layout = createStandardClusterLayout(STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity);
  const bytes = STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize;
  const extent = { width: 257, height: 129, screen: { width: 257, height: 129 } };
  const base = standardClusterTextureLayout(layout, bytes, extent);
  const packed = standardClusterTextureLayout(layout, bytes, { ...extent, atmosphere: true });
  expect(packed.width).toBe(base.width);
  expect(packed.height).toBe(base.height + 50);
  expect(packed.gridOffset).toBe(base.gridOffset);
  expect(packed.indexOffset).toBe(base.indexOffset);
  expect(packed.ao).toEqual(base.ao);
  expect(packed.screen).toEqual(base.screen);
  expect(packed.atmosphere?.originY).toBe(base.height);
  expect(packed.atmosphere?.writeHeight).toBe(50);
  expect(base.atmosphere).toBeUndefined();
});
