# Entity Details and Component Overview

This design supersedes the Inspector-local parent/child tree described in
[All Scene Entity Details](2026-10-12-view-entity-inspector-design.md). It keeps
that design's all-entity coverage, grouped fields, schema rules and read-only
Engine boundary. Only View product code and View-owned design documentation are
changed; Engine and independent asset pages stay unchanged. The 2026-10-15
component-overview revision below supersedes this document's original functional
component tree and component-filtering interaction.

## Current component overview (2026-10-15)

The top card retains its existing width, bounded height, object header, primary
type, multi-selection count, focus and copy-JSON actions. Its contents are the
original complete ECS component overview, with an independently scrolling list.
There is no entity-root tree row or component hierarchy. Scene Tree continues
to own actual entity parent/child navigation based on Engine `parentId` data.

## Component rows

The Inspector renders one row per component in the current `entity.inspect`
result, preserving returned order and the existing translated display names:

| Returned data | Top-card presentation |
|:--|:--|
| `MeshFilter`, `MeshRenderer` | Separate Mesh Binding and Mesh Rendering rows |
| `Entity`, `Name`, `ChildOf`, `GlobalTransform`, `Transform` | Separate rows, including entity-level data |
| `TransformInterpolation` | A returned transient marker row, including its empty-field state |
| Other returned ECS component | One row; unknown/custom names remain unchanged |

No raw components are merged or omitted in this overview. The dependency-free
primary-type classifier remains in workspace-core, which Scene Tree and
Inspector already consume. This retains the supersession of the Scene-owned export in the
[all-entity design](2026-10-12-view-entity-inspector-design.md), keeps sibling
feature imports forbidden, and requires no new workspace package dependency
in the paired Engine lockfile.

## Navigation and grouped details

Search and populated functional groups remain fixed below the card. Common
remains the default when available; ordinary meshes show Transform / Static
Mesh / Materials. All always contains every returned component and field.
Clicking an overview row clears search, switches to All, expands that component
and scrolls only the independent Details region to its section. It highlights
the clicked overview row without filtering out any other component. Choosing
a category clears this navigation highlight and shows that category's complete
entity-level details.

Changing scene entity, project or target resets local detail state. If the
navigated component disappears, the Inspector clears its navigation/search and
returns to the default category. Top-card component actions do not call
`scene.select`, so the Scene Tree selection, viewport highlight and primary
entity remain unchanged.

All other interaction remains read-only: field and JSON copying, search,
functional groups, collapse/expand and focus use existing View behavior. Resource
opens still require explicit returned GUIDs and use the existing independent
asset pages. No workspace operation, Engine API or write capability is added.
Component-heading copy buttons keep their layout space but are hidden until
that heading is hovered or the copy button receives visible keyboard focus.
Hovering a field does not reveal the component-heading action. Copying retains
the original returned component JSON, including unmodified XYZW quaternions.
Local Transform Position, Rotation and Scale retain one horizontal row each:
the label and all three XYZ values stay together when the Inspector resizes.
Narrow panels reduce column spacing and use compact numeric typography rather
than moving the label above the values or wrapping Z onto another row.

The unified projection retains the merged PR #161
rotation behavior: local `Transform.quat` appears as three intrinsic XYZ degree
values in Common and All. The original Engine XYZW remains available in the
tooltip and copy actions. Other components' quaternion-shaped fields follow
their returned schema.

## Current frontend adaptation (2026-10-15)

The current production entity panel uses this grouped Details layout by default.
It retains the current platform clipboard provider, panel visibility leases,
target-scoped cancellation, shared field controls and AssetReferenceField.
Material slots keep current empty, unavailable and truncated states in both the
semantic Materials section and the raw MeshRenderer field in All. Color display
mode is a local presentation choice and submits no Engine write.

The bounded component area and separate Details scroll region retain their
layout. The complete component overview replaces the earlier root/function
tree within the same card geometry. GlobalTransform.presentation and the
TransformInterpolation marker are visible through both overview navigation
and All.

The existing production-mount Chromium proof reproduced the flat-panel
regression by failing to find Common before the change. The adapted proof
checks both themes, widths 220/280/300/320/480/640, overview completeness,
component navigation, fixed-card geometry, component removal, project/target
replacement and injected clipboard writes.
The full Node suite passes 501/501 with the current Engine declarations.
The paired Engine browser probes assert grouped Common details, complete raw
component rows, navigation into All and unchanged scene selection.

### Complete-overview acceptance

