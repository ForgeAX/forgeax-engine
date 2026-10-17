# Scene Mesh Asset Navigation

The explicit-GUID-only entrance and mesh-only scope below are superseded by
[resident asset references](2026-10-15-view-resident-asset-references-design.md).
The original Engine builtin inspection is unchanged; an optional View-distributed
native plugin now resolves actual held resource identities using public APIs.

This View-only change follows UE's two distinct asset actions: [Browse to
Asset](https://dev.epicgames.com/documentation/unreal-engine/reference-viewer-in-unreal-engine?lang=en-US)
opens a Content Browser with the asset selected, while Edit opens its dedicated
asset tool. [UE Static Mesh documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-materials-with-static-meshes-in-unreal-engine)
also shows a mesh asset opening in a dedicated mesh tool. View uses the
existing read-only mesh preview for Edit; no mesh geometry editing is added.

## Ownership

Scene Tree adds the two actions to every mesh row. On right-click it inspects
that entity through the exact project/target/generation, then accepts only an
explicit `MeshFilter.assetHandle` GUID that matches a Catalog mesh. Changing
the target or project aborts the inspection. The menu retains disabled actions
with a reason when the owner returns a numeric handle, omits the binding, or
the Catalog no longer contains the GUID. No entity name, source path, handle
order or latest Catalog publication is used to infer a binding.

The Content Browser frontend plugin owns the optional `viewAssetBrowser`
Cordis service. Its reveal action checks the project and exact Scene target,
focuses the existing Content Browser panel, clears obstructing filters,
expands the containing Pack, selects the asset by GUID, and waits until that
card is visible. User navigation and project/target replacement cancel the
request. Scene Tree calls this service through the frontend contract rather
than importing another product plugin's implementation. Removing the Content
Browser revokes the service; Edit remains available for identified meshes.

Edit calls the existing `asset.open` operation and routes to the dedicated
mesh page. Its page controller reads the opened mesh from View workspace state,
preferring the opened asset name, then the same-GUID inspection/Catalog
`sourceKey` final segment. It never uses a source path to infer identity.
For example, `mesh/cube` titles the tab `cube`. The existing static page title
remains the fallback when no asset name is available.

## Current Data Boundary

The task-owned Game 3D scene reports `Lacquer Collision Cube` with
`MeshFilter.assetHandle: 1028`. Catalog lists `mesh/cube` as GUID
`bcb1b300-e235-59eb-b12b-fe619fd4165f`, but the public target inspection
returns no relationship between them. The scene root reports a numeric source
handle and an unlabeled entity mapping; project `asset.inspect` for the scene
returns source identity without an entity-to-mesh table. The two menu items
therefore cannot navigate from this live entity under the Engine read-only
constraint. The authoritative target tools would need to add a read-only mesh
binding GUID derived from the entity's held resource for those actions to work
on ordinary Engine scenes. The user confirmed that Engine remains read-only in
this delivery, so numeric-handle menu actions stay disabled. This change does
not modify Engine.

## Verification

Focused identity and page-title tests cover explicit GUIDs, numeric handles,
Catalog kind mismatch, `mesh/cube` naming and resource-page retention. A
Chromium fixture exercises the production Scene Tree and Content Browser
panels together: both right-click actions, exact Pack/asset selection, no
scene-selection change during Browse, plugin removal/restoration, and late
inspection cancellation after target replacement. After rebasing onto
`b40df19`, the full View Node suite, type check, build, architecture check,
and Chromium fixture pass. In the live Game 3D
browser, right-clicking `Lacquer Collision Cube` shows both actions disabled
because its inspection returns `1028`. Opening the explicit `mesh/cube` Catalog
asset reaches the independent preview, and its tab title is `cube`.
