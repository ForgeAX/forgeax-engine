// @forgeax/engine-render - MeshFilter (mesh asset reference).
//
// Schema: `{ assetHandle: 'shared<MeshAsset>' }`. The schema-vocab
// `'shared<T>'` keyword stores a u32 column and type-derives to
// `Handle<'MeshAsset', 'shared'>` (engine-ecs Handle<T,M> twoParam
// phantom; `'shared'` mode = ref-counted retain on set / release on
// clear, lifecycle owned by `SharedRefStore` per feat-20260614).
// The brand prevents cross-asset assignment at compile time (e.g.
// `Handle<'TextureAsset','shared'>` is not assignable to `assetHandle`).
//
// AI users spawn with the assets-runtime constants `HANDLE_CUBE` /
// `HANDLE_TRIANGLE` (now branded `Handle<'MeshAsset','shared'>` to
// match the schema-derived shape). A loaded or custom MeshAsset payload is
// bound by allocating a World shared reference before publishing this field.
//
// Naming flavor: unity-style "MeshFilter / MeshRenderer" pair, but the forgeax
// pair does NOT mirror Unity's filter-toggle semantics - MeshFilter only
// carries the geometry ref, MeshRenderer only carries the material handle;
// the pair is independently composable. D-Q7 default-material policy
// (feat-20260517-merge-mesh-renderer-material-renderer plan-strategy §2.2):
// case A (entity carries MeshFilter without MeshRenderer) -> archetype
// query never matches -> entity is silently absent from the
// RenderableSnapshot[] (NO default-material fallback, NO onError fire);
// case B (MeshRenderer.material omitted at spawn) -> mid-grey
// defaultMaterialSnapshot fallback (no onError); an unbound scalar shared<T>
// field (slot 0) is also not a renderable; case C (non-zero material handle
// unresolved) -> RhiError 'asset-not-registered' (mirrors the
// MeshFilter.assetHandle dangling-ref path).
//
// charter mapping: proposition 1 (single import) + proposition 4 (explicit
// failure: a non-zero unregistered handle fires onError 'asset-not-registered'
// with .detail = { assetHandle } + cross-asset brand mismatch is a TS
// compile-time error) + proposition 5 (consistent abstraction: the schema
// vocab `'shared<T>'` is the SSOT for AssetRegistry-owned handles across
// the engine).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Mesh filter (geometry asset reference).
 *
 * `assetHandle` carries a `Handle<'MeshAsset', 'shared'>` (u32-stored)
 * pointing to a mesh payload in the current World shared-reference / builtin
 * handle namespace. An omitted field defaults to slot `0`, the unbound
 * sentinel; an entity with that value is not emitted as a renderable. Use the
 * predefined constants `HANDLE_CUBE` / `HANDLE_TRIANGLE` for builtins and
 * allocate a World shared reference for a loaded mesh payload.
 *
 * Error path: if a non-zero handle is not registered at draw time, RenderSystem
 * fires `Renderer.onError` with
 * `RhiError({ code: 'asset-not-registered', detail: { assetHandle } })`
 * and skips this entity (other entities continue rendering; charter
 * proposition 9 graceful degradation).
 *
 * @example Spawn an entity referencing the builtin cube mesh:
 *   import { MeshFilter } from '@forgeax/engine-render';
 *   import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
 *   world.spawn({ component: MeshFilter, data: { assetHandle: HANDLE_CUBE } });
 */
export const MeshFilter = defineComponent('MeshFilter', {
  assetHandle: { type: 'shared<MeshAsset>' },
});
