import { describe, expect, it } from 'vitest';
import { buildWaterMeshView } from '../water-mesh.js';
import {
  createWaterMeshLayoutReceipt,
  isWaterMeshContinuityPayloadValid,
  isWaterMeshLayoutReceiptValid,
} from '../water-mesh-abi.js';
import { continuityInput } from './water-mesh-continuity.fixture.js';

const view = { viewId: 'mouth', observerM: [8, 8, 8] as const };
describe('accepted WaterMesh terminal continuity producer', () => {
  it('closes every vertex of the actual shared boundary triangle while retaining upstream source height', () => {
    const mesh = buildWaterMeshView(continuityInput(), view).unwrap();
    const river = mesh.instances.find(
      (t) => t.ownerGuid === 'river' && t.transitionBodyGuid === 'ocean',
    );
    const ocean = mesh.instances.find((t) => t.ownerGuid === 'ocean' && !t.far);
    expect(river?.continuitySupport).toBeDefined();
    expect(ocean?.continuitySupport).toBeDefined();
    if (!river || !ocean) throw Error('missing actual paired coverage');
    expect(river.continuitySupport?.weights).toEqual(ocean.continuitySupport?.weights);
    const side = river.quadsPerEdge + 1;
    // Shared z=4 edge: the rendered template triangle spans (6,4),(6,6),(8,4).
    for (const [x, z] of [
      [3, 2],
      [3, 3],
      [4, 2],
    ] as const)
      expect(river.continuitySupport?.weights[z * side + x]).toBe(1);
    expect(river.continuitySupport?.weights[0]).toBe(0);
    expect(continuityInput().bodies[1]?.baseHeightM).toBe(30);
    expect(isWaterMeshContinuityPayloadValid(mesh.instanceBytes, mesh.coverageBytes)).toBe(true);
    for (const draw of mesh.buckets.flatMap((b) => b.ownerDraws)) {
      expect(isWaterMeshContinuityPayloadValid(draw.instanceBytes, draw.coverageBytes)).toBe(true);
      expect(
        isWaterMeshLayoutReceiptValid(draw.layout, draw.instanceBytes, draw.coverageBytes),
      ).toBe(true);
    }
  });
  it('leaves omitted policy and unrelated Lake transitions on the original path', () => {
    const input = continuityInput(false);
    const ordinary = buildWaterMeshView(input, view).unwrap();
    expect(ordinary.instances.every((t) => t.continuitySupport === undefined)).toBe(true);
    const lake = buildWaterMeshView(
      {
        ...continuityInput(),
        bodies: continuityInput().bodies.map((b) =>
          b.type === 'ocean' ? { ...b, type: 'lake' as const } : b,
        ),
      },
      view,
    ).unwrap();
    expect(lake.instances.every((t) => t.continuitySupport === undefined)).toBe(true);
  });
  it('does not retain stale targets, excluded bodies or old support in a later accepted roster', () => {
    const input = continuityInput();
    const held = buildWaterMeshView(input, view).unwrap();
    const old = held.coverageBytes.slice();
    const removed = buildWaterMeshView(
      { ...input, bodies: input.bodies.filter((b) => b.type !== 'ocean') },
      view,
    ).unwrap();
    expect(removed.instances.every((t) => t.continuitySupport === undefined)).toBe(true);
    const excluded = buildWaterMeshView(
      {
        ...input,
        bodies: input.bodies.map((b) => (b.type === 'ocean' ? { ...b, visible: false } : b)),
      },
      view,
    ).unwrap();
    expect(excluded.instances.every((t) => t.continuitySupport === undefined)).toBe(true);
    const next = buildWaterMeshView(
      { ...input, bodies: input.bodies.map((b) => ({ ...b, generation: b.generation + 1 })) },
      view,
    ).unwrap();
    expect(
      next.instances.find((t) => t.transitionBodyGuid === 'ocean')?.transitionBodyGeneration,
    ).toBe(6);
    expect(held.coverageBytes).toEqual(old);
    expect(
      Object.isFrozen(held.instances.find((t) => t.continuitySupport)?.continuitySupport?.weights),
    ).toBe(true);
  });
  it('rejects opted-in GPU traversal instead of silently dropping its support', () => {
    expect(buildWaterMeshView({ ...continuityInput(), nearMesh: 'gpu' }, view)).toMatchObject({
      ok: false,
      error: { code: 'asset-invalid-value' },
    });
  });
  it('rejects malformed numeric support even after a caller recomputes the byte receipt', () => {
    const mesh = buildWaterMeshView(continuityInput(), view).unwrap();
    const index = mesh.instances.findIndex((t) => t.continuitySupport !== undefined);
    const bytes = mesh.instanceBytes.slice(),
      coverage = mesh.coverageBytes.slice();
    const words = new DataView(bytes.buffer),
      payload = new DataView(coverage.buffer);
    const pointer = words.getUint32(index * 96 + 92, true) >>> 4,
      start = pointer - mesh.instanceBytes.byteLength / 4;
    payload.setFloat32((start + 2) * 4, NaN, true);
    expect(
      isWaterMeshLayoutReceiptValid(createWaterMeshLayoutReceipt(bytes, coverage), bytes, coverage),
    ).toBe(true);
    expect(isWaterMeshContinuityPayloadValid(bytes, coverage)).toBe(false);
    payload.setFloat32((start + 2) * 4, 1, true);
    payload.setUint32((start + 1) * 4, 1, true);
    expect(isWaterMeshContinuityPayloadValid(bytes, coverage)).toBe(false);
    words.setUint32(index * 96 + 92, 0xfffffff0, true);
    expect(isWaterMeshContinuityPayloadValid(bytes, coverage)).toBe(false);
  });
  it('versions the extended 96-byte payload and rejects an old receipt', () => {
    const mesh = buildWaterMeshView(continuityInput(), view).unwrap();
    expect(mesh.layout.schemaVersion).toBe(8);
    expect(mesh.layout.strideBytes).toBe(96);
    expect(
      isWaterMeshLayoutReceiptValid(
        { ...mesh.layout, schemaVersion: 7 } as unknown as typeof mesh.layout,
        mesh.instanceBytes,
        mesh.coverageBytes,
      ),
    ).toBe(false);
  });
});
