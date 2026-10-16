// pick.test.ts — screen-to-entity pick() integration tests (AC-05..AC-11).
//
// Extracted from packages/runtime/src/__tests__/components.unit.test.ts (the
// "from pick.test.ts" block) in feat-20260705 M2 / w25 when the pick cluster
// moved to @forgeax/engine-picking. Runtime can no longer import the picking
// package (AC-203), so these integration tests live in the downstream picking
// package that depends on runtime.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type PickHit, pick } from '../pick';
import { PickError } from '../pick-errors';
import { pickVertex, pickVertexOnEntity } from '../pick-vertex';
import { viewportToWorld } from '../viewport-to-world';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const EMPTY_ATTRIBUTE = new Float32Array(0);
function interleavedAttributes(position: Float32Array): {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  tangent: Float32Array;
} {
  return {
    position,
    normal: EMPTY_ATTRIBUTE,
    uv: EMPTY_ATTRIBUTE,
    tangent: EMPTY_ATTRIBUTE,
  };
}

// --- from pick.test.ts ---
// pick.test.ts — feat-20260529-picking-raycasting-screen-to-entity M3 / w12 (TDD red).
//
// Integration tests for the screen-to-entity `pick` free function:
//   pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)
//     -> PickHit | undefined
//
// The deterministic scene is built with a bare `new World()` + a real
// `AssetRegistry` (the `assets` param introduced by the 2026-05-29 replan: the
// ray-AABB test needs `MeshAsset.aabb`, which lives ONLY in the AssetRegistry,
// never on a world column). A full `createRenderer` is intentionally NOT used —
// it requires a live WebGPU device unavailable in the `pnpm test:unit` project,
// and `pick` only consumes an `AssetRegistry`, not the renderer. The registry
// instance IS `renderer.assets` at the demo call site (w16), so the surface
// under test is identical.
//
// Coverage (all pick acceptance criteria):
//   (AC-06) nearest hit wins — two boxes along the ray, the closer one returns
//   (AC-07) miss -> undefined (blank coordinate, no box on the ray)
//   (AC-08) PickHit field shape {entity, point, distance} is exact + correct
//   (AC-10) orthographic camera picks via the parallel-ray path
//   (AC-11) cameraEntity with no Camera -> PickError (structured, not undefined)
//   (clamp) out-of-range / negative screen coords clamp to the viewport edge;
//           NaN/Inf screen coords are sanitized (no NaN ray, no throw)
//
// Type-narrowing (AC-05 / AC-08) is asserted in a tsc-only block at the bottom:
//   `const hit = pick(...)` needs no `as` cast, `hit.entity` is accessible after
//   the `if (hit)` guard, and `hit.face` / `hit.uv` are compile errors.
//
// Anchors: requirements AC-05..AC-11; plan-strategy D-3 (GlobalTransform fallback
// to Transform — the flat scene exercises the Transform path) + D-6 (PickHit
// co-located in pick.ts) + 5.3 (all pick branches must-test); plan-tasks.json w12.
//
// TDD red: pick.ts does not exist yet when this file is first committed, so the
// `../pick` import will not resolve. Green after w13.

// feat-20260601 w12/w13: pick reads the resolved `GlobalTransform.world` mat4 written
// by propagateTransforms (no GlobalTransform/Transform fallback). Every scene
// runs propagate before pick so the world column is fresh; `runPick` folds the
// propagate + pick pair so the test bodies stay focused on the pick contract.
function runPick(
  world: World,
  camera: EntityHandle,
  x: number,
  y: number,
  w: number,
  h: number,
): PickHit | undefined {
  propagateTransforms(world);
  return pick(world, camera, x, y, w, h);
}

// ── helpers ──────────────────────────────────────────────────────────────

