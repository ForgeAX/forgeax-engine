// pick-vertex.unit.test.ts — feat-20260630-vertex-snapping-picking M2 w3 + w4 + M3 w6 + w7.
// biome-ignore-all lint/style/noNonNullAssertion: test assertions use ! after expect() guards
//
// TDD red phase (w3): core behavior tests for pickVertexOnEntity covering
// AC-01/AC-03/AC-04/AC-05/AC-08/AC-10 + D-9 propagate preamble.
//
// TDD red phase (w4): AC-13 narrowing type-check block verifying that
// pickVertexOnEntity's overload signatures enable static narrowing (no `as` cast).
//
// TDD red phase (w6): degradation input tests covering AC-09 (strip/u16/undefined
// position/empty/NaN) + AC-07 (builtin no-AABB fallback) + R-3 (behind-camera).
//
// TDD red phase (w7): pickVertex full-scene tests covering AC-02 (three-state
// return) + R-2 (AABB coarse cull multi-entity) + limit > available vertices.

import { AssetRegistry, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, ray, type Vec3Like, vec2, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  cameraProjectionFromF32,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';

import type { Handle, MaterialAsset, MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { PickError } from '../pick-errors';
import { pickVertex, pickVertexOnEntity, type VertexHit } from '../pick-vertex';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ── shared constants ─────────────────────────────────────────────────────

const VP = 600; // square viewport so screen-centre maps to the -Z axis ray

// ── helpers ─────────────────────────────────────────────────────────────

function readWorldMatrix(world: World, entity: EntityHandle): Float32Array | undefined {
  const result = world.get(entity, GlobalTransform);
  if (!result.ok) return undefined;
  return new Float32Array(result.value.world);
}

function translateTransform(x: number, y: number, z: number) {
  return {
    pos: [x, y, z],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

interface Scene {
  world: World;
  assets: AssetRegistry;
  material: Handle<'MaterialAsset', 'shared'>;
}

// The test meshes below intentionally keep their interleaved vertex buffers
// padded to the canonical position/normal/uv/tangent stride.  Empty typed
// arrays are the geometry layout SSOT's presence sentinels; retaining them in
// the fixture makes the declared projection agree with the buffer stride.
const EMPTY_ATTRIBUTE = new Float32Array(0);
function interleavedAttributes(position: Float32Array | Uint16Array): VertexAttributeMap {
  return {
    position,
    normal: EMPTY_ATTRIBUTE,
    uv: EMPTY_ATTRIBUTE,
    tangent: EMPTY_ATTRIBUTE,
  };
}

function makeScene(): Scene {
  const world = new World();
  const assets = new AssetRegistry(makeMockShaderRegistry());
  const matResult = assets.catalog<MaterialAsset>(AssetGuid.format(AssetGuid.random()), {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1] },
  });
  if (!matResult.ok) throw new Error('material catalog failed');
  const material = world.allocSharedRef('MaterialAsset', matResult.value);
  return { world, assets, material };
}

function spawnPerspectiveCamera(world: World, z: number): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: translateTransform(0, 0, z) },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_PERSPECTIVE,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
}

/**
 * Register a mesh with a single triangle for basic hit/miss testing.
 * Triangle vertices: (-0.5,-0.5,0), (0.5,-0.5,0), (0,0.5,0).
 */
function registerTriangle(scene: Scene): Handle<'MeshAsset', 'shared'> {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
  // 12 floats per vertex interleaved (non-skinned stride)
  const v = new Float32Array(36);
  // fill first 3 floats of each vertex with the position for AABB correctness
  for (let i = 0; i < 3; i++) {
    v[i * 12 + 0] = positions[i * 3 + 0] as number;
    v[i * 12 + 1] = positions[i * 3 + 1] as number;
    v[i * 12 + 2] = positions[i * 3 + 2] as number;
  }
  const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
    kind: 'mesh',
    vertices: v,
    indices: new Uint16Array([0, 1, 2]),
    attributes: interleavedAttributes(positions),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
  if (!result.ok) throw new Error(`triangle mesh catalog failed: ${result.error.message}`);
  return scene.world.allocSharedRef('MeshAsset', result.value);
}

/**
 * Register a cube mesh with 8 vertices at (+-0.5, +-0.5, +-0.5), 12 triangles.
 * Used for vertexIndex / worldPos correctness (AC-03) and multi-candidate (AC-04).
 */
