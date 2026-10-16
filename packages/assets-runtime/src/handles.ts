// @forgeax/engine-assets-runtime -- builtin mesh handles + scene-parse handle field
// name sets (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1
// straight-cut). Pure move from asset-registry.ts; zero identifier changes.

import type { Handle } from '@forgeax/engine-types';
import { handleSlot, toShared } from '@forgeax/engine-types';

// ─── Builtin handles (D-S9 / backward compat with hello-triangle + hello-cube) ─

/**
 * Builtin unit-cube mesh handle (8 vertices + 36 indices, pos+normal
 * interleaved). Pair with `MeshFilter` to spawn a cube entity.
 *
 * @remarks Typed as `Handle<'MeshAsset', 'shared'>` — feat-20260517
 * unifies the engine-types and engine-ecs Handle brand SSOT into a single
 * `Handle<T extends string, M extends 'unique'|'shared'>` declaration
 * (research Finding 4 import-path-decoupled identity), and constructs the
 * value via the brand-creation factory `toShared<'MeshAsset'>(N)` so
 * the caller-side `as unknown as` cast is eliminated (AC-05). The
 * `'shared'` mode signals the AssetRegistry owns the lifecycle — the
 * ECS does not release the slot on despawn / removeComponent / set.
 * Runtime value is a small u32 (1).
 */
export const HANDLE_CUBE: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(1);

/**
 * Builtin triangle mesh handle (3 vertices). Pair with `MeshFilter`.
 *
 * @remarks Typed as `Handle<'MeshAsset', 'shared'>` (same narrow brand
 * as HANDLE_CUBE; constructed via the `toShared<'MeshAsset'>(N)`
 * factory per AC-05).
 */
export const HANDLE_TRIANGLE: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(2);

/**
 * Builtin unit-quad mesh handle — 4 vertices, 6 indices, 2 triangles on
 * the XY plane facing +Z. Pair with `MeshFilter` to spawn a sprite quad
 * (feat-20260520-2d-sprite-layer-mvp / M-1 / w06).
 *
 * @derives Same-shape sibling of {@link HANDLE_CUBE} / {@link HANDLE_TRIANGLE}
 *   per requirements §2.1.C: built via the `toShared<'MeshAsset'>(N)`
 *   brand-creation factory; reserved-id 3 fills the namespace hole between
 *   HANDLE_TRIANGLE=2 and FIRST_USER_HANDLE=1024 (no `BUILTIN_HANDLE_`
 *   prefix per Q2 naming decision — discoverable next to existing
 *   builtins in IDE autocomplete; charter F1 single-entry indexability).
 *
 * @reuses {@link createPlaneGeometry}(1, 1) — the procedural plane factory
 *   already produces 8-floats-per-vertex interleaved (position + normal +
 *   uv) and is then expanded to the runtime 12-floats layout (adds
 *   tangent vec4) by {@link meshFromInterleaved}. This funnels HANDLE_QUAD
 *   onto the exact same vertex pipeline branch as BUILTIN_CUBE /
 *   BUILTIN_TRIANGLE and the procedural geometry factories — zero new
 *   layout discriminator (plan-strategy §3 RT4 + D-9 + charter P4
 *   consistent abstraction).
 *
 * @reuses `PROCEDURAL_FLOATS_PER_VERTEX` = 12 from
 *   `@forgeax/engine-geometry` (the single layout SSOT; the procedural
 *   `createPlaneGeometry` factory already returns 12F via
 *   `meshFromInterleaved`).
 */
export const HANDLE_QUAD: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(3);

/**
 * Id=4 reserved builtin; occupies the next available slot under
 * FIRST_USER_HANDLE=1024. BUILTIN_SPHERE is synthesised from
 * `createSphereGeometry(1, 16, 12)` through the same
 * `meshFromInterleaved` path as BUILTIN_QUAD, so the runtime
 * 12-float stride is byte-identical to procedural output — zero
 * new layout discriminator (charter P4 consistent abstraction).
 */
export const HANDLE_SPHERE: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(4);

/**
 * Builtin cylinder mesh handle — procedural open cylinder (unit-height,
 * radius=0.5, 16 radial segments, no caps). Pair with `MeshFilter`.
 *
 * @derives Same-shape sibling of {@link HANDLE_SPHERE}: synthesised from
 *   `createCylinderGeometry(0.5, 0.5, 1, 16, 1)` through the same
 *   `meshFromInterleaved` path as BUILTIN_SPHERE, so the runtime
 *   12-float stride is byte-identical to all other built-in meshes —
 *   zero new layout discriminator (charter P4 consistent abstraction).
 *
 * @remarks Id=6 follows {@link HANDLE_NINESLICE_QUAD}=5 in the builtin slot
 *   sequence (FIRST_USER_HANDLE=1024 untouched).
 *   feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
 *   GUID = deriveBuiltin('HANDLE_CYLINDER') UUIDv5
 *   (plan-strategy §2 D-6 + §5.6 builtin-guid-ssot gate)
 */
export const HANDLE_CYLINDER: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(6);

