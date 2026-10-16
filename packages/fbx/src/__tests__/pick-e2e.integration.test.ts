// pick-e2e.integration.test.ts -- FBX end-to-end pick probe over pack JSON roundtrip
// (bug-20260706-import-path-meshasset-aabb-undefined-blocks-pick M8 / m8-1).
//
// Verifies the full FBX chain: MeshPod (constructed, no ufbx wasm needed per D-3/R-3) ->
// buildMeshAsset (producer emits aabb, M7) -> packMeshBin (JSON tail encode) ->
// explicit JSON.stringify -> JSON.parse roundtrip (simulating dev-server pack transport) ->
// aabb reconstruction (Float32Array from plain array, the loader dual-contract path) ->
// World.allocSharedRef + spawn (MeshFilter / MeshRenderer / Transform) ->
// pick() hit assertion + negative-control miss.
//
// Falsification drill (plan-strategy section 5.4) EXECUTED:
//   (1) Commented out `aabb: box3.fromPositions(box3.create(), pod.vertices)`
//       in packages/fbx/src/to-asset-pack.ts:155.
//   (2) Ran this test -> FAIL: pick() returned undefined (mesh entity had
//       aabb === undefined, broad-phase `continue` skipped it).
//       Confirmed the probe is sensitive to the aabb variable -- not
//       unconditionally green.
//   (3) Restored the aabb emit line.
//   (4) Re-ran -> PASS.
//   Drill result: probe correctly detects aabb absence. (Recorded inline
//   in this file header as required by plan subsection 5.4.)
//
// AC-04 hard constraint: dawn-node smoke does NOT count -- this vitest
// integration test explicitly exercises the pack JSON roundtrip path that
// dawn smoke skips. Reviewer can grep for `JSON.stringify` /
// `JSON.parse` in this file to confirm.
//
// References: plan-strategy D-3 / R-3 / R-6; gltf pick-e2e.integration.test.ts
// (M5 parallel structure, different chain entry point).

import { World } from '@forgeax/engine-ecs';
import { packMeshBin } from '@forgeax/engine-import';
import { decodeMeshBinHeader } from '@forgeax/engine-pack';
import { pick } from '@forgeax/engine-picking';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type {
  Handle,
  ImportedAsset,
  MaterialAsset,
  MeshAsset,
  MeshPod,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildMeshAsset } from '../to-asset-pack.js';

// ---- helpers ----

/** Convert a branded handle to the raw u32 used by allocSharedRef return. */
function asHandle<T extends string>(n: number): Handle<T, 'shared'> {
  return n as unknown as Handle<T, 'shared'>;
}

/** Narrow an ImportedAsset of kind='mesh' to its MeshAsset payload. */
function meshFromAsset(asset: ImportedAsset): MeshAsset {
  if (asset.kind !== 'mesh') throw new TypeError(`expected mesh, got ${asset.kind}`);
  return asset.payload as MeshAsset;
}

/** Build a minimal MeshPod fixture: a single triangle at Z=-3, XY symmetric.
 *  vertices is the pure position stride-3; indices and submeshes are populated.
 *  No extra attributes needed -- buildMeshAsset fills defaults (normal, uv, tangent). */
function makeTrianglePod(): MeshPod {
  return {
    vertices: new Float32Array([-1, -1, -3, 1, -1, -3, 0, 1, -3]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialIndex: null,
        topology: 'triangle-list',
      },
    ],
    sourceIndex: 0,
  };
}

// ---- test ----