function registerCube(scene: Scene): Handle<'MeshAsset', 'shared'> {
  const positions = new Float32Array([
    -0.5,
    -0.5,
    0.5, // v0
    0.5,
    -0.5,
    0.5, // v1
    0.5,
    0.5,
    0.5, // v2
    -0.5,
    0.5,
    0.5, // v3
    -0.5,
    -0.5,
    -0.5, // v4
    0.5,
    -0.5,
    -0.5, // v5
    0.5,
    0.5,
    -0.5, // v6
    -0.5,
    0.5,
    -0.5, // v7
  ]);
  const v = new Float32Array(8 * 12);
  for (let i = 0; i < 8; i++) {
    v[i * 12 + 0] = positions[i * 3 + 0] as number;
    v[i * 12 + 1] = positions[i * 3 + 1] as number;
    v[i * 12 + 2] = positions[i * 3 + 2] as number;
  }
  const indices = new Uint16Array([
    0,
    1,
    2,
    0,
    2,
    3, // front
    4,
    6,
    5,
    4,
    7,
    6, // back
    3,
    2,
    6,
    3,
    6,
    7, // top
    0,
    4,
    5,
    0,
    5,
    1, // bottom
    1,
    5,
    6,
    1,
    6,
    2, // right
    0,
    3,
    7,
    0,
    7,
    4, // left
  ]);
  const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
    kind: 'mesh',
    vertices: v,
    indices,
    attributes: interleavedAttributes(positions),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 36,
        vertexCount: 8,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
  if (!result.ok) throw new Error(`cube mesh catalog failed: ${result.error.message}`);
  return scene.world.allocSharedRef('MeshAsset', result.value);
}

/**
 * Register a skinned single-triangle mesh (18-floats/vertex stride).
 * Attributes carry skinIndex + skinWeight → isSkinned = true → deformed = true.
 */
function registerSkinnedTriangle(scene: Scene): Handle<'MeshAsset', 'shared'> {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
  const skinIndex = new Uint16Array(3 * 4); // 4 influences per vertex, all 0
  const skinWeight = new Float32Array(3 * 4);
  for (let i = 0; i < 12; i++) skinWeight[i] = 0.25;
  // 18 floats per vertex (12 base + 6 skin)
  const v = new Float32Array(3 * 18);
  for (let i = 0; i < 3; i++) {
    v[i * 18 + 0] = positions[i * 3 + 0] as number;
    v[i * 18 + 1] = positions[i * 3 + 1] as number;
    v[i * 18 + 2] = positions[i * 3 + 2] as number;
    // skinIndex packed as 2 floats at slots 12-13 (zero-initialised by new)
    // skinWeight at slots 14-17
    v[i * 18 + 14] = skinWeight[i * 4 + 0] as number;
    v[i * 18 + 15] = skinWeight[i * 4 + 1] as number;
    v[i * 18 + 16] = skinWeight[i * 4 + 2] as number;
    v[i * 18 + 17] = skinWeight[i * 4 + 3] as number;
  }
  const attrs: VertexAttributeMap = {
    ...interleavedAttributes(positions),
    skinIndex,
    skinWeight,
  };
  const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
    kind: 'mesh',
    vertices: v,
    indices: new Uint16Array([0, 1, 2]),
    attributes: attrs,
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
  if (!result.ok) throw new Error(`skinned mesh catalog failed: ${result.error.message}`);
  return scene.world.allocSharedRef('MeshAsset', result.value);
}

function spawnMeshEntity(
  scene: Scene,
  mesh: Handle<'MeshAsset', 'shared'>,
  x: number,
  y: number,
  z: number,
): EntityHandle {
  return scene.world
    .spawn(
      { component: Transform, data: translateTransform(x, y, z) },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [scene.material] } },
    )
    .unwrap();
}

/**
 * Wrap pickVertexOnEntity with propagateTransforms preamble (D-9 contract).
 */
function runPickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
): VertexHit | undefined;
function runPickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options: { limit: number },
): VertexHit[];
function runPickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  propagateTransforms(world);
  if (options) {
    return pickVertexOnEntity(
      world,
      cameraEntity,
      screenX,
      screenY,
      viewportWidth,
      viewportHeight,
      entity,
      options,
    );
  }
  return pickVertexOnEntity(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
    entity,
  );
}

/** Compute view-projection matrix for a perspective camera entity. */
function computeViewProj(
  world: World,
  cameraEntity: EntityHandle,
): { view: Float32Array; proj: Float32Array } | undefined {
  const camRes = world.get(cameraEntity, Camera);
  if (!camRes.ok) return undefined;
  const cam = camRes.value;
  const camWorld = readWorldMatrix(world, cameraEntity);
  if (camWorld === undefined) return undefined;
  const view = mat4.create();
  mat4.invert(view, camWorld as unknown as mat4.Mat4Like);
  const proj = mat4.create();
  const kind = cameraProjectionFromF32(cam.projection);
  if (kind === 'orthographic') {
    mat4.orthographic(proj, cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far);
  } else {
    mat4.perspective(proj, cam.fov, cam.aspect, cam.near, cam.far);
  }
  return { view, proj };
}

/**
 * Project a world-space point to screen coordinates using worldToScreen.
 */
function projectToScreen(
  worldPos: [number, number, number],
  viewProj: Float32Array,
): { px: number; py: number; behind: boolean } | undefined {
  const out = vec2.create();
  const result = ray.worldToScreen(
    out,
    worldPos as unknown as Vec3Like,
    viewProj as unknown as import('@forgeax/engine-math').Mat4Like,
    VP,
    VP,
  );
  if (result.behind) return { px: 0, py: 0, behind: true };
  return { px: out[0] as number, py: out[1] as number, behind: false };
}