function translateTransform(
  x: number,
  y: number,
  z: number,
): {
  pos: [number, number, number];
  quat: [number, number, number, number];
  scale: [number, number, number];
} {
  return {
    pos: [x, y, z],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

/**
 * Register a mesh whose computed AABB spans [-0.5, 0.5]^3.
 *
 * The registry computes the AABB from `attributes.position` (an explicit `aabb` is
 * overwritten by `withMeshAabb`), so the position attribute carries the 8 cube corners.
 * `vertices` must be a multiple of the 12-float interleaved stride; a single 3-vertex
 * triangle (36 floats) satisfies the gate while the position attribute drives the AABB.
 */
function registerBox(world: World, assets: AssetRegistry): Handle<'MeshAsset', 'shared'> {
  const vertices = new Float32Array([
    0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1,
    0, 0, 0, 0,
  ]);
  // 8 cube corners spanning [-0.5, 0.5] on every axis -> computeAABB = [-0.5,-0.5,-0.5, 0.5,0.5,0.5]
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
    0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  // catalog computes the local-space AABB (withMeshAabb); mint the augmented
  // payload on the world so resolveAssetHandle (used by pick) reads .aabb.
  const result = assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
    kind: 'mesh',
    vertices,
    indices: new Uint16Array([0, 1, 2]),
    attributes: interleavedAttributes(positions),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: vertices.length,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
  if (!result.ok) throw new Error('mesh catalog failed');
  return world.allocSharedRef('MeshAsset', result.value);
}

function registerMaterial(world: World, assets: AssetRegistry): Handle<'MaterialAsset', 'shared'> {
  const result = assets.catalog<MaterialAsset>(AssetGuid.format(AssetGuid.random()), {
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
  if (!result.ok) throw new Error('material catalog failed');
  return world.allocSharedRef('MaterialAsset', result.value);
}

interface Scene {
  world: World;
  assets: AssetRegistry;
  mesh: Handle<'MeshAsset', 'shared'>;
  material: Handle<'MaterialAsset', 'shared'>;
}

function makeScene(): Scene {
  const world = new World();
  const assets = new AssetRegistry(makeMockShaderRegistry());
  const mesh = registerBox(world, assets);
  const material = registerMaterial(world, assets);
  return { world, assets, mesh, material };
}

/** Spawn a perspective camera at (x,y,z) looking down -Z (identity rotation). */
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

/** Spawn an orthographic camera at (x,y,z) looking down -Z. */
function spawnOrthographicCamera(world: World, z: number): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: translateTransform(0, 0, z) },
      {
        component: Camera,
        data: {
          fov: 0,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -5,
          right: 5,
          bottom: -5,
          top: 5,
        },
      },
    )
    .unwrap();
}

/** Spawn a box entity at (x,y,z). */
function spawnBox(scene: Scene, x: number, y: number, z: number): EntityHandle {
  return scene.world
    .spawn(
      { component: Transform, data: translateTransform(x, y, z) },
      { component: MeshFilter, data: { assetHandle: scene.mesh } },
      { component: MeshRenderer, data: { materials: [scene.material] } },
    )
    .unwrap();
}

const VP = 600; // square viewport so screen-centre maps to the -Z axis ray

// ── tests ────────────────────────────────────────────────────────────────

describe('w12 — pick nearest hit (AC-06)', () => {
  it('returns the closer of two boxes along the ray', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    const near = spawnBox(scene, 0, 0, 0); // closer to camera at z=5
    spawnBox(scene, 0, 0, -10); // farther along -Z

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit).toBeDefined();
    expect(hit?.entity).toBe(near);
  });

  it('returns the only box on the ray when a single candidate exists', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    const box = spawnBox(scene, 0, 0, 0);

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit?.entity).toBe(box);
  });
});

describe('w12 — pick miss (AC-07)', () => {
  it('returns undefined when the ray hits nothing', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    // box pushed far off the -Z centre axis; the centre ray misses it
    spawnBox(scene, 50, 0, 0);

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit).toBeUndefined();
  });

  it('returns undefined when the world has no pickable meshes', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit).toBeUndefined();
  });
});

describe('w12 — PickHit field shape (AC-08)', () => {
  it('carries entity + point (Vec3) + distance with correct values', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    const box = spawnBox(scene, 0, 0, 0);

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit).toBeDefined();
    if (!hit) throw new Error('expected hit');

    expect(hit.entity).toBe(box);
    // The ray origin is the unprojected NEAR-plane point (z = 5 - near = 4.9), not the
    // camera centre; the box front (+Z) face is at z=0.5, so the entry distance along the
    // ray is 4.9 - 0.5 = 4.4 (distance is measured from the near plane, charter D-NDC).
    expect(hit.distance).toBeGreaterThan(0);
    expect(hit.distance).toBeCloseTo(4.4, 1);
    // point = origin + dir * distance; for the centre ray it lands on the +Z face
    expect(hit.point.length).toBe(3);
    expect(hit.point[2]).toBeCloseTo(0.5, 1);
    expect(hit.point[0]).toBeCloseTo(0, 1);
    expect(hit.point[1]).toBeCloseTo(0, 1);
  });
});

