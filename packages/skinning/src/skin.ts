// @forgeax/engine-runtime - Skin component (skeleton handle + joint Entity slots).
//
// Schema: { skeleton: 'shared<SkeletonAsset>', joints: 'array<entity>' }.
//
// `skeleton` carries the immutable SkeletonAsset handle (IBM + jointCount);
// `joints` carries the live Entity[] resolved at post-spawn time from the
// SkinAsset.jointPaths via Name-component BFS/DFS lookup. The joint list is
// consumed by advanceAnimationPlayer (write target) and render-system-extract
// (CPU palette pre-multiply source).
//
// Naming: single-semantic component drops the 'Component' suffix
// (AGENTS.md §Component naming rule #1). `joints` field takes the holder's
// perspective (AGENTS.md §Component naming rule #3).
//
// Component registered alongside MeshFilter / MeshRenderer / Transform as
// a sibling on the same entity (AC-13 / AC-37). Skin + Instances coexistence
// on the same entity is forbidden (M2 fail-fast 'skin-instances-coexist-forbidden').
//
// Decision anchors:
//   - requirements AC-13 (Skin sibling to MeshFilter / MeshRenderer)
//   - requirements AC-15 (joint Entity slots, no marker component)
//   - requirements AC-37 (no Component suffix)
//   - plan-strategy D-10 (SkinPaletteSlice naming + Skin x Instances fail-fast)
//   - charter P3 (explicit failure: joint despawn fail-fast)
//   - schema vocab 'shared<SkeletonAsset>' v1 missing item #4 alignment
//
// ## Transform contract (post-bug-20260615 fix)
//
// **Old (buggy) implicit contract (pre-bug-20260615):** The Skin entity's
// GlobalTransform.world was double-applied during skinning -- the shader computed
// `world = meshes[0].worldFromLocal x palette x pos`, so any non-identity
// Transform on the Skin entity (or its non-joint ancestors) caused doubled
// motion (translation 2x, rotation 2x). Holders had to manually pin the Skin
// entity's Transform to identity to avoid doubled motion. This contract was
// undocumented and easy to violate.
//
// **New explicit contract (post-bug-20260615 fix):** An entity carrying `Skin`
// has its own `Transform` ignored at render time; the world transform is
// determined entirely by the joints' world matrices fed through the palette:
//
//   palette[i] = jointWorld_i x IBM_i
//   shader:    world = palette[i] x pos
//
// No additional left-multiply by `meshes[0].worldFromLocal` or `instanceLocal`.
// To move the rig, parent the joint root (or any common ancestor of the joints
// in `Skin.joints[]`) to your driving entity -- moving the Skin entity itself
// has no rendering effect. This aligns with glTF 2.0 SSkins Implementation
// Note: "the transform of the node that the mesh is attached to must be
// ignored when performing skinning."
//
// Full pipeline documentation: packages/runtime/README.md
// SSkinPaletteAllocator.
//
// Fix commits:
//   - M0 (red): 15425c2b -- parented skin double-transform unit test
//   - M1 (green): 2ad509b7 -- shader Plan A: drop meshes[0] left-multiply
//   - M2 (cleanup): 4118e463 -- extract.ts joint read -> world.get API
//   - M3 (demo): 94d7db66 -- hello-skin parented Fox under non-identity rig
//   - M4 (baseline): b6ddf46d -- palette-hash counter-proof + submodule pointer

import { defineComponent } from '@forgeax/engine-ecs';

export const Skin = defineComponent('Skin', {
  // The renderer owns the live skeleton asset/palette binding; joint entity
  // relationships remain the portable simulation-side pose contract.
  skeleton: { type: 'shared<SkeletonAsset>' },
  joints: { type: 'array<entity>' },
});
