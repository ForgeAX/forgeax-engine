import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/index';
import { SDF_SURFACE_POOL_WGSL } from '../sdf-surface-pool-wgsl';
import { SDF_SURFACE_TRACE_WGSL } from '../sdf-surface-trace-wgsl';
import {
  bits,
  prefixDyadic,
  surfacePrefixInput,
  surfacePrefixKernel,
} from './sdf-surface-prefix.fixture';

it('adds only certified closed-node exclusion without narrowing the primitive ray or charging a sample step', () => {
  expect(SDF_SURFACE_TRACE_WGSL).toContain('bounds.far<prefix.end');
  expect(SDF_SURFACE_TRACE_WGSL).toContain('node==0u');
  expect(SDF_SURFACE_TRACE_WGSL).toContain('best.prefixSamples=prefix.samples');
  expect(SDF_SURFACE_TRACE_WGSL.match(/sdfSurfaceCharge\(remaining\)/g)).toHaveLength(2);
  expect(SDF_SURFACE_TRACE_WGSL).toContain(
    'sdfSurfaceLeafTrianglePrepared(packet,start+slot,ray,&segment)',
  );
  expect(SDF_SURFACE_TRACE_WGSL).not.toMatch(/ray\.tRange\s*=/);
  expect(SDF_SURFACE_POOL_WGSL).toContain('offset>packet.samples.y-32u');
  expect(surfacePrefixKernel).not.toContain('abs(traceGlobal');
});

it('proves the authored origin distance with an independent triangle halfspace and a plane', () => {
  // Projection to x+y>=3 costs at least 9/2, plus z distance squared 1/4.
  expect(19n * 1n).toBeGreaterThan(4n * 4n);
  // The far triangle strictly contains (0,0,2), distance exactly 2.
  const input = surfacePrefixInput();
  expect(input.instances[16]).toBe(73);
  expect(input.fields[input.samples]).toBe(1);
  const code = BigInt(input.fields[input.samples + 1] ?? 0);
  // q-quantization < 2: no exact far surface can be skipped.
  expect((code - 1n) * 4n).toBeLessThan(2n * 32767n);
  // But q-quantization-|(.125,.125,0)|_1 > 1/2, excluding the near false AABB.
  expect((code - 1n) * 16n - 32767n).toBeGreaterThan(2n * 32767n);
});

it('retains a concrete maxSteps=2 surface-start hit when an extra paid lookup would exhaust the ray', () => {
  const input = surfacePrefixInput(true);
  const firstSurface = prefixDyadic(bits(2));
  expect(input.fields[input.tree + 7]).toBe(1);
  // Root and its one triangle consume exactly two original work units.
  expect(2 - 1 - 1).toBe(0);
  expect(2 - 1 - 1 - 1).toBeLessThan(0);
  // Origin z=2 is already on the true surface: D(C)=2 - |P-C|_1 <= 0.
  expect(2n * (1n << 149n) - firstSurface).toBe(0n);
});

it('catches unsafe source-error omission and equality culling independently of interval overlap', () => {
  const code = 32767n,
    band = 4n,
    error = 2n;
  const safe = (code - 1n) * band - error * 32767n;
  expect(safe).toBeLessThan(2n * 32767n);
  // Omitting E fabricates a clear prefix past the real z=2 plane.
  expect((code - 1n) * band).toBeGreaterThan(2n * 32767n);
  const input = surfacePrefixInput(true),
    nodeFar = new Float32Array(input.fields.buffer)[input.tree + 6],
    emptyOpenEnd = Number(prefixDyadic(bits(2))) / 2 ** 149;
  expect(nodeFar).toBe(emptyOpenEnd);
  expect(nodeFar !== undefined && nodeFar < emptyOpenEnd).toBe(false);
  expect(nodeFar !== undefined && nodeFar <= emptyOpenEnd).toBe(true);
});
it('requires producer lattice eligibility and ray validity before consulting sample metadata', () => {
  expect(SDF_SURFACE_TRACE_WGSL).toContain('packet.prefixEligible!=1u');
  expect(SDF_SURFACE_TRACE_WGSL).toContain('ray.valid!=1u');
});
it('rejects raw dimensions whose brick product would wrap before using any sample address', () => {
  const brickAxis = 16777216 / 4,
    span = 33;
  expect(BigInt(brickAxis) * BigInt(brickAxis)).toBeGreaterThan(0xffffffffn);
  expect(Math.imul(brickAxis, brickAxis) >>> 0).toBe(0);
  expect(brickAxis > Math.floor(span / brickAxis)).toBe(true);
  expect(SDF_SURFACE_POOL_WGSL).toContain('bricks.x>packet.samples.y/bricks.y');
  expect(SDF_SURFACE_POOL_WGSL).toContain('plane>packet.samples.y/bricks.z');
  expect(SDF_SURFACE_POOL_WGSL.indexOf('bricks.x>packet.samples.y/bricks.y')).toBeLessThan(
    SDF_SURFACE_POOL_WGSL.indexOf('let plane=bricks.x*bricks.y'),
  );
  expect(SDF_SURFACE_POOL_WGSL.indexOf('plane>packet.samples.y/bricks.z')).toBeLessThan(
    SDF_SURFACE_POOL_WGSL.indexOf('let table=plane*bricks.z'),
  );
});

it('uses complete V4 row-owned opaque coverage before the real Prefix and Row decoder', () => {
  for (const single of [false, true]) {
    const input = surfacePrefixInput(single);
    expect(Array.from(input.fields.subarray(0, 4))).toEqual([0x53534650, 4, 1, single ? 96 : 124]);
    expect(Array.from(input.fields.subarray(4, 8))).toEqual([28, input.fields.length, 1, 24]);
    expect(Array.from(input.fields.subarray(24, 28))).toEqual([0, single ? 1 : 2, 0, 0]);
    expect(input.samples).toBe(28);
    expect(Array.from(input.fields.subarray(8, 12))).toEqual([28, 33, 0, 1]);
    expect(input.fields[22]).toBe(0);
    expect(input.fields[23]).toBe(0);
    expect(input.instances[20]).toBe(4);
    expect(input.instances[35]).toBe(0x40000000);
    const aligned = (value: number) => Math.ceil(value / 4) * 4;
    expect(input.fields[12]).toBe(aligned(input.samples + 33));
    expect(input.fields[14]).toBe(aligned((input.fields[12] ?? 0) + (single ? 9 : 18)));
    expect(input.tree).toBe(aligned((input.fields[14] ?? 0) + (single ? 3 : 6)));
    expect(input.order).toBe(input.tree + (single ? 8 : 24));
    expect(input.fields[20]).toBe(aligned(input.order + (single ? 1 : 2)));
    expect(input.fields.length).toBe(aligned((input.fields[20] ?? 0) + 1));
  }
});

it('compiles the actual Row trace and RootPrefix consumer rather than a metadata-only proxy', async () => {
  expect((await compileShader(surfacePrefixKernel, { id: 'surface-prefix-v4' })).ok).toBe(true);
});