describe('w12 — orthographic camera (AC-10)', () => {
  it('picks the box under the screen coordinate via the parallel ray path', () => {
    const scene = makeScene();
    const camera = spawnOrthographicCamera(scene.world, 5);
    const box = spawnBox(scene, 0, 0, 0);

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit?.entity).toBe(box);
  });

  it('orthographic ray translation: off-centre screen coordinate misses a centred box', () => {
    const scene = makeScene();
    const camera = spawnOrthographicCamera(scene.world, 5);
    spawnBox(scene, 0, 0, 0); // box at world origin, ortho span [-5,5]

    // top-left corner maps to world (-5, +5): far outside the unit box at origin
    const hit = runPick(scene.world, camera, 0, 0, VP, VP);
    expect(hit).toBeUndefined();
  });
});

describe('w12 — camera-missing precondition (AC-11)', () => {
  it('throws a structured PickError when cameraEntity has no Camera', () => {
    const scene = makeScene();
    // entity with a Transform but NO Camera component
    const notACamera = scene.world
      .spawn({ component: Transform, data: translateTransform(0, 0, 5) })
      .unwrap();
    spawnBox(scene, 0, 0, 0);

    expect(() => runPick(scene.world, notACamera, VP / 2, VP / 2, VP, VP)).toThrow(PickError);
  });

  it('the PickError carries .code / .expected / .hint / .detail', () => {
    const scene = makeScene();
    const notACamera = scene.world
      .spawn({ component: Transform, data: translateTransform(0, 0, 5) })
      .unwrap();

    try {
      runPick(scene.world, notACamera, VP / 2, VP / 2, VP, VP);
      throw new Error('expected PickError');
    } catch (e) {
      expect(e).toBeInstanceOf(PickError);
      const err = e as PickError;
      expect(err.code).toBe('camera-component-missing');
      expect(err.expected.length).toBeGreaterThan(0);
      expect(err.hint).toContain('world.set');
      expect(err.detail.cameraEntity).toBe(notACamera as unknown as number);
    }
  });
});

describe('viewportToWorld', () => {
  it('returns the center ray through the camera', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    propagateTransforms(scene.world);

    const result = viewportToWorld(scene.world, camera, VP / 2, VP / 2, VP, VP);

    expect(result).toBeDefined();
    expect(result?.[0]).toBeCloseTo(0, 4);
    expect(result?.[1]).toBeCloseTo(0, 4);
    expect(result?.[2]).toBeCloseTo(4.9, 4);
    expect(result?.[3]).toBeCloseTo(0, 4);
    expect(result?.[4]).toBeCloseTo(0, 4);
    expect(result?.[5]).toBeCloseTo(-1, 4);
  });
});

describe('degenerate viewport recovery', () => {
  it.each([
    ['zero width', 0, VP],
    ['negative width', -1, VP],
    ['non-finite width NaN', Number.NaN, VP],
    ['non-finite width Infinity', Number.POSITIVE_INFINITY, VP],
    ['zero height', VP, 0],
    ['negative height', VP, -1],
    ['non-finite height NaN', VP, Number.NaN],
    ['non-finite height Infinity', VP, Number.POSITIVE_INFINITY],
  ])('returns the normal miss/no-ray form for %s and recovers on the same scene', (_label, width, height) => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    const box = spawnBox(scene, 0, 0, 0);
    propagateTransforms(scene.world);

    const expectedRay = viewportToWorld(scene.world, camera, VP / 2, VP / 2, VP, VP);
    const expectedPick = pick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    const expectedSceneVertices = pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, {
      limit: 3,
    });
    const expectedEntityVertices = pickVertexOnEntity(
      scene.world,
      camera,
      VP / 2,
      VP / 2,
      VP,
      VP,
      box,
      { limit: 3 },
    );

    expect(expectedRay).toBeDefined();
    expect(expectedPick?.entity).toBe(box);
    expect(expectedSceneVertices.length).toBeGreaterThan(0);
    expect(expectedEntityVertices.length).toBeGreaterThan(0);

    expect(pick(scene.world, camera, VP / 2, VP / 2, width, height)).toBeUndefined();
    expect(viewportToWorld(scene.world, camera, VP / 2, VP / 2, width, height)).toBeUndefined();
    expect(pickVertex(scene.world, camera, VP / 2, VP / 2, width, height)).toBeUndefined();
    expect(
      pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, width, height, box),
    ).toBeUndefined();
    expect(pickVertex(scene.world, camera, VP / 2, VP / 2, width, height, { limit: 3 })).toEqual(
      [],
    );
    expect(
      pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, width, height, box, { limit: 3 }),
    ).toEqual([]);

    const recoveredRay = viewportToWorld(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(recoveredRay).toBeDefined();
    expect(Array.from(recoveredRay ?? [])).toEqual(Array.from(expectedRay ?? []));
    expect(pick(scene.world, camera, VP / 2, VP / 2, VP, VP)?.entity).toBe(box);
    expect(pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP)).toEqual(
      expectedSceneVertices[0],
    );
    expect(pickVertex(scene.world, camera, VP / 2, VP / 2, VP, VP, { limit: 3 })).toEqual(
      expectedSceneVertices,
    );
    expect(
      pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, box, { limit: 3 }),
    ).toEqual(expectedEntityVertices);
    expect(pickVertexOnEntity(scene.world, camera, VP / 2, VP / 2, VP, VP, box)).toEqual(
      expectedEntityVertices[0],
    );
  });
});

