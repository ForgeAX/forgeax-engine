// ─── BuiltinAssetRegistry (D-15 process-static tier) ────────────────────────
//
// D-15 two-tier asset resolution. Builtin payloads (the 5 procedural meshes
// the engine ships with) are PROCESS-STATIC: a frozen const keyed by a fixed
// slot u32 in [1, BUILTIN_BASE). They never enter a World's SharedRefStore,
// never participate in reference counting, and resolve without any World
// reference — so a builtin handle (HANDLE_CUBE etc.) is transparent across
// every World and every renderer.
//
// R-13 (module init-order): all five payload consts are constructed
// synchronously at module load, are module-level, and have no side effect.
// Importing this module then calling resolve() observes fully-constructed
// frozen payloads — there is no lazy getter and no circular-dependency
// init hazard.
//
// The companion AssetRegistry (asset-registry.ts) retreats to a thin
// guid<->handle index; user-tier payloads live in World.sharedRefs at
// slots >= BUILTIN_BASE. AssetRegistry.get(handle) dispatches by slot range:
// slot < BUILTIN_BASE -> BuiltinAssetRegistry.resolve, else world.sharedRefs.

import {
  createBoxGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  meshFromInterleaved,
} from '@forgeax/engine-geometry';
import type { Handle, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE, handleSlot } from '@forgeax/engine-types';

// D-16: BUILTIN_BASE is the slot boundary [1, BUILTIN_BASE) builtin /
// [BUILTIN_BASE, +inf) user-tier. It lives in @forgeax/engine-types (the
// single shared dependency of ecs + runtime) to avoid a cross-package cycle;
// re-exported from the runtime barrel here for AI-user discoverability.
export { BUILTIN_BASE };

// ─── Builtin geometry data (12F: position + normal + uv + tangent) ──────────
// bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu: every
// builtin geometry payload keeps the local-space AABB produced by its geometry
// factory. Builtins are ordinary MeshAssets at the render boundary, so removing
// their bounds silently turns them into always-visible renderables and defeats
// the same frustum-culling path used by imported meshes.

// BUILTIN_CUBE is synthesized from `createBoxGeometry(1, 1, 1)` so the cube
// inherits Three.js-aligned per-face UV unwrap and per-vertex tangent vec4.
// The procedural factory always returns Result.ok for valid (>0) extents,
// hence the unwrap-with-throw is safe at module init.
const builtinCubeRes = createBoxGeometry(1, 1, 1);
if (!builtinCubeRes.ok) {
  throw new Error(
    `[builtin-asset-registry] createBoxGeometry(1,1,1) failed: ${builtinCubeRes.error.code}`,
  );
}
export const BUILTIN_CUBE: TypesMeshAsset = Object.freeze(builtinCubeRes.value);

// BUILTIN_TRIANGLE: 3 vertices in the XY plane facing +Z, with a [0..1]² UV
// triangle so a textured triangle samples the texture (apex = top-centre,
// base = bottom-left / bottom-right). meshFromInterleaved expands the
// 8-floats interleaved input (pos + normal + uv) to the runtime 12-floats
// stride (adds tangent vec4 per `geometry/tangent.ts` path A).
const builtinTriangleRes = meshFromInterleaved(
  new Float32Array([
    // pos.xyz                normal.xyz       uv.xy
    0, 0.7, 0, 0, 0, 1, 0.5, 1, -0.7, -0.6, 0, 0, 0, 1, 0, 0, 0.7, -0.6, 0, 0, 0, 1, 1, 0,
  ]),
  new Uint16Array([0, 1, 2]),
);
if (!builtinTriangleRes.ok) {
  throw new Error(
    `[builtin-asset-registry] builtin triangle geometry failed: ${builtinTriangleRes.error.code}`,
  );
}
export const BUILTIN_TRIANGLE: TypesMeshAsset = Object.freeze(builtinTriangleRes.value);

// BUILTIN_QUAD: unit-size plane on XY facing +Z (4 vertices, 2 triangles,
// 6 indices). Synthesised from `createPlaneGeometry(1, 1)` (which itself
// chains through `meshFromInterleaved`) so the resulting MeshAsset is
// byte-identical to procedural plane output — zero new layout
// discriminator, AI users reason about UV / pivot semantics by reading
// `packages/runtime/src/geometry/plane.ts` (charter P4 consistent
// abstraction; feat-20260520 M-1 / w06).
// bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu: this
// payload follows the same local-AABB contract as every other builtin.
const builtinQuadRes = createPlaneGeometry(1, 1);
if (!builtinQuadRes.ok) {
  throw new Error(
    `[builtin-asset-registry] createPlaneGeometry(1,1) failed: ${builtinQuadRes.error.code}`,
  );
}
export const BUILTIN_QUAD: TypesMeshAsset = Object.freeze(builtinQuadRes.value);

