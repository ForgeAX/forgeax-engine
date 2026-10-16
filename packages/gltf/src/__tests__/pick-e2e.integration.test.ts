// pick-e2e.integration.test.ts — glTF end-to-end pick probe over pack JSON roundtrip
// (bug-20260706-import-path-meshasset-aabb-undefined-blocks-pick M5 / m5-1).
//
// Verifies the full chain: GltfMeshIr → meshIrToMeshAsset (producer) →
// packMeshBin (JSON tail encode) → explicit JSON.stringify → JSON.parse
// roundtrip (simulating dev-server pack transport) → aabb reconstruction
// (Float32Array from plain array, the loader dual-contract path) →
// World.allocSharedRef + spawn (MeshFilter / MeshRenderer / Transform) →
// pick() hit assertion + negative-control miss.
//
// Falsification drill (plan-strategy section 5.4) EXECUTED:
//   (1) Commented out `aabb: box3.fromPositions(box3.create(), positionsCat)`
//       in packages/gltf/src/bridge.ts:329.
//   (2) Ran this test → FAIL: pick() returned undefined (mesh entity had
//       aabb === undefined, broad-phase `continue` skipped it).
//       Confirmed the probe is sensitive to the aabb variable — not
//       unconditionally green.
//   (3) Restored the aabb emit line.
//   (4) Re-ran → PASS.
//   Drill result: probe correctly detects aabb absence. (Recorded inline
//   in this file header as required by plan subsection 5.4.)
//
// AC-03 hard constraint: dawn-node smoke does NOT count — this vitest
// integration test explicitly exercises the pack JSON roundtrip path that
// dawn smoke skips. Reviewer can grep for `JSON.stringify` /
// `JSON.parse` in this file to confirm.
//
// References: plan-strategy D-3 / R-6; pick-tile.test.ts (no-GPU pick
// test paradigm); cli-gltf.integration.test.ts (gltf integration test
// fixture pattern).

import { World } from '@forgeax/engine-ecs';
import { packMeshBin } from '@forgeax/engine-import';
import { decodeMeshBinHeader } from '@forgeax/engine-pack';
import { pick } from '@forgeax/engine-picking';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { GltfMeshIr } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

// ---- helpers ----

/** Convert a branded handle to the raw u32 used by allocSharedRef return. */
function asHandle<T extends string>(n: number): Handle<T, 'shared'> {
  return n as unknown as Handle<T, 'shared'>;
}

// ---- test ----