/**
 * Builtin 9-slice quad mesh handle — 4×4 grid (16 vertices, 9 sub-quads,
 * 54 indices) on the XY plane facing +Z. Pair with `MeshFilter` and a
 * `MaterialAsset` whose first pass shader is `'forgeax::sprite'` and whose
 * `values.slices` is non-zero to render a 9-sliced UI panel
 * (feat-20260527-sprite-nineslice / M2 / w9).
 *
 * @derives Same-shape sibling of {@link HANDLE_QUAD}: synthesised from
 *   `createPlaneGeometry(1, 1, 3, 3)` which subdivides the unit quad into
 *   3×3 sub-quads (9 cells). The 16 grid points and 54 indices feed
 *   {@link meshFromInterleaved} so the runtime 12-float vertex stride is
 *   byte-identical to all other built-in / procedural meshes — zero new
 *   layout discriminator (charter P4 consistent abstraction).
 *
 * @remarks Id=5 follows {@link HANDLE_SPHERE}=4 in the builtin slot
 *   sequence (FIRST_USER_HANDLE=1024 untouched). The vertex shader uses
 *   `vertex_index % 4` / `vertex_index / 4` to recover (i, j) grid
 *   coordinates and four anchor vec4s to map each grid cell to the right
 *   region of the source texture; only required when the sprite material
 *   declares non-zero `slices`. For the legacy zero-slice sprite path use
 *   {@link HANDLE_QUAD}.
 *
 * @reuses `PROCEDURAL_FLOATS_PER_VERTEX` = 12 from
 *   `@forgeax/engine-geometry` (sprite-pipeline binding table / vertex layout
 *   untouched). plan-strategy §D-2 NOTE clarifies
 *   the id=5 vs original-plan id=4 drift: HANDLE_SPHERE took id=4 in
 *   feat-20260529-fxaa-sphere-builtin before this feat landed.
 */
export const HANDLE_NINESLICE_QUAD: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(5);

/**
 * Stable GUIDs for the builtin meshes — the dash-form of
 * `deriveBuiltin('HANDLE_<NAME>')` (UUIDv5, ForgeaX namespace) in
 * `@forgeax/engine-pack`. The fixed values avoid runtime SHA-1 work when
 * constructing the builtin handle table.
 *
 * The single source of truth remains `deriveBuiltin`: a cross-package
 * guard test (`builtin-guid-ssot.test.ts`) asserts each literal equals the
 * derived value, so any drift in the derivation reds the suite. This pairs
 * the previously-disconnected dual truths (the u32 `HANDLE_*` constants and
 * the pack GUID strings) into one bidirectionally-resolvable table, so
 * `guidOf(HANDLE_CUBE)` no longer returns `undefined`
 * (docs/feedbacks/2026-06-03 §6.2 Tier 0).
 */
export const BUILTIN_MESH_GUIDS: ReadonlyArray<readonly [Handle<'MeshAsset', 'shared'>, string]> = [
  [HANDLE_CUBE, 'cbe42beb-8975-5096-b3a1-3dda4cb4c077'],
  [HANDLE_TRIANGLE, '22592f07-d967-5116-b29c-fa9781929ba8'],
  [HANDLE_QUAD, '339338aa-a338-581c-9fc5-744267ef8a51'],
  [HANDLE_SPHERE, '95730fd2-9846-5f84-8658-0b3c971eb263'],
  [HANDLE_NINESLICE_QUAD, '692d38b4-8cac-5fb2-9dcf-f389e076d6bf'],
  // feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
  // cylinder builtin handle=6, GUID = deriveBuiltin('HANDLE_CYLINDER') UUIDv5
  // (plan-strategy §5.6 builtin-guid-ssot gate)
  [HANDLE_CYLINDER, 'ab20af21-0764-55be-a7f2-b80ab3d46a0a'],
];

/** Resolve the stable producer GUID for one process-static builtin mesh handle. */
export function builtinMeshGuid(handle: Handle<string, 'shared'>): string | undefined {
  const slot = handleSlot(handle);
  return BUILTIN_MESH_GUIDS.find(([candidate]) => handleSlot(candidate) === slot)?.[1];
}

/**
 * Field names known to carry handle<> schema-vocab references (plan-strategy
 * D-4).  parseScenePayload uses this allowlist to replace integer values
 * with GUID strings from refs[] only for handle fields — a Transform.pos lane of 0,
 * ChildOf.parent=0 and similar non-handle integers are left untouched.
 *
 * Ambiguous names use a component-qualified key: Collider.density is numeric,
 * while VolumetricFog.density is a texture reference.
 */
export const HANDLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'assetHandle',
  'material',
  'skeleton',
  'clip',
  // ParticleEffectPlayer.effect (shared<ParticleEffectAsset>) uses the same
  // scene-pack refs[] index contract as every other scalar shared field.
  'effect',
  // Collider.density is f32; only the volume component uses a texture reference.
  'VolumetricFog.density',
  // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w27:
  // Skylight.equirect + SkyboxBackground.equirect (shared<EquirectAsset>). The
  // generic extractSceneEntityHandleGuids path already covers shared< fields by
  // schema; this allowlist is the second scene-parse path (parseScenePayload),
  // so the new handle field name is registered here too (R-1).
  'equirect',
  'iesProfile',
  'cookie',
]);

/**
 * Field names known to carry `array<handle<X>>` schema-vocab references
 * (feat-20260608 M2 / w7: MeshRenderer.materials). Each element is a refs
 * index that resolves to a GUID string. Coexists with HANDLE_FIELD_NAMES;
 * a field name lives in exactly one set.
 */
export const HANDLE_ARRAY_FIELD_NAMES: ReadonlySet<string> = new Set(['materials', 'clips']);
