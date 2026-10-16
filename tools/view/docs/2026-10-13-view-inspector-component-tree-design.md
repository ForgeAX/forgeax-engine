# UE-Style Entity/Component Details

This design supersedes the Inspector-local parent/child tree described in
[All Scene Entity Details](2026-10-12-view-entity-inspector-design.md). It keeps
that design's all-entity coverage, grouped fields, schema rules and read-only
Engine boundary. Only View product code and View-owned design documentation are
changed; Engine and independent asset pages stay unchanged.

## Reference and View model

UE's Details component area lets a user select an Actor or a component and see
the selected item's details. Scene components can also have attachment
relationships, so some UE trees express a real component hierarchy.

View presents a similar selection affordance using the facts already returned
for the selected ECS entity by `entity.inspect`. It does not claim to reproduce
UE's object model: ECS components in this result have no component-to-component
attachment data. The top card therefore shows the selected entity root and
one-level functional component rows, with no fabricated attachment edges,
component instance IDs or instance labels. Actual child entities remain in
Scene Tree, whose parent/child projection is based on Engine `parentId` data.

The card retains the entity name, primary type, multi-selection count, focus
and copy-JSON actions. It has a bounded height with an independently scrolling
component list. The entity root is selected by default. The disclosure control
collapses the component list without hiding details.

## Component projection

The Inspector builds rows only from components in the current inspection:

| Returned data | Top-card presentation |
|:--|:--|
| `MeshFilter`, `MeshRenderer` | One Static Mesh row combining the returned mesh and renderer components |
| `Skin` with mesh data | One Skinned Mesh row, including whichever mesh components were returned |
| `Instances` with mesh data | One Instanced Mesh row, including whichever mesh components were returned |
| `PointLight` and `PointLightShadow` | One Point Light row combining both returned components |
| Other functional ECS component | One row named from its component identity |
| `Entity`, `Name`, `ChildOf`, `Children`, `GlobalTransform`, `Transform`, and entity-level settings | No row; values remain in their existing functional groups and All |

Composite rows link back to their original component names. Partial composites
show only returned data. Unknown and custom components retain their original
names. A result with no functional component shows only the entity root.

The projection is a pure Inspector presentation helper. The dependency-free
component-name classifier lives in workspace-core, which Scene Tree and
Inspector already consume. This supersedes the Scene-owned export in the
[all-entity design](2026-10-12-view-entity-inspector-design.md), keeps sibling
feature imports forbidden, and requires no new workspace package dependency
in the paired Engine lockfile.

## Selection and detail filtering

Selecting the entity root restores the full group set for that entity. Selecting
a component changes only the Inspector's local detail scope: its non-empty
functional groups are filtered to the raw components represented by that row,
and All contains all returned fields from those components. The default is
Common when it contains matching detail, otherwise the first populated group.
Entity Transform belongs to the root and never appears as a component's relative
transform.

Changing the selected top-card row clears search and resets the default group.
Changing scene entity, project or target remounts the detail state at the entity
root. If a selected component disappears from a later inspection result, the
Inspector returns to the root. Top-card component actions do not call
`scene.select`, so the Scene Tree selection, viewport highlight and primary
entity remain unchanged.

All other interaction remains read-only: field and JSON copying, search,
functional groups, collapse/expand and focus use existing View behavior. Resource
opens still require explicit returned GUIDs and use the existing independent
asset pages. No workspace operation, Engine API or write capability is added.

The unified projection retains the merged PR #161
rotation behavior: local `Transform.quat` appears as three intrinsic XYZ degree
values in Common and All. The original Engine XYZW remains available in the
tooltip and copy actions. Other components' quaternion-shaped fields follow
their returned schema.

## Verification

The implementation's 25 focused Inspector tests pass, including projection and
All-field preservation for all 28 configurations, partial mesh data, point-light
shadow composition, entity-level fields, unknown component names and PR #161's
XYZ degree projection with its original XYZW copy value. The Chromium UI proof
passes at 220/280/300/320/480/640px in light and dark themes; it checks
component-local filtering, unchanged scene selection, root restoration, search,
copy, collapse/expand, matching Position/Rotation/Scale row layouts, read-only controls and
overflow. The interactive browser fixture also confirmed that the entity root
shows Transform/Static Mesh/Materials
and the selected mesh node shows only Static Mesh/Materials.

`node scripts/build-tool.mjs` and `node scripts/check-architecture.mjs` pass;
the architecture gate reports 15 packages, 312 source files and zero
violations. The Scene/Inspector boundary test set passes 53/53. The Inspector
package type check passes with `--skipLibCheck`.

The full View Node suite passes 470/470. The task-owned local Game 3D preview
opened `scene/showcase` through the Content Browser and rendered live pixels.
Inspecting Main Camera showed the returned quaternion
`[-0.152615, 0, 0, 0.988286]` as X -17.6°, Y 0.0°, Z 0.0°, without a W
control. The original quaternion remains available through the copy action.

Brotato was not retested for this rotation correction. The Game 3D check used
a temporary project copy and the existing built Engine checkout; no Engine
source or build output was changed.

`git diff --check` passes. The separate Harness repository and Engine checkout
remain unchanged.

## Reference

[UE Components Window](https://dev.epicgames.com/documentation/unreal-engine/components-window-in-unreal-engine?lang=en-US)