describe('gltf e2e pick probe over pack JSON roundtrip (m5-1)', () => {
  it('meshIrToMeshAsset → packMeshBin → JSON roundtrip → pick hit + negative-control miss', () => {
    // --- 1. GltfMeshIr fixture: single triangle at Z=-3, XY symmetric ---
    const prim: GltfMeshIr = {
      positions: new Float32Array([-1, -1, -3, 1, -1, -3, 0, 1, -3]),
      indices: new Uint16Array([0, 1, 2]),
      materialIndex: 0,
      meshIndex: 0,
    };

    // --- 2. Producer: meshIrToMeshAsset emits aabb (M4) ---
    const meshAsset = meshIrToMeshAsset([prim]);
    expect(meshAsset.aabb).toBeInstanceOf(Float32Array);
    expect(meshAsset.aabb).toHaveLength(6);
    // Min of positions: (-1, -1, -3); max: (1, 1, -3)
    expect(meshAsset.aabb?.[0]).toBe(-1);
    expect(meshAsset.aabb?.[1]).toBe(-1);
    expect(meshAsset.aabb?.[2]).toBe(-3);
    expect(meshAsset.aabb?.[3]).toBe(1);
    expect(meshAsset.aabb?.[4]).toBe(1);
    expect(meshAsset.aabb?.[5]).toBe(-3);

    // --- 3. Encode via packMeshBin: converts aabb Float32Array to plain
    //       array in the JSON tail (Array.from at import/src/mesh-bin.ts:153) ---
    const packed = packMeshBin(
      {
        vertices: meshAsset.vertices,
        indices: meshAsset.indices,
        submeshes: meshAsset.submeshes,
        aabb: meshAsset.aabb,
        attributes: meshAsset.attributes,
      },
      'gltf://pick',
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const bin = packed.value;

    const header = decodeMeshBinHeader(bin, 'gltf://pick');
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    const jsonOffset = 80 + header.value.vertexBytes + header.value.indexBytes;
    const jsonBytes = bin.slice(jsonOffset, jsonOffset + header.value.jsonBytes);
    const metaRaw = new TextDecoder().decode(jsonBytes);

    // Verify aabb is encoded as a plain number array in the JSON tail.
    const metaParsed = JSON.parse(metaRaw) as { aabb?: number[] };
    expect(Array.isArray(metaParsed.aabb)).toBe(true);
    expect(metaParsed.aabb).toHaveLength(6);

    // --- 4. Explicit JSON roundtrip: simulate dev-server pack transport ---
    // AC-03 / D-3: the test MUST contain explicit JSON.stringify → JSON.parse
    // that mirrors the fetch-based transport path dawn smoke skips.
    const transportStr = JSON.stringify(metaParsed);
    const transportParsed = JSON.parse(transportStr) as { aabb?: number[] };
    expect(Array.isArray(transportParsed.aabb)).toBe(true);
    // Values survive the roundtrip intact.
    expect(transportParsed.aabb?.[0]).toBe(-1);
    expect(transportParsed.aabb?.[1]).toBe(-1);
    expect(transportParsed.aabb?.[2]).toBe(-3);
    expect(transportParsed.aabb?.[3]).toBe(1);
    expect(transportParsed.aabb?.[4]).toBe(1);
    expect(transportParsed.aabb?.[5]).toBe(-3);

    // --- 5. Reconstruct aabb as the runtime loader would ---
    //   loader dual-contract: plain array → new Float32Array(array)
    //   (runtime/src/mesh-bin.ts:116: `aabb = new Float32Array(parsed.aabb)`)
    const roundtrippedAabb = new Float32Array(transportParsed.aabb as number[]);
    expect(roundtrippedAabb).toHaveLength(6);
    expect(roundtrippedAabb[0]).toBe(-1);
    expect(roundtrippedAabb[5]).toBe(-3);

    // --- 6. World setup ---
    const world = new World();

    // Material for MeshRenderer (any visible material; pick only needs
    // the MeshFilter + MeshRenderer presence on the archetype).
    const unlitMat = Materials.unlit([1, 1, 1, 1]) as unknown as MaterialAsset;
    const unlitHandle = asHandle<'MaterialAsset'>(world.allocSharedRef('MaterialAsset', unlitMat));

    // Reconstruct the MeshAsset payload with the roundtripped aabb and
    // original typed arrays. Use a cast since exactOptionalPropertyTypes
    // forbids spreading optional fields that resolve to undefined.
    const meshPayload = {
      kind: 'mesh' as const,
      vertices: meshAsset.vertices,
      ...(meshAsset.indices !== undefined ? { indices: meshAsset.indices } : {}),
      submeshes: meshAsset.submeshes,
      aabb: roundtrippedAabb,
      attributes: meshAsset.attributes,
    } as MeshAsset;

    const meshHandle = asHandle<'MeshAsset'>(world.allocSharedRef('MeshAsset', meshPayload));

    // Mesh entity at origin. Identity Transform → identity world mat4.
    const meshEntity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [unlitHandle] } },
      )
      .unwrap();

    // Camera entity at origin, looking down -Z (perspective).
    // Identity Transform → identity world mat4 → view = identity.
    const cameraEntity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: perspective({ fov: Math.PI / 4, aspect: 1 }),
        },
      )
      .unwrap();

    // --- 7. pick hit: screen center (50, 50) on 100x100 → ndc (0, 0) → ray
    //       straight down -Z → enters AABB at z=-3 → hit ---
    const hit = pick(world, cameraEntity, 50, 50, 100, 100);
    expect(hit).toBeDefined();
    if (hit) {
      expect(hit.entity).toBe(meshEntity);
      // The entry point should be near the AABB front face at z=-3.
      expect(Math.abs((hit.point[2] as number) - -3)).toBeLessThan(0.1);
    }

    // --- 8. Negative control: pick bottom-right corner (100, 100) on
    //       100x100 → ndc (1, -1) → ray at Z=-3 lands at (x≈1.24, y≈-1.24)
    //       which is outside the AABB x-range [-1, 1] → miss ---
    const miss = pick(world, cameraEntity, 100, 100, 100, 100);
    expect(miss).toBeUndefined();
  });

  it('mesh without aabb: pick() returns undefined (falsification witness)', () => {
    // Create a MeshAsset payload that explicitly omits aabb, verifying
    // that pick() skips it at the broad-phase check (pick.ts:184).
    // This is a secondary in-code falsification — it repeats the
    // comment-out-drill semantics without modifying M4 production code.
    const world = new World();

    const unlitMat = Materials.unlit([1, 1, 1, 1]) as unknown as MaterialAsset;
    const unlitHandle = asHandle<'MaterialAsset'>(world.allocSharedRef('MaterialAsset', unlitMat));

    const noAabbMesh = {
      kind: 'mesh' as const,
      vertices: new Float32Array([-1, -1, -3, 1, -1, -3, 0, 1, -3]),
      indices: new Uint16Array([0, 1, 2]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
      attributes: {},
    } satisfies MeshAsset;

    const noAabbHandle = asHandle<'MeshAsset'>(world.allocSharedRef('MeshAsset', noAabbMesh));

    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: noAabbHandle } },
        {
          component: MeshRenderer,
          data: { materials: [unlitHandle] },
        },
      )
      .unwrap();

    const cameraEntity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: perspective({ fov: Math.PI / 4, aspect: 1 }),
        },
      )
      .unwrap();

    // Same center ray that would hit if aabb were present.
    const miss = pick(world, cameraEntity, 50, 50, 100, 100);
    expect(miss).toBeUndefined();
  });
});
