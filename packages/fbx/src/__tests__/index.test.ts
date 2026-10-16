import type { ImportedAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { FbxRawMesh } from '../parse-mesh.js';
import { parseMesh } from '../parse-mesh.js';
import { buildMeshAsset } from '../to-asset-pack.js';

describe('@forgeax/engine-fbx', () => {
  it('exports initFbxWasm', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.initFbxWasm).toBe('function');
  });

  it('exports parseFbx', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.parseFbx).toBe('function');
  });

  it('exports parseFbxToObject', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.parseFbxToObject).toBe('function');
  });

  it('exports isFbxWasmReady', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.isFbxWasmReady).toBe('function');
  });

  it('isFbxWasmReady returns false before init', async () => {
    const mod = await import('../index.js');
    expect(mod.isFbxWasmReady()).toBe(false);
  });

  it('parseFbx throws before init', async () => {
    const mod = await import('../index.js');
    expect(() => mod.parseFbx(new Uint8Array(0))).toThrow('WASM not initialized');
  });
});

describe('@forgeax/engine-fbx barrel', () => {
  it('exports fbxImporter with key "fbx"', async () => {
    const mod = await import('../index.js');
    expect(mod.fbxImporter.key).toBe('fbx');
    expect(typeof mod.fbxImporter.import).toBe('function');
  });

  it('exports the parse-*.ts bridge layer + toAssetPack', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.parseMesh).toBe('function');
    expect(typeof mod.parseScene).toBe('function');
    expect(typeof mod.parseMaterial).toBe('function');
    expect(typeof mod.parseSkeleton).toBe('function');
    expect(typeof mod.parseSkin).toBe('function');
    expect(typeof mod.parseAnimationClips).toBe('function');
    expect(typeof mod.parseTextures).toBe('function');
    expect(typeof mod.resolveFbxTexturePath).toBe('function');
    expect(typeof mod.toAssetPack).toBe('function');
    expect(typeof mod.fbxErr).toBe('function');
  });
});

// ── M6: buildMeshAsset aabb — GREEN (M7 make-green) ─────────────────

/** Extract MeshAsset payload from an ImportedAsset (guards kind='mesh'). */
function meshFromAsset(asset: ImportedAsset): MeshAsset {
  if (asset.kind !== 'mesh') throw new TypeError(`expected mesh, got ${asset.kind}`);
  return asset.payload as MeshAsset;
}

/** Build a mock FbxRawMesh with no indices (per-vertex attributes only). */
function mockRawMesh(vertices: number[], attributes?: Record<string, number[]>): FbxRawMesh {
  return {
    name: 'AabbTestMesh',
    vertices,
    attributes: attributes ?? {},
    polygonCount: Math.max(0, Math.floor(vertices.length / 9)),
    sourceIndex: 0,
    materialIndex: -1,
  };
}

describe('buildMeshAsset aabb (GREEN)', () => {
  it('m6-1a: normal quad — aabb matches position min/max', () => {
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const raw = mockRawMesh(vertices);
    const pod = parseMesh(raw, 0);
    const asset = buildMeshAsset(pod, 'guid-quad');
    const mesh = meshFromAsset(asset);

    // aabb should be Float32Array(6) = [minX, minY, minZ, maxX, maxY, maxZ]
    // from vertices pod: minX=0, minY=0, minZ=0, maxX=1, maxY=1, maxZ=0
    const aabb = mesh.aabb;
    expect(aabb, 'aabb must be defined').toBeDefined();
    expect(aabb).toBeInstanceOf(Float32Array);
    expect(aabb?.length).toBe(6);

    // Normal quad: vertices [(0,0,0),(1,0,0),(0,1,0),(1,1,0)]
    // biome and tsc strict guards: use ?. and as number for Float32Array index access
    expect(aabb?.[0] as number, 'minX').toBe(0);
    expect(aabb?.[1] as number, 'minY').toBe(0);
    expect(aabb?.[2] as number, 'minZ').toBe(0);
    expect(aabb?.[3] as number, 'maxX').toBe(1);
    expect(aabb?.[4] as number, 'maxY').toBe(1);
    expect(aabb?.[5] as number, 'maxZ').toBe(0);
  });

  it('m6-1b: single point — min == max for all axes', () => {
    const vertices = [5, 5, 5];
    const raw = mockRawMesh(vertices);
    const pod = parseMesh(raw, 0);
    const asset = buildMeshAsset(pod, 'guid-point');
    const mesh = meshFromAsset(asset);

    const aabb = mesh.aabb;
    expect(aabb, 'aabb must be defined').toBeDefined();
    expect(aabb?.length).toBe(6);

    expect(aabb?.[0] as number, 'minX').toBe(5);
    expect(aabb?.[1] as number, 'minY').toBe(5);
    expect(aabb?.[2] as number, 'minZ').toBe(5);
    expect(aabb?.[3] as number, 'maxX').toBe(5);
    expect(aabb?.[4] as number, 'maxY').toBe(5);
    expect(aabb?.[5] as number, 'maxZ').toBe(5);
  });

  it('m6-1c: empty vertices — inverted-empty box, no NaN', () => {
    const vertices: number[] = [];
    const raw = mockRawMesh(vertices);
    const pod = parseMesh(raw, 0);
    const asset = buildMeshAsset(pod, 'guid-empty');
    const mesh = meshFromAsset(asset);

    const aabb = mesh.aabb;
    expect(aabb, 'aabb must be defined for empty mesh').toBeDefined();
    expect(aabb?.length).toBe(6);

    // Inverted-empty box convention: min.x > max.x (from box3.fromPositions
    // when positions.length < 3). This signals "no volume" to pick.ts which
    // skips the entity (AC-07).
    expect(aabb?.[0] as number, 'minX').toBeGreaterThan(aabb?.[3] as number);
    // No NaN anywhere
    for (let i = 0; i < 6; i++) {
      expect(Number.isNaN(aabb?.[i] ?? 0), `aabb[${i}] must not be NaN`).toBe(false);
    }
  });

  it('m6-1d: degenerate plane (Y=0) — one axis min==max, still pickable', () => {
    const vertices = [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1];
    const raw = mockRawMesh(vertices);
    const pod = parseMesh(raw, 0);
    const asset = buildMeshAsset(pod, 'guid-plane');
    const mesh = meshFromAsset(asset);

    const aabb = mesh.aabb;
    expect(aabb, 'aabb must be defined').toBeDefined();
    expect(aabb?.length).toBe(6);

    // Degenerate in Y (all Y=0) => minY == maxY == 0
    expect(aabb?.[0] as number, 'minX').toBe(0);
    expect(aabb?.[1] as number, 'minY').toBe(0);
    expect(aabb?.[2] as number, 'minZ').toBe(0);
    expect(aabb?.[3] as number, 'maxX').toBe(1);
    expect(aabb?.[4] as number, 'maxY').toBe(0);
    expect(aabb?.[5] as number, 'maxZ').toBe(1);

    // Verify degenerate condition: Y axis has zero thickness
    expect(aabb?.[1] as number).toBe(aabb?.[4] as number);
  });
});