// BUILTIN_SPHERE: UV-sphere synthesised from createSphereGeometry(1, 16, 12).
// Vertices are at exact radius-1 positions (sphere.ts:40-45) so the
// |hypot(pos)-1| < 1e-6 radius invariant holds by construction. Index
// buffer is Uint32Array — downstream consumers (step-3 upload loop,
// createRenderer.ts) auto-select 'uint32' indexFormat via
// `instanceof Uint32Array`.
const builtinSphereRes = createSphereGeometry(1, 16, 12);
if (!builtinSphereRes.ok) {
  throw new Error(
    `[builtin-asset-registry] createSphereGeometry(1,16,12) failed: ${builtinSphereRes.error.code}`,
  );
}
export const BUILTIN_SPHERE: TypesMeshAsset = Object.freeze(builtinSphereRes.value);

// BUILTIN_CYLINDER: procedural cylinder synthesised from createCylinderGeometry(0.5, 0.5, 1, 16, 1).
// Radius-top=radius-bottom=0.5, height=1, 16 radial segments, 1 height segment — a
// unit-height open cylinder (no caps). meshFromInterleaved expands the 8-floats
// interleaved input (pos + normal + uv) to the runtime 12-floats stride (adds
// tangent vec4 per geometry/tangent.ts path A).
// feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
// handle=6, GUID = deriveBuiltin('HANDLE_CYLINDER') UUIDv5
// (plan-strategy §2 D-6 + §5.6 builtin-guid-ssot gate)
const builtinCylinderRes = createCylinderGeometry(0.5, 0.5, 1, 16, 1);
if (!builtinCylinderRes.ok) {
  throw new Error(
    `[builtin-asset-registry] createCylinderGeometry(0.5,0.5,1,16,1) failed: ${builtinCylinderRes.error.code}`,
  );
}
export const BUILTIN_CYLINDER: TypesMeshAsset = Object.freeze(builtinCylinderRes.value);

// BUILTIN_NINESLICE_QUAD: 4×4 grid plane synthesised from
// createPlaneGeometry(1, 1, 3, 3) — 16 vertices, 9 sub-quads × 6 indices = 54.
// Reuses the unit-quad vertex layout (12F: pos + normal + uv + tangent) so
// HANDLE_NINESLICE_QUAD funnels through the same sprite-pipeline binding
// table as HANDLE_QUAD; only the vertex_index → (i, j) decomposition in
// sprite.wgsl branches on slices presence (feat-20260527-sprite-nineslice
// M3, plan-strategy §D-2 + §D-4).
const builtinNineSliceQuadRes = createPlaneGeometry(1, 1, 3, 3);
if (!builtinNineSliceQuadRes.ok) {
  throw new Error(
    `[builtin-asset-registry] createPlaneGeometry(1,1,3,3) failed: ${builtinNineSliceQuadRes.error.code}`,
  );
}
export const BUILTIN_NINESLICE_QUAD: TypesMeshAsset = Object.freeze(builtinNineSliceQuadRes.value);

// Slot u32 -> frozen payload. Slot ids 1..5 are the fixed builtin handle
// values (HANDLE_CUBE=1 .. HANDLE_NINESLICE_QUAD=5) defined in asset-registry.
const BUILTIN_BY_SLOT: ReadonlyMap<number, TypesMeshAsset> = new Map([
  [1, BUILTIN_CUBE],
  [2, BUILTIN_TRIANGLE],
  [3, BUILTIN_QUAD],
  [4, BUILTIN_SPHERE],
  [5, BUILTIN_NINESLICE_QUAD],
  [6, BUILTIN_CYLINDER],
]);

/**
 * Process-static builtin asset resolver (D-15). `resolve(handle)` returns the
 * frozen builtin payload when `slot < BUILTIN_BASE`, else `null` (the slot
 * belongs to the user tier — resolve it through `world.sharedRefs.resolve`).
 *
 * Read-only: there is no register / mint surface. The five builtin payloads
 * are fixed at module load. AI users `import { BuiltinAssetRegistry } from
 * '@forgeax/engine-runtime'` and resolve a builtin handle without a World.
 */
export const BuiltinAssetRegistry = Object.freeze({
  resolve<T extends TypesMeshAsset>(handle: Handle<string, 'shared'>): T | null {
    const slot = handleSlot(handle);
    if (slot >= BUILTIN_BASE) return null;
    const payload = BUILTIN_BY_SLOT.get(slot);
    return payload === undefined ? null : (payload as T);
  },
});