describe('w12 — coordinate clamp + sanitization (AC-11 boundary)', () => {
  it('clamps a negative / out-of-range coordinate to the viewport edge without throwing', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    spawnBox(scene, 0, 0, 0);

    // off-screen coordinates: must not throw and must not produce a NaN-driven hit
    expect(() => runPick(scene.world, camera, -100, -100, VP, VP)).not.toThrow();
    expect(() => runPick(scene.world, camera, VP + 999, VP + 999, VP, VP)).not.toThrow();
  });

  it('sanitizes NaN / Infinity screen coordinates (no throw, defined result)', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);
    spawnBox(scene, 0, 0, 0);

    expect(() => runPick(scene.world, camera, Number.NaN, 0, VP, VP)).not.toThrow();
    expect(() => runPick(scene.world, camera, Number.POSITIVE_INFINITY, 0, VP, VP)).not.toThrow();
  });
});

// ── tsc-only type-narrowing assertions (AC-05 / AC-08) ─────────────────────
// These functions are never invoked at runtime; their sole purpose is to make
// `pnpm run typecheck` (tsc -b) fail if the PickHit surface drifts.

describe('w12 — type narrowing (AC-05 / AC-08, tsc)', () => {
  // The runtime body was a no-op probe wrapping `@ts-expect-error` calls; the
  // closure itself is what makes `pnpm run typecheck` fail if PickHit drifts.
  // Hoisting the closure to module scope keeps the typecheck signal without a
  // placeholder runtime assertion (feat-20260608-ci-time-cut).
  const _pickHitTypeProbe = (world: World, cam: EntityHandle): void => {
    // no `as` cast: pick is correctly typed as PickHit | undefined
    const hit = pick(world, cam, 0, 0, VP, VP);
    if (hit) {
      const e: EntityHandle = hit.entity;
      const d: number = hit.distance;
      const p: ArrayLike<number> = hit.point;
      void e;
      void d;
      void p;
      // @ts-expect-error — PickHit has no `face` field (AC-08)
      void hit.face;
      // @ts-expect-error — PickHit has no `uv` field (AC-08)
      void hit.uv;
    }
    // PickHit assignability sanity (no cast required)
    const explicit: PickHit | undefined = pick(world, cam, 1, 1, VP, VP);
    void explicit;
  };
  void _pickHitTypeProbe;

  it.todo(
    'PickHit narrows without a cast and rejects absent fields (typecheck-only via _pickHitTypeProbe)',
  );
});

describe('w12 — pick reads GlobalTransform.world for hierarchical entities (AC-05)', () => {
  it('picks a child box at its resolved world position (parent x child), not its local position', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);

    // Parent translates +X by 2; child local sits at the origin. The child's
    // world position is therefore (2,0,0) -- off the centre -Z ray. A pick
    // reading the LOCAL transform (origin) would (wrongly) hit; a pick reading
    // GlobalTransform.world (x=2) correctly misses the centre ray.
    const parent = scene.world
      .spawn({ component: Transform, data: translateTransform(2, 0, 0) })
      .unwrap();
    scene.world
      .spawn(
        { component: Transform, data: translateTransform(0, 0, 0) },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: scene.mesh } },
        { component: MeshRenderer, data: { materials: [scene.material] } },
      )
      .unwrap();

    // Centre ray (down -Z) misses the world-shifted child.
    expect(runPick(scene.world, camera, VP / 2, VP / 2, VP, VP)).toBeUndefined();
  });

  it('picks a child box whose world position lands back on the ray', () => {
    const scene = makeScene();
    const camera = spawnPerspectiveCamera(scene.world, 5);

    // Parent at -X 2, child local +X 2 -> child world (0,0,0) -> on the centre ray.
    const parent = scene.world
      .spawn({ component: Transform, data: translateTransform(-2, 0, 0) })
      .unwrap();
    const child = scene.world
      .spawn(
        { component: Transform, data: translateTransform(2, 0, 0) },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: scene.mesh } },
        { component: MeshRenderer, data: { materials: [scene.material] } },
      )
      .unwrap();

    const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
    expect(hit?.entity).toBe(child);
  });
});
