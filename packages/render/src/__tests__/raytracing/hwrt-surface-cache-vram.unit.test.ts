import type { RhiDevice, RhiRayQueryCaps } from '@forgeax/engine-rhi';
import { RhiNullAdapter, type RhiNullDevice } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import {
  createWorldAcceleration,
  tlasTransform,
  triangleFaceNormals,
} from '../../raytracing/world-acceleration';

const LIMITS = {
  maxBlasGeometryCount: 4,
  maxBlasPrimitiveCount: 16,
  maxTlasInstanceCount: 16,
  maxAccelerationStructuresPerShaderStage: 1,
};

async function createRayDevice(): Promise<RhiDevice> {
  const adapter = new RhiNullAdapter({
    rayQuery: LIMITS satisfies Omit<RhiRayQueryCaps, 'supported'>,
  });
  return (await adapter.requestDevice()).unwrap();
}

describe('HWRT surface cache and VRAM optimizations', () => {
  it('computes exact face normals and coincident opposite-winding flags without allocations', () => {
    const positions = new Float32Array([
      // Triangle 0 (+Z)
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      // Triangle 1 (+Z duplicate with -0.0 coordinate)
      -0, 0, 0, 1, 0, 0, 0, 1, 0,
      // Triangle 2 (-Z opposite winding, distinct vertex indices, same positions)
      0, 0, 0, 0, 1, 0, 1, 0, 0,
      // Triangle 3 (separate plane +Y, no coincident twin)
      0, 2, 0, 0, 2, 1, 1, 2, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const normals = triangleFaceNormals(positions, indices);
    expect(normals.length).toBe(16);
    // Triangles 0, 1, 2 are coincident with opposite winding -> all three flagged w = 1
    expect(Array.from(normals.subarray(0, 4))).toEqual([0, 0, 1, 1]);
    expect(Array.from(normals.subarray(4, 8))).toEqual([0, 0, 1, 1]);
    expect(Array.from(normals.subarray(8, 12))).toEqual([0, 0, -1, 1]);
    // Triangle 3 is unique -> w = 0
    expect(Array.from(normals.subarray(12, 16))).toEqual([0, 1, 0, 0]);
  });

  it('packs 3x4 row-major TLAS transforms from column-major mat4', () => {
    const mat4 = [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 1];
    expect(tlasTransform(mat4)).toEqual([1, 4, 7, 10, 2, 5, 8, 11, 3, 6, 9, 12]);
  });

  it('retains BLAS_INPUT vertex/index buffers for RHI replay until geometry retirement settles', async () => {
    const device = await createRayDevice();
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer');
    const accel = createWorldAcceleration(device, {
      maxInstances: 4,
      maxTriangles: 16,
      maxBlasBuildsPerFrame: 4,
    }).unwrap();
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    accel
      .set(
        { instanceId: 1, geometryId: 10, mask: 0xff, transform: identity },
        {
          geometryId: 10,
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        },
      )
      .unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const built = accel.update(encoder).unwrap();
    expect(built.blasBuilt).toBe(1);
    accel.track(Promise.resolve());
    await Promise.resolve();
    await Promise.resolve();
    // Buffers stay live alongside the resident BLAS so frame-capture replay can snapshot them.
    expect(destroyBuffer).not.toHaveBeenCalled();
    // Removing the last instance retires the BLAS and its input buffers after flight settles.
    accel.remove(1);
    const enc2 = device.createCommandEncoder({}).unwrap();
    accel.update(enc2).unwrap();
    let resolveFlight = () => {};
    accel.track(
      new Promise<void>((resolve) => {
        resolveFlight = resolve;
      }),
    );
    expect(destroyBuffer).not.toHaveBeenCalled();
    resolveFlight();
    await Promise.resolve();
    await Promise.resolve();
    expect(destroyBuffer).toHaveBeenCalledTimes(2);
    expect((device as RhiNullDevice).bookkeeper.isDestroyed(accel.tlas)).toBe(false);
    accel.dispose();
    expect((device as RhiNullDevice).bookkeeper.isDestroyed(accel.tlas)).toBe(true);
  });

  it('culls out-of-range local lights and out-of-cone spotlights before cardSurface shadow rays', () => {
    for (const traversal of ['ray-query', 'global-sdf'] as const) {
      const wgsl = irradianceFieldKernelWgsl(traversal).cardSurface;
      const body = wgsl.slice(wgsl.indexOf('fn cardSurface('));
      const rangeCull = body.indexOf('d*d*light.directionRange.w>=1.0');
      const coneCull = body.indexOf(
        'dot(-incoming,normalize(light.directionRange.xyz))<light.cone.y',
      );
      const traceCall = body.indexOf(
        traversal === 'ray-query' ? 'traceWorldVisibility(' : 'cardLightSegment(',
      );
      expect(rangeCull, traversal).toBeGreaterThan(0);
      expect(coneCull, traversal).toBeGreaterThan(rangeCull);
      expect(traceCall, traversal).toBeGreaterThan(coneCull);
    }
  });
});