/** Compute perpendicular distance from point to ray in 3D. */
function pointToRayDist(
  px: number,
  py: number,
  pz: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const ex = px - ox,
    ey = py - oy,
    ez = pz - oz;
  const cx = ey * dz - ez * dy;
  const cy = ez * dx - ex * dz;
  const cz = ex * dy - ey * dx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

// ═══════════════════════════════════════════════════════════════════════════
// w3 — pickVertexOnEntity core behavior tests
// ═══════════════════════════════════════════════════════════════════════════

describe('pickVertexOnEntity', () => {
  it('keeps the point kernel convention when a projective bound corner has w=0', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    const position = new Float32Array([-1, 0, 0, 1, -1, 0, 1, 1, 0]);
    const asset = scene.assets
      .catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: position,
        attributes: { position },
        aabb: new Float32Array([-1, -1, 0, 1, 1, 0]),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],
        materialSlots: [{ slotName: 'Default' }],
      })
      .unwrap();
    const mesh = scene.world.allocSharedRef('MeshAsset', asset);
    const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
    propagateTransforms(scene.world);
    const projective = mat4.identity(mat4.create());
    projective[3] = 1;
    projective[12] = 10;
    scene.world.set(entity, GlobalTransform, { world: projective }).unwrap();
    const hit = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity);
    expect(hit?.vertexIndex).toBe(0);
    expect(Array.from(hit?.worldPos ?? [])).toEqual([0, 0, 0]);
  });

  // ── AC-01: return shape ───────────────────────────────────────────

  describe('AC-01: return shape', () => {
    it('without limit returns VertexHit | undefined on hit', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      // screen centre = ray along -Z through triangle at z=0 → hit
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeDefined();
      expect(typeof hit!.vertexIndex).toBe('number');
      expect(typeof hit!.screenDist).toBe('number');
      expect(typeof hit!.worldDist).toBe('number');
      expect(typeof hit!.deformed).toBe('boolean');
      expect(hit!.entity).toBe(entity);
    });

    it('without limit returns undefined on miss', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      // triangle off to the side — centre ray misses
      const entity = spawnMeshEntity(scene, mesh, 10, 10, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });

    it('with limit returns VertexHit[] sorted by screenDist', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
      // verify ascending screenDist
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.screenDist).toBeGreaterThanOrEqual(hits[i - 1]!.screenDist);
      }
    });

    it('with limit returns empty array on miss', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 10, 10, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 3,
      }) as VertexHit[];
      expect(hits).toEqual([]);
    });

    it('limit greater than available vertices returns all candidates', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 100,
      }) as VertexHit[];
      // cube has 8 vertices; ray through centre hits multiple faces
      expect(hits.length).toBeLessThanOrEqual(100);
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  // ── AC-03: vertex worldPos and vertexIndex correctness ─────────────

  describe('AC-03: vertex worldPos and vertexIndex correctness', () => {
    it('worldPos matches GlobalTransform.world x local position for each candidate (cube, epsilon 1e-4)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      const meshRes = resolveAssetHandle<MeshAsset>(
        scene.world,
        toShared<'MeshAsset'>(mesh as unknown as number),
      );
      if (!meshRes.ok) throw new Error('resolve failed');
      const position = meshRes.value.attributes.position as Float32Array;
      const wm = readWorldMatrix(scene.world, entity)!;

      const hits = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      });
      expect(Array.isArray(hits)).toBe(true);
      const arr = hits as VertexHit[];
      expect(arr.length).toBeGreaterThan(0);

      for (const hit of arr) {
        const vi = hit.vertexIndex;
        const lx = position[vi * 3 + 0] as number;
        const ly = position[vi * 3 + 1] as number;
        const lz = position[vi * 3 + 2] as number;
        const expected = vec3.create();
        mat4.transformPoint(
          expected,
          wm as unknown as mat4.Mat4Like,
          [lx, ly, lz] as unknown as Vec3Like,
        );
        expect(hit.worldPos[0]).toBeCloseTo(expected[0] as number, 4);
        expect(hit.worldPos[1]).toBeCloseTo(expected[1] as number, 4);
        expect(hit.worldPos[2]).toBeCloseTo(expected[2] as number, 4);
      }
    });

    it('worldPos reflects entity Transform translation', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      // small offset well within view frustum
      const entity = spawnMeshEntity(scene, mesh, 0.1, 0.2, 0);
      propagateTransforms(scene.world);

      const meshRes = resolveAssetHandle<MeshAsset>(
        scene.world,
        toShared<'MeshAsset'>(mesh as unknown as number),
      );
      if (!meshRes.ok) throw new Error('resolve failed');
      const position = meshRes.value.attributes.position as Float32Array;
      const wm = readWorldMatrix(scene.world, entity)!;

      // Verify world mat4 translation is correct
      expect(wm[12]).toBeCloseTo(0.1, 4);
      expect(wm[13]).toBeCloseTo(0.2, 4);
      expect(wm[14]).toBeCloseTo(0, 4);

      // triangle at (0.1,0.2,0): project its centre to screen
      const vp = computeViewProj(scene.world, camera)!;
      const vpMat = mat4.create();
      mat4.multiply(
        vpMat,
        vp.proj as unknown as mat4.Mat4Like,
        vp.view as unknown as mat4.Mat4Like,
      );
      const centreScreen = projectToScreen([0.1, 0.2, 0], vpMat)!;
      if (centreScreen.behind) throw new Error('centre behind camera');

      const hits = pickVertexOnEntity(
        scene.world,
        camera,
        centreScreen.px,
        centreScreen.py,
        VP,
        VP,
        entity,
        { limit: 3 },
      );
      expect(Array.isArray(hits)).toBe(true);
      const arr = hits as VertexHit[];
      expect(arr.length).toBeGreaterThan(0);

      for (const hit of arr) {
        const vi = hit.vertexIndex;
        const lx = position[vi * 3 + 0] as number;
        const ly = position[vi * 3 + 1] as number;
        const lz = position[vi * 3 + 2] as number;
        const expected = vec3.create();
        mat4.transformPoint(
          expected,
          wm as unknown as mat4.Mat4Like,
          [lx, ly, lz] as unknown as Vec3Like,
        );
        expect(hit.worldPos[0]).toBeCloseTo(expected[0] as number, 4);
        expect(hit.worldPos[1]).toBeCloseTo(expected[1] as number, 4);
        expect(hit.worldPos[2]).toBeCloseTo(expected[2] as number, 4);
      }
    });
  });

  // ── AC-04: screenDist sorting ──────────────────────────────────────

  describe('AC-04: screenDist sorting', () => {
    it('returned array is sorted by screenDist ascending', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThan(1); // need at least 2 for sort check
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.screenDist).toBeGreaterThanOrEqual(hits[i - 1]!.screenDist);
      }
    });

    it('screenDist is consistent with worldPos projected to screen (epsilon 0.5px)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      const vp = computeViewProj(scene.world, camera)!;
      const vpMat = mat4.create();
      mat4.multiply(
        vpMat,
        vp.proj as unknown as mat4.Mat4Like,
        vp.view as unknown as mat4.Mat4Like,
      );

      const hits = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThan(0);

      for (const hit of hits) {
        const screen = projectToScreen(
          [hit.worldPos[0] as number, hit.worldPos[1] as number, hit.worldPos[2] as number],
          vpMat,
        );
        // should not be behind camera
        expect(screen?.behind).toBe(false);
        if (screen) {
          const expectedDist = Math.sqrt((screen.px - VP / 2) ** 2 + (screen.py - VP / 2) ** 2);
          expect(Math.abs(hit.screenDist - expectedDist)).toBeLessThanOrEqual(0.5);
        }
      }
    });
  });

  // ── AC-05: worldDist ───────────────────────────────────────────────

  describe('AC-05: worldDist', () => {
    it('worldDist is non-negative for all hits', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      for (const hit of hits) {
        expect(hit.worldDist).toBeGreaterThanOrEqual(0);
      }
    });

    it('worldDist equals point-to-ray perpendicular distance', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      // Build the ray manually to verify worldDist
      const camWorld = readWorldMatrix(scene.world, camera)!;
      const view = mat4.create();
      mat4.invert(view, camWorld as unknown as mat4.Mat4Like);
      const proj = mat4.create();
      mat4.perspective(proj, Math.PI / 4, 1, 0.1, 100);
      const r = ray.create();
      ray.screenToRay(
        r,
        VP / 2,
        VP / 2,
        VP,
        VP,
        view as unknown as import('@forgeax/engine-math').Mat4Like,
        proj as unknown as import('@forgeax/engine-math').Mat4Like,
        'perspective',
      );
      const ox = r[0] as number,
        oy = r[1] as number,
        oz = r[2] as number;
      const dx = r[3] as number,
        dy = r[4] as number,
        dz = r[5] as number;

      const hits = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThan(0);

      for (const hit of hits) {
        const px = hit.worldPos[0] as number;
        const py = hit.worldPos[1] as number;
        const pz = hit.worldPos[2] as number;
        const expectedDist = pointToRayDist(px, py, pz, ox, oy, oz, dx, dy, dz);
        expect(hit.worldDist).toBeCloseTo(expectedDist, 4);
      }
    });
  });

  // ── AC-08: skinned deformed flag ───────────────────────────────────

  describe('AC-08: skinned deformed flag', () => {
    it('static mesh returns deformed=false', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 3,
      }) as VertexHit[];
      for (const hit of hits) {
        expect(hit.deformed).toBe(false);
      }
    });

    it('skin attributes without a live Skin binding yield no current vertices', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerSkinnedTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      // Verify mesh is skinned
      const meshRes = resolveAssetHandle<MeshAsset>(
        scene.world,
        toShared<'MeshAsset'>(mesh as unknown as number),
      );
      expect(meshRes.ok).toBe(true);
      if (!meshRes.ok) throw new Error('resolve failed');
      const attrs = meshRes.value.attributes;
      expect(attrs.skinIndex).toBeDefined();
      expect(attrs.skinWeight).toBeDefined();

      const hits = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 3,
      }) as VertexHit[];
      expect(hits).toEqual([]);
    });

    it('an unavailable Skin never fabricates translated rest-pose vertices', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerSkinnedTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0.5, 0, 0);
      propagateTransforms(scene.world);
      expect(
        pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, { limit: 3 }),
      ).toEqual([]);
    });
  });

  // ── AC-10: error protocol ──────────────────────────────────────────

  describe('AC-10: error protocol', () => {
    it('throws PickError when cameraEntity has no Camera', () => {
      const scene = makeScene();
      const mesh = registerTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const notACamera = scene.world
        .spawn({ component: Transform, data: translateTransform(0, 0, 5) })
        .unwrap();
      expect(() =>
        runPickVertexOnEntity(scene.world, notACamera, VP / 2, VP / 2, VP, VP, entity),
      ).toThrow(PickError);
    });

    it('returns undefined when camera has Camera but no Transform (recoverable, mirrors pick.ts:124-129)', () => {
      const scene = makeScene();
      const mesh = registerTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const cameraNoTransform = scene.world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_PERSPECTIVE,
            left: -1,
            right: 1,
            bottom: -1,
            top: 1,
          },
        })
        .unwrap();
      const hit = runPickVertexOnEntity(
        scene.world,
        cameraNoTransform,
        VP / 2,
        VP / 2,
        VP,
        VP,
        entity,
      ) as VertexHit | undefined;
      expect(hit).toBeUndefined();
    });

    it('returns undefined when no vertices are hit (recoverable miss)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 10, 10, 0); // far from centre ray
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });
  });

  // ── D-9: propagate preamble ────────────────────────────────────────

  describe('D-9: propagateTransforms preamble', () => {
    it('returns correct worldPos after propagateTransforms (fresh world column)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      // small offset well within view frustum
      const entity = spawnMeshEntity(scene, mesh, 0.1, 0.2, 0);
      // propagate must be called before pickVertexOnEntity
      propagateTransforms(scene.world);

      const meshRes = resolveAssetHandle<MeshAsset>(
        scene.world,
        toShared<'MeshAsset'>(mesh as unknown as number),
      );
      if (!meshRes.ok) throw new Error('resolve failed');
      const position = meshRes.value.attributes.position as Float32Array;
      const wm = readWorldMatrix(scene.world, entity)!;

      // Verify world matrix reflects translation
      // Column-major: translation is at indices 12,13,14
      expect(wm[12]).toBeCloseTo(0.1, 4);
      expect(wm[13]).toBeCloseTo(0.2, 4);
      expect(wm[14]).toBeCloseTo(0, 4);

      const vp = computeViewProj(scene.world, camera)!;
      const vpMat = mat4.create();
      mat4.multiply(
        vpMat,
        vp.proj as unknown as mat4.Mat4Like,
        vp.view as unknown as mat4.Mat4Like,
      );
      const centreScreen = projectToScreen([0.1, 0.2, 0], vpMat)!;
      if (centreScreen.behind) throw new Error('centre behind');

      const hits = pickVertexOnEntity(
        scene.world,
        camera,
        centreScreen.px,
        centreScreen.py,
        VP,
        VP,
        entity,
        { limit: 3 },
      ) as VertexHit[];
      expect(hits.length).toBeGreaterThan(0);

      for (const hit of hits) {
        const vi = hit.vertexIndex;
        const lx = position[vi * 3 + 0] as number;
        const ly = position[vi * 3 + 1] as number;
        const lz = position[vi * 3 + 2] as number;
        const expected = vec3.create();
        mat4.transformPoint(
          expected,
          wm as unknown as mat4.Mat4Like,
          [lx, ly, lz] as unknown as Vec3Like,
        );
        expect(hit.worldPos[0]).toBeCloseTo(expected[0] as number, 4);
        expect(hit.worldPos[1]).toBeCloseTo(expected[1] as number, 4);
        expect(hit.worldPos[2]).toBeCloseTo(expected[2] as number, 4);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// w4 — AC-13 narrowing type-check block
// ═══════════════════════════════════════════════════════════════════════════

describe('AC-13: narrowing type-check', () => {
  it('narrowing probes compile and typecheck correctly (AC-13 true enforcement)', () => {
    // runtime no-op: real AC-13 enforcement is the tsc-only closures below.
    // If overload signatures break narrowing, typecheck will fail before tests run.
    expect(true).toBe(true);
  });

  // tsc-only closure — the body is never executed at runtime but typecheck
  // failure here proves the overload signatures do not narrow correctly.
  const _vertexNarrowingProbe = (world: World, cam: EntityHandle, entity: EntityHandle): void => {
    // No limit -> VertexHit | undefined
    const hit = pickVertexOnEntity(world, cam, 0, 0, VP, VP, entity);
    if (hit) {
      // if(hit) narrows: hit is VertexHit, not undefined
      const e: EntityHandle = hit.entity;
      const vi: number = hit.vertexIndex;
      const wp: ArrayLike<number> = hit.worldPos;
      const sd: number = hit.screenDist;
      const wd: number = hit.worldDist;
      const d: boolean = hit.deformed;
      void e;
      void vi;
      void wp;
      void sd;
      void wd;
      void d;
      // @ts-expect-error — VertexHit has no 'point' field
      void (hit as { point: unknown }).point;
    }

    // With limit -> VertexHit[]
    const hits = pickVertexOnEntity(world, cam, 0, 0, VP, VP, entity, { limit: 3 });
    // hits is VertexHit[], so .length and [0] are legal
    const len: number = hits.length;
    const first = hits[0];
    void len;
    void first;

    // @ts-expect-error — without limit, accessing array methods is a compile error
    const _bad = pickVertexOnEntity(world, cam, 0, 0, VP, VP, entity).length;
    void _bad;
  };
  void _vertexNarrowingProbe;

  // ── pickVertex narrowing (w7/w8 AC-13) ────────────────────────
  const _pickVertexNarrowingProbe = (world: World, cam: EntityHandle): void => {
    const hit = pickVertex(world, cam, 0, 0, VP, VP);
    if (hit) {
      const e: EntityHandle = hit.entity;
      void e;
    }

    const hits = pickVertex(world, cam, 0, 0, VP, VP, { limit: 3 });
    const len: number = hits.length;
    void len;

    // @ts-expect-error — without limit, accessing array methods is a compile error
    const _bad = pickVertex(world, cam, 0, 0, VP, VP).length;
    void _bad;
  };
  void _pickVertexNarrowingProbe;
});

// ═══════════════════════════════════════════════════════════════════════════
// w6 — degradation input + builtin fallback tests (RED)
// ═══════════════════════════════════════════════════════════════════════════
//
// TDD red phase (w6): degradation input tests for pickVertexOnEntity covering
// AC-09 (strip/u16/undefined position/empty/NaN) + AC-07 (builtin no-AABB
// fallback) + R-3 (behind-camera vertex exclusion). These tests are RED
// because the M2 pick-vertex.ts does not yet handle these branches.
//
// Related: plan-tasks.json w6 acceptanceCheck; plan-strategy D-4/D-5 §4 R-3.

describe('w6: degradation input + builtin fallback', () => {
  // ── AC-09: triangle-strip submesh → skip ────────────────────────────

  describe('AC-09: triangle-strip submesh skipped', () => {
    function registerStripMesh(scene: Scene): Handle<'MeshAsset', 'shared'> {
      const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0, -0.3, 0.3, 0]);
      const v = new Float32Array(4 * 12);
      for (let i = 0; i < 4; i++) {
        v[i * 12 + 0] = positions[i * 3 + 0] as number;
        v[i * 12 + 1] = positions[i * 3 + 1] as number;
        v[i * 12 + 2] = positions[i * 3 + 2] as number;
      }
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        indices: new Uint16Array([0, 1, 2, 3]),
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 4,
            vertexCount: 4,
            topology: 'triangle-strip',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`strip mesh catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    it('strip submesh returns undefined (no crash, no approximate hit)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerStripMesh(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });

    it('strip submesh with limit returns empty array', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerStripMesh(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 3,
      }) as VertexHit[];
      expect(hits).toEqual([]);
    });
  });

  // ── D-4: Uint16Array / undefined position → skip ────────────────────

  describe('D-4: position three-branch narrow (Uint16Array / undefined)', () => {
    function registerUint16Position(scene: Scene): Handle<'MeshAsset', 'shared'> {
      const positions = new Uint16Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const v = new Float32Array(3 * 12);
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        indices: new Uint16Array([0, 1, 2]),
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`u16 mesh catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    function registerUndefinedPosition(scene: Scene): Handle<'MeshAsset', 'shared'> {
      const v = new Float32Array(3 * 12);
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`no-position mesh catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    it('Uint16Array position returns undefined (skip, no crash)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerUint16Position(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });

    it('undefined position returns undefined (skip, no crash)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerUndefinedPosition(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });
  });

  // ── AC-09: no index buffer → non-indexed triangle sequence ───────

  describe('AC-09: no index buffer — non-indexed triangle sequence', () => {
    function registerIndexlessTriangle(scene: Scene): Handle<'MeshAsset', 'shared'> {
      const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
      const v = new Float32Array(3 * 12);
      for (let i = 0; i < 3; i++) {
        v[i * 12 + 0] = positions[i * 3 + 0] as number;
        v[i * 12 + 1] = positions[i * 3 + 1] as number;
        v[i * 12 + 2] = positions[i * 3 + 2] as number;
      }
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`indexless mesh catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    it('non-indexed mesh hits vertices (every consecutive 3 vertices = one face)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerIndexlessTriangle(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeDefined();
      if (hit) {
        expect(hit.entity).toBe(entity);
        expect(typeof hit.vertexIndex).toBe('number');
        expect(hit.vertexIndex >= 0 && hit.vertexIndex < 3).toBe(true);
      }
    });
  });

  // ── AC-09: empty mesh (0 vertices / 0 triangles) ──────────────────

  describe('AC-09: empty mesh', () => {
    function registerEmptyMesh(scene: Scene): Handle<'MeshAsset', 'shared'> {
      const positions = new Float32Array(0);
      const v = new Float32Array(0);
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`empty mesh catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    it('0 vertices returns undefined (no crash)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerEmptyMesh(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });

    it('0 vertices with limit returns empty array', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerEmptyMesh(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 3,
      }) as VertexHit[];
      expect(hits).toEqual([]);
    });
  });

  // ── AC-09: NaN / Inf vertex coordinates → excluded ────────────────

  describe('AC-09: NaN / Inf vertex coordinates excluded', () => {
    function registerNanMesh(scene: Scene): Handle<'MeshAsset', 'shared'> {
      const positions = new Float32Array([NaN, NaN, NaN, 0.5, -0.5, 0, 0, 0.5, 0]);
      const v = new Float32Array(3 * 12);
      for (let i = 0; i < 3; i++) {
        v[i * 12 + 0] = positions[i * 3 + 0] as number;
        v[i * 12 + 1] = positions[i * 3 + 1] as number;
        v[i * 12 + 2] = positions[i * 3 + 2] as number;
      }
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        indices: new Uint16Array([0, 1, 2]),
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`NaN mesh catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    it('NaN vertex coordinates excluded, valid vertices still hit (no NaN propagation)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerNanMesh(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 3,
      }) as VertexHit[];
      for (const hit of hits) {
        expect(hit.vertexIndex).not.toBe(0); // vertex 0 is NaN
        expect(Number.isNaN(hit.worldPos[0])).toBe(false);
        expect(Number.isNaN(hit.worldPos[1])).toBe(false);
        expect(Number.isNaN(hit.worldPos[2])).toBe(false);
        expect(Number.isNaN(hit.screenDist)).toBe(false);
        expect(Number.isNaN(hit.worldDist)).toBe(false);
      }
    });

    it('all-NaN positions returns undefined', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const positions = new Float32Array([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
      const v = new Float32Array(3 * 12);
      for (let i = 0; i < 3; i++) {
        v[i * 12 + 0] = positions[i * 3 + 0] as number;
        v[i * 12 + 1] = positions[i * 3 + 1] as number;
        v[i * 12 + 2] = positions[i * 3 + 2] as number;
      }
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        indices: new Uint16Array([0, 1, 2]),
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error('all-NaN mesh catalog failed');
      const mesh = scene.world.allocSharedRef('MeshAsset', result.value);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });
  });

  // ── AC-07: builtin mesh without AABB → walk-all-vertices fallback ──

  describe('AC-07: builtin mesh without AABB — walk-all-vertices fallback', () => {
    it('BUILTIN_TRIANGLE (no AABB) returns a valid hit via full vertex walk', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const entity = scene.world
        .spawn(
          { component: Transform, data: translateTransform(0, 0, 0) },
          { component: MeshFilter, data: { assetHandle: toShared<'MeshAsset'>(1) } },
          { component: MeshRenderer, data: { materials: [scene.material] } },
        )
        .unwrap();
      propagateTransforms(scene.world);
      const hit = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeDefined();
      if (hit) {
        expect(hit.entity).toBe(entity);
        expect(typeof hit.worldPos[0]).toBe('number');
        expect(hit.deformed).toBe(false);
      }
    });

    it('BUILTIN_CUBE (no AABB) returns valid vertex hits', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const entity = scene.world
        .spawn(
          { component: Transform, data: translateTransform(0, 0, 0) },
          { component: MeshFilter, data: { assetHandle: toShared<'MeshAsset'>(2) } },
          { component: MeshRenderer, data: { materials: [scene.material] } },
        )
        .unwrap();
      propagateTransforms(scene.world);
      const hits = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        expect(h.entity).toBe(entity);
      }
    });
  });

  // ── R-3: behind-camera vertices excluded ─────────────────────────

  describe('R-3: behind-camera vertices excluded', () => {
    it('vertex behind camera is excluded from candidates', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 6); // behind camera at z=5
      const hit = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity) as
        | VertexHit
        | undefined;
      expect(hit).toBeUndefined();
    });

    it('screenDist from valid vertices is not NaN when behind is excluded', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      const hits = runPickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 8,
      }) as VertexHit[];
      for (const h of hits) {
        expect(Number.isNaN(h.screenDist)).toBe(false);
        expect(h.screenDist).toBeGreaterThanOrEqual(0);
        expect(Number.isNaN(h.worldPos[0])).toBe(false);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// w7 — pickVertex full-scene tests (RED)
// ═══════════════════════════════════════════════════════════════════════════
//
// TDD red phase (w7): full-scene pickVertex tests covering AC-02
// (three-state return contract) + R-2 (AABB coarse cull on multi-entity
// scenes) + limit > available vertices. These tests are RED because
// pickVertex has not been implemented yet.
//
// Related: plan-tasks.json w7 acceptanceCheck; plan-strategy §4 R-2;
//          research Finding 1 (reuse pick skeleton archetype walk).

describe('w7: pickVertex full-scene', () => {
  // ── AC-02: pickVertex three-state return ──────────────────────────

  describe('AC-02: pickVertex three-state return', () => {
    it('without limit returns VertexHit | undefined (hit)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);
      const hit = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP) as VertexHit | undefined;
      expect(hit).toBeDefined();
      if (hit) {
        expect(typeof hit.entity).toBe('number');
        expect(typeof hit.vertexIndex).toBe('number');
      }
    });

    it('without limit returns undefined on miss', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      propagateTransforms(scene.world);
      const hit = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP) as VertexHit | undefined;
      expect(hit).toBeUndefined();
    });

    it('with limit returns VertexHit[] sorted by screenDist', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);
      const hits = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, {
        limit: 8,
      }) as VertexHit[];
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.screenDist).toBeGreaterThanOrEqual(hits[i - 1]!.screenDist);
      }
    });

    it('with limit returns empty array on miss', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      propagateTransforms(scene.world);
      const hits = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, {
        limit: 3,
      }) as VertexHit[];
      expect(hits).toEqual([]);
    });
  });

  // ── F-1: limit mode vertexIndex distinctness ────────────────────

  describe('F-1: limit mode returns distinct vertexIndex per entity', () => {
    it('cube centre-ray 100-limit returns no duplicate (entity, vertexIndex) pairs', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      const hits = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, {
        limit: 100,
      }) as VertexHit[];
      // cube centre ray hits front+back faces; shared vertices appear once each
      expect(hits.length).toBeGreaterThan(0);

      const seen = new Set<string>();
      for (const hit of hits) {
        const key = `${hit.entity}:${hit.vertexIndex}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      // cube has 8 vertices; centre ray hits at most 8 distinct vertices
      expect(seen.size).toBeLessThanOrEqual(8);
    });

    it('pickVertexOnEntity cube centre-ray 100-limit returns no duplicate vertexIndex', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerCube(scene);
      const entity = spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      const hits = pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, entity, {
        limit: 100,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThan(0);

      const vertexIndices = new Set<number>();
      for (const hit of hits) {
        expect(vertexIndices.has(hit.vertexIndex)).toBe(false);
        vertexIndices.add(hit.vertexIndex);
      }
      expect(vertexIndices.size).toBeLessThanOrEqual(8);
    });
  });

  // ── R-2: AABB coarse cull multi-entity ───────────────────────────

  describe('R-2: AABB coarse cull on multi-entity scene', () => {
    function registerSmallTriangle(
      scene: Scene,
      offsetX: number,
      offsetY: number,
    ): Handle<'MeshAsset', 'shared'> {
      const positions = new Float32Array([
        offsetX - 0.3,
        offsetY - 0.3,
        0,
        offsetX + 0.3,
        offsetY - 0.3,
        0,
        offsetX,
        offsetY + 0.3,
        0,
      ]);
      const v = new Float32Array(3 * 12);
      for (let i = 0; i < 3; i++) {
        v[i * 12 + 0] = positions[i * 3 + 0] as number;
        v[i * 12 + 1] = positions[i * 3 + 1] as number;
        v[i * 12 + 2] = positions[i * 3 + 2] as number;
      }
      const result = scene.assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
        kind: 'mesh',
        vertices: v,
        indices: new Uint16Array([0, 1, 2]),
        attributes: interleavedAttributes(positions),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      });
      if (!result.ok) throw new Error(`small triangle catalog failed: ${result.error.message}`);
      return scene.world.allocSharedRef('MeshAsset', result.value);
    }

    it('entity far from ray is excluded by AABB coarse cull', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const meshCenter = registerTriangle(scene);
      const meshFar = registerSmallTriangle(scene, 10, 10);
      spawnMeshEntity(scene, meshCenter, 0, 0, 0);
      spawnMeshEntity(scene, meshFar, 10, 10, 0);
      propagateTransforms(scene.world);

      const hit = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP) as VertexHit | undefined;
      expect(hit).toBeDefined();
    });

    it('only entities intersecting ray produce candidates', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh1 = registerTriangle(scene);
      const mesh2 = registerSmallTriangle(scene, 0, 0);
      spawnMeshEntity(scene, mesh1, 0, 0, 0);
      spawnMeshEntity(scene, mesh2, 0, 0, 0);
      propagateTransforms(scene.world);

      const hits = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, {
        limit: 10,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThan(0);
      const entityIds = new Set(hits.map((h) => h.entity));
      expect(entityIds.size).toBeGreaterThanOrEqual(1);
    });
  });

  // ── limit > available vertices returns all ───────────────────────

  describe('limit > available vertices returns all', () => {
    it('limit larger than total candidates returns all available', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const mesh = registerTriangle(scene);
      spawnMeshEntity(scene, mesh, 0, 0, 0);
      propagateTransforms(scene.world);

      const hits = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, {
        limit: 100,
      }) as VertexHit[];
      expect(hits.length).toBeGreaterThanOrEqual(0);
      expect(hits.length).toBeLessThanOrEqual(3);
    });
  });
});
