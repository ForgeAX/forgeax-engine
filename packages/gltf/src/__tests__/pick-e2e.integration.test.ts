import { AssetRegistry } from '@forgeax/engine-assets-runtime';
// glTF producer bounds survive pack JSON transport and managed admission before picking.

import { World } from '@forgeax/engine-ecs';
import { packMeshBin } from '@forgeax/engine-import';
import { decodeMeshBinHeader } from '@forgeax/engine-pack';
import { pick } from '@forgeax/engine-picking';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, describe, expect, it } from 'vitest';
import type { GltfMeshIr } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

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
    const assets = new AssetRegistry();
    const world = new World({ assets });

    // Material for MeshRenderer (any visible material; pick only needs
    // the MeshFilter + MeshRenderer presence on the archetype).
    const unlitMat = Materials.unlit([1, 1, 1, 1]);
    const unlitHandle = assets.create(unlitMat).unwrap();

    // Reconstruct the MeshAsset payload with the roundtripped aabb and
    // original typed arrays. Use a cast since exactOptionalPropertyTypes
    // forbids spreading optional fields that resolve to undefined.
    const meshPayload = {
      kind: 'mesh' as const,
      vertices: meshAsset.vertices,
      ...(meshAsset.indices !== undefined ? { indices: meshAsset.indices } : {}),
      submeshes: meshAsset.submeshes,
      materialSlots: meshAsset.materialSlots,
      aabb: roundtrippedAabb,
      attributes: meshAsset.attributes,
    } as MeshAsset;

    const meshHandle = assets.create(meshPayload).unwrap();

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

  it('derives missing author bounds before picking and rejects incomplete attributes', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });

    const unlitMat = Materials.unlit([1, 1, 1, 1]);
    const unlitHandle = assets.create(unlitMat).unwrap();

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
      attributes: { position: new Float32Array([-1, -1, -3, 1, -1, -3, 0, 1, -3]) },
    } satisfies MeshAsset;

    expect(assets.create({ ...noAabbMesh, attributes: {} }).ok).toBe(false);
    const noAabbHandle = assets.create(noAabbMesh).unwrap();
    const bounds = assets.read(noAabbHandle).unwrap().aabb;
    assert(bounds);
    expect(Array.from(bounds)).toEqual([-1, -1, -3, 1, 1, -3]);

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

    expect(pick(world, cameraEntity, 50, 50, 100, 100)).toBeDefined();
    expect(pick(world, cameraEntity, 100, 100, 100, 100)).toBeUndefined();
  });
});