The component-heading hover-copy follow-up is rebased onto remote main
`78d97e8`. The isolated PR source, with unrelated local asset-navigation work
temporarily removed, passes all 496 Node tests, strict package types and the
architecture gate (16 packages, 333 source files, zero violations). The
production-mount browser proof verifies default-hidden heading actions, reveal
only on the hovered heading, unchanged button geometry, visible keyboard focus
and copying the original Transform quaternion through the clipboard provider.
The earlier 501-test counts below describe the local workspace with its
additional asset-navigation tests, rather than the isolated PR scope.

The revised frontend reports code revision
`823df903a2c76151562da571ef98e5c650dad803cd1d34e7e306a4e64a52731d`.
After rebuilding and restarting the task-owned preview, the real Game 3D
Inspector shows all ten returned Astral Bloom components, including Entity,
GlobalTransform, Transform, ChildOf, Name, TransformInterpolation and separate
MeshFilter / MeshRenderer rows. The list scrolls inside the same bounded card.

Clicking MeshRenderer switches to All, keeps all ten Details sections and
scrolls its section to the Details region's top. Before/after measurements
retain the same card position and dimensions (429.578125px wide, 260px high in
the acceptance viewport). Authoritative scene-selection snapshots are equal.
The live renderer completed more than 4,000 frames. The final browser keeps
Astral Bloom selected, the complete overview visible and All open.

Strict types, the complete 501-test Node suite, architecture checks and the
production build pass for this revision. The updated production-mount browser
proof passes both themes, widths 220/280/300/320/480/640, complete raw rows,
navigation, unchanged card geometry, component disappearance, project/target
resets, clipboard injection and the existing schema/read-only cases. Package
scripts were executed directly after pnpm's dependency preflight failed before
launching the checks. The earlier full Engine-shard limitations below remain;
this narrow UI revision does not claim a passing four-shard gate.

Current evidence is in `artifacts/details-current-20261015/`:
`details-overview-live-final-20261015.jpg`,
`details-overview-live-navigation-20261015.jpg`,
`details-overview-live-ui-20261015.json`,
`details-overview-live-selection-20261015.json` and
`details-component-browser-*-20261015.log`.

### Earlier functional-tree candidate acceptance (superseded)

The rebuilt worktree frontend was admitted into a fresh browser environment
against the local Engine `9d3f882c4` and the original `templates/game-3d` project.
Its panel graph reports code revision
`c19e3e2c470b098cd35384fdf1f924cc8484db4af2769ab379274275ed819f7b`.
The visible Astral Bloom Inspector has the entity root, Static Mesh, Rigid Body
and Collider nodes, with Common showing Transform / Static Mesh / Materials.
Selecting Static Mesh reduces Details to Static Mesh / Materials; the workspace
scene-selection snapshots remain identical. Selecting the root restores all
three Common sections. A live rendered frame counter was also observed.

Main Camera shows Transform / Camera in Common. Its local rotation displays
XYZ degrees without a W control. The final browser was returned to Astral Bloom
with the root selected and the Inspector visible.

Evidence from this local acceptance is saved under `artifacts/details-current-20261015/`:
`details-live-astral-bloom-20261015.jpg`, `details-live-component-20261015.jpg`,
`details-live-camera-20261015.jpg`, `details-live-ui-20261015.json` and
`details-live-selection-20261015.json`. These are browser/GPU observations,
separate from the deterministic UI fixture and Node tests.

### Earlier candidate regression results and qualification limits

Strict package types, all 501 Node tests, the architecture scanner (16 packages,
334 source files, zero violations), the production build and `git diff --check`
pass. The production-mount Inspector fixture passes its theme/width matrix,
state resets, current fields, clipboard injection and read-only checks.

The four existing Engine browser shards were attempted against a temporary
overlay of this candidate. The plugin probe passes the new grouped Details,
component filtering, complete All and unchanged-selection assertions on a real
Engine entity. It later fails during a resource `openPreview` timeout. The
lifecycle group passes after selecting the installed macOS browser; the
Engine-without-View cold build also passes after restoring the exact cached FBX
artifact. The contracts checks reached before MCP Game 3D pass, but MCP Game 3D
fails during startup/Play admission. The diagnostic shard fails at `view start`
with `plugin-startup-failed`, before creating its browser. A direct retry of the
updated Game 3D probe reaches automatic project opening, then times out at a
resource click; its renderer diagnostics report `device-operation-failed`.
Downstream runtime-content stages were not reached. Consequently this local run
does not qualify the complete four-shard bootstrap gate or claim passing CI.

Harness verification cannot pass because this worktree has no Harness install
manifest. KB lint passes with zero errors/warnings and unchanged Mermaid checks
excluded. Test logs are retained alongside the live evidence. The temporary
Engine embedded-View overlay is restored after validation; the running preview
uses the rebuilt View worktree directly.

## Original verification (2026-10-13)

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