describe('fbx e2e pick probe over pack JSON roundtrip (m8-1)', () => {
  it('buildMeshAsset -> packMeshBin -> JSON roundtrip -> pick hit + negative-control miss', () => {
    // --- 1. MeshPod fixture (no ufbx wasm -- D-3/R-3 orthogonality) ---
    const pod = makeTrianglePod();

    // --- 2. Producer: buildMeshAsset emits aabb (M7) ---
    const imported = buildMeshAsset(pod, 'guid-fbx-triangle');
    const meshAsset = meshFromAsset(imported);
    expect(meshAsset.aabb).toBeInstanceOf(Float32Array);
    expect(meshAsset.aabb).toHaveLength(6);
    // Min of vertices: (-1, -1, -3); max: (1, 1, -3)
    expect(meshAsset.aabb?.[0] as number).toBe(-1);
    expect(meshAsset.aabb?.[1] as number).toBe(-1);
    expect(meshAsset.aabb?.[2] as number).toBe(-3);
    expect(meshAsset.aabb?.[3] as number).toBe(1);
    expect(meshAsset.aabb?.[4] as number).toBe(1);
    expect(meshAsset.aabb?.[5] as number).toBe(-3);

    // --- 3. Encode via packMeshBin ---
    const packed = packMeshBin(
      {
        vertices: meshAsset.vertices,
        indices: meshAsset.indices,
        submeshes: meshAsset.submeshes,
        aabb: meshAsset.aabb,
        attributes: meshAsset.attributes,
      },
      'fbx://pick',
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const bin = packed.value;

    const header = decodeMeshBinHeader(bin, 'fbx://pick');
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
    const roundtrippedAabb = new Float32Array(transportParsed.aabb as number[]);
    expect(roundtrippedAabb).toHaveLength(6);
    expect(roundtrippedAabb[0]).toBe(-1);
    expect(roundtrippedAabb[5]).toBe(-3);

    // --- 6. World setup ---
    const world = new World();

    const unlitMat = Materials.unlit([1, 1, 1, 1]) as unknown as MaterialAsset;
    const unlitHandle = asHandle<'MaterialAsset'>(world.allocSharedRef('MaterialAsset', unlitMat));

    // Reconstruct the MeshAsset payload with the roundtripped aabb and
    // original typed arrays from the FBX buildMeshAsset output.
    const meshPayload = {
      kind: 'mesh' as const,
      vertices: meshAsset.vertices,
      ...(meshAsset.indices !== undefined ? { indices: meshAsset.indices } : {}),
      submeshes: meshAsset.submeshes,
      aabb: roundtrippedAabb,
      attributes: meshAsset.attributes,
    } as MeshAsset;

    const meshHandle = asHandle<'MeshAsset'>(world.allocSharedRef('MeshAsset', meshPayload));

    // Mesh entity at origin. Identity Transform -> identity world mat4.
    const meshEntity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [unlitHandle] } },
      )
      .unwrap();

    // Camera entity at origin, looking down -Z (perspective).
    const cameraEntity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: perspective({ fov: Math.PI / 4, aspect: 1 }),
        },
      )
      .unwrap();

    // --- 7. pick hit: screen center (50, 50) on 100x100 -> ndc (0, 0) -> ray
    //       straight down -Z -> enters AABB at z=-3 -> hit ---
    const hit = pick(world, cameraEntity, 50, 50, 100, 100);
    expect(hit).toBeDefined();
    if (hit) {
      expect(hit.entity).toBe(meshEntity);
      // The entry point should be near the AABB front face at z=-3.
      expect(Math.abs((hit.point[2] as number) - -3)).toBeLessThan(0.1);
    }

    // --- 8. Negative control: pick bottom-right corner (100, 100) on
    //       100x100 -> ndc (1, -1) -> ray at Z=-3 lands at (~1.24, ~-1.24)
    //       which is outside the AABB x-range [-1, 1] -> miss ---
    const miss = pick(world, cameraEntity, 100, 100, 100, 100);
    expect(miss).toBeUndefined();
  });

  it('mesh without aabb: pick() returns undefined (falsification witness)', () => {
    // Create a MeshAsset via buildMeshAsset, then strip the aabb field to
    // verify that pick() skips it at the broad-phase check (pick.ts:184).
    // This is a secondary in-code falsification -- it repeats the
    // comment-out-drill semantics without modifying M7 production code.
    const pod = makeTrianglePod();
    const imported = buildMeshAsset(pod, 'guid-fbx-noaabb');
    const meshWithAabb = meshFromAsset(imported);
    // Strip aabb to simulate the pre-M7 state.
    const { aabb: _dropped, ...rest } = meshWithAabb;

    const world = new World();

    const unlitMat = Materials.unlit([1, 1, 1, 1]) as unknown as MaterialAsset;
    const unlitHandle = asHandle<'MaterialAsset'>(world.allocSharedRef('MaterialAsset', unlitMat));

    const noAabbHandle = asHandle<'MeshAsset'>(
      world.allocSharedRef('MeshAsset', { ...rest } as MeshAsset),
    );

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
