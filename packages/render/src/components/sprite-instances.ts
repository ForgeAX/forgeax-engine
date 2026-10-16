// @forgeax/engine-runtime - SpriteInstances component (per-entity 2D
// instanced-draw transforms + per-instance UV region).
//
// Schema: 2 array<f32> fields. `transforms` carries packed column-major mat4
// instance transforms (16 f32 per instance, stride = 16). `regions` carries
// packed per-instance UV vec4 (4 f32 per instance, stride = 4; layout
// [uMin, vMin, uW, vH] mirroring SpriteAnimation.regions). The pair share
// the same instance count; the SSOT invariant is
//   transforms.length / 16 === regions.length / 4
// enforced through a TWO-LAYER contract:
//
//   1. AI user set-site: spawn / `world.set` / `world.push` callers pass two
//      Float32Arrays whose lengths satisfy the stride pair. The set site is
//      the AI user's responsibility — the engine cannot prove column-major
//      mat4 packing or per-instance UV intent without caller declaration.
//   2. RenderSystem extract entry: `render-system-extract.ts` performs a
//      defensive `transforms.length / 16 === regions.length / 4` check on
//      every `world.get(e, SpriteInstances)` snapshot at frame extract time;
//      violations route a structured `SpriteInstancesCountMismatchError`
//      (`code: 'sprite-instances-count-mismatch'`,
//      `detail: { transformsLength, regionsLength, expectedStride: { transforms: 16, regions: 4 } }`)
//      through the World Layer-3 ErrorHandler and the renderable is skipped.
//      Two further extract-entry checks fire:
//        - `'sprite-instances-requires-sprite-shader'` — MaterialAsset's
//          first pass `shader` must be `'forgeax::sprite'`.
//        - `'sprite-instances-mutually-exclusive-with-instances'` — same
//          entity must not carry both Instances + SpriteInstances.
//      (Error class declarations live in `@forgeax/engine-ecs` errors.ts; the
//      extract-entry fire path is owned by feat M3 w12 / w13.)
//
// Peer relation to Instances (charter P4 consistent abstraction):
//   - Instances : 3D scene primitive — per-instance mat4 only (stride 16).
//   - SpriteInstances : 2D scene primitive — per-instance mat4 + per-instance
//     UV region (interleaved 80B per instance: 64B mat4 + 16B region).
// AI users pick by data shape (does the per-instance carry UV?). Both ride
// the array-vocab path and route through the same Layer-3 error envelope.
//
// Group transform chained semantics (charter proposition 5 mental migration):
//   When the same entity carries both `Transform` (entity_world) and
//   `SpriteInstances` (per-instance local transforms), the vertex shader
//   composes per instance:
//     world_position[i] = entity_world * instances_local[i] * vertex_position
//   `SpriteInstances.transforms[i*16..i*16+15]` is interpreted as a local-
//   space transform under the entity, exactly like `Instances.transforms`.
//   Set the entity's `Transform` to identity to make `instances_local[i]`
//   directly world-space.
//
// Uniform / storage buffer cap (research D-R-4 + AC-04): 80B per instance
// * 128-cap fallback = 10240 B < 16384 B uniform max; the storage-buffer
// path is uncapped and used by capable backends (RenderSystem record-stage
// cap-gate).
//
// 4-segment minimum contract (read this header before reaching for the
// source body):
//
// ===== (a) single-component import + spawn example =====
//
//   import {
//     createRenderer,
//     MeshFilter, MeshRenderer, Transform,
//     SpriteInstances, type SpriteInstancesData,
//   } from '@forgeax/engine-render';
//
//   // 1 entity rendering N instanced sprites (16N transforms f32 + 4N regions f32):
//   const transforms = new Float32Array(N * 16);
//   const regions    = new Float32Array(N * 4);
//   // ... fill column-major mat4 columns + [uMin, vMin, uW, vH] per instance ...
//   world.spawn(
//     { component: MeshFilter,      data: { assetHandle: HANDLE_QUAD } },
//     { component: MeshRenderer,    data: { /* sprite-shaded MaterialAsset */ } },
//     { component: SpriteInstances, data: { transforms, regions } },
//   );
//
// ===== (b) packed mat4 + region layout =====
//
//   const transforms = new Float32Array(N * 16); // column-major mat4 per instance
//   const regions    = new Float32Array(N * 4);  // [uMin, vMin, uW, vH] per instance
//   // instance i occupies floats:
//   //   transforms[i*16 .. i*16+15] — column-major mat4 (translation in m03/m13/m23)
//   //   regions   [i* 4 .. i* 4+ 3] — uMin, vMin, uW, vH (atlas-normalized UV rect)
//
// `transforms.length` MUST be a non-zero multiple of 16; `regions.length`
// MUST be a non-zero multiple of 4; the per-instance count derived from
// both MUST agree. AI users gate at the set / push site; the RenderSystem
// extract entry holds the second defensive (see error path 1 below).
//
// ===== (c) error code consumption (typed property access, no message regex) =====
//
//   // Stride / mutual-exclusion / sprite-shader violations surface through
//   // the engine-ecs Layer-3 ErrorHandler when extract reads a malformed
//   // snapshot:
//   //   on('error', (err) => {
//   //     switch (err.code) {
//   //       case 'sprite-instances-count-mismatch':
//   //         // err.detail.transformsLength / regionsLength / expectedStride
//   //         break;
//   //       case 'sprite-instances-requires-sprite-shader':
//   //         // err.detail.entityId / observedMaterialShaderId
//   //         break;
//   //       case 'sprite-instances-mutually-exclusive-with-instances':
//   //         // err.detail.entityId
//   //         break;
//   //     }
//   //   });
//
// charter mapping (charter v2 numbering, with round-1 v1 aliases retained
// in parentheses so reviewers tracking the v1 spec can cross-reference;
// SSOT for the v2 -> v1 alias map is the AI User Charter — see
// .claude/skills/forgeax-closed-loop/agents/ai-user-charter.md):
//   F1 (alias: proposition 1) — single import surface
//      `import { SpriteInstances, type SpriteInstancesData } from
//      '@forgeax/engine-render'`;
//   P2 (alias: proposition 3) — machine-readable schema > prose:
//      `{ transforms: 'array<f32>', regions: 'array<f32>' }` is the SSOT,
//      stride pair documented here + enforced at the RenderSystem entry;
//   P3 (alias: proposition 4) — explicit failure: 3 structured EcsError
//      codes route per failure shape, not silent half-row;
//   P4 (alias: proposition 5) — consistent abstraction: SpriteInstances
//      mirrors Instances — both ride the array-vocab path; pick by data
//      shape, not by API.
//
// Anchors: requirements AC-01 (component schema), AC-03 (3 error codes),
// AC-09 (IDE autocomplete + type inference); plan-strategy D-1 (interleaved
// single binding slot), D-6 (3 codes declared in M1 ecs, fired in M3 render),
// D-7 (type export location), D-8 (barrel re-export at runtime, not ecs).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Per-entity 2D instanced-draw primitive (ECS component).
 *
 * Carries two variable-length `array<f32>` fields:
 *   - `transforms` — column-major mat4 per instance (16 f32, stride 16);
 *   - `regions`    — UV vec4 per instance ([uMin, vMin, uW, vH], 4 f32,
 *     stride 4).
 *
 * The pair share the same instance count; the invariant
 * `transforms.length / 16 === regions.length / 4` is enforced at the
 * RenderSystem extract entry (NOT at ECS write paths). The runtime
 * RenderSystem consumer materialises a fresh `Float32Array` snapshot on
 * every `world.get(e, SpriteInstances)` access and uploads an interleaved
 * 80B-per-instance buffer to the GPU in the record stage.
 *
 * @example Spawn an entity rendering 10000 instanced sprites:
 *   const transforms = new Float32Array(10000 * 16);
 *   const regions    = new Float32Array(10000 * 4);
 *   // ... fill mat4 columns + [uMin, vMin, uW, vH] ...
 *   world.spawn(
 *     { component: MeshFilter,      data: { assetHandle: HANDLE_QUAD } },
 *     { component: MeshRenderer,    data: { ... } },
 *     { component: SpriteInstances, data: { transforms, regions } },
 *   );
 */
export const SpriteInstances = defineComponent('SpriteInstances', {
  transforms: { type: 'array<f32>' },
  regions: { type: 'array<f32>' },
});

/**
 * Type-level hint for `data` at the `SpriteInstances` spawn site.
 *
 * The runtime ECS column shape for `array<f32>` accepts a `Float32Array`
 * payload at spawn / set time (the bytes are copied into the BufferPool
 * slot). Both fields are typed as `Float32Array` so AI-user IDE
 * autocomplete picks up the typed-array shape and the AC-09 inference
 * surfaces without `as` casts inside `world.get(e, SpriteInstances)` and
 * QueryRow access paths.
 *
 * @example
 *   import type { SpriteInstancesData } from '@forgeax/engine-render/authoring';
 *   const data: SpriteInstancesData = {
 *     transforms: new Float32Array(N * 16),
 *     regions:    new Float32Array(N * 4),
 *   };
 */
export type SpriteInstancesData = {
  readonly transforms: Float32Array;
  readonly regions: Float32Array;
};
