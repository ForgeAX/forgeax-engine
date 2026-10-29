# Material preview primitives and navigation

Status: implemented and accepted by the user in the native Codex plugin; full GPU gates remain blocked by environment, 2026-10-22.

This decision supersedes the Material page's Scene-style look/WASD policy in
[the earlier Material navigation design](2026-09-24-material-viewport-fly-camera.md). Scene and Mesh navigation retain
their own policies. The user explicitly authorized the paired Engine extension.

## Interaction

The Material viewport toolbar contains Reset and four mutually exclusive icon
buttons: Sphere, Cylinder, Plane, Cube. Sphere is the default. The current preview
owner retains the choice through hiding and tab selection; closing and reopening
starts a new default owner. Nothing is saved to the authored asset.

Left drag rotates the preview object around its own center. The camera and lights
do not orbit. Right drag up zooms in and down zooms out; the wheel also dollies.
Middle drag pans, allowing the object off center. WASD is inactive. Reset retains
the primitive, restores the object's initial orientation and the opening camera,
and recenters the view. Changing primitive retains orientation, camera and pan.

Reference: [Epic's UE5.6 Material Editor UI](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-material-editor-ui?application_version=5.6),
which describes left drag rotating the mesh, middle drag panning and right drag
zooming. Wheel dolly is an explicit requirement for this delivery.

## Engine contract and authority

The previous public workspace contract exposed texture options and mesh display
controls but fixed Material previews to a sphere. View cannot correctly replace
Engine geometry or mutate a preview World through that contract.

The App native material-preview Fiber supplies `engine.preview.material.get`,
`set`, `rotate`, `reset` on the exact target and generation. `set` accepts only
`mesh: sphere | cylinder | plane | cube`; `rotate` accepts finite yaw/pitch radians.
Replies contain mesh, quaternion rotation, center and radius. Reset restores
orientation only. Engine composes rotations, owns the generated geometry handle,
and performs validated complete Registry replacement without changing the
material, camera, target generation or assetBinding publication.

All primitives have a common origin and unit bounding sphere. The plane is XY,
normal +Z; it retains the authored material's actual culling behavior. Thumbnails
and canonical noninteractive preview proofs retain their existing presentation.
The native Fiber restores borrowed bindings on removal and releases its geometry;
reinstallation starts at Sphere. The ordinary browser and isolated document paths
project the same owner operations, with existing command ordering and stale guards.

## View implementation

View consumes Engine state directly and owns buttons, input, sensitivity and
request scheduling. Material's mount forwards the existing input-controller
factory. Camera gestures use the shared orbit binding; only Material caps each
dolly step to 0.25 to avoid crossing the observation pivot. Left drag coalesces
displacement per animation frame and sends at most one rotation at a time.

Surface readiness and target-scoped observation gate initialization. Initial
pivot uses the returned center. Hidden/inactive/unloaded pages stop input and
reads, drop unsubmitted rotation and retain accepted state. Reset and shape
changes drain admitted work first. Failure retains the last accepted state and
is visible; reset is an explicit two-owner sequence and reports partial failure.

## Evidence

Engine branch: `codex/material-preview-primitives-navigation`, base `8e55d7ed0367f1a474ac3d34fd323e81473f5430`.
View branch: same name, base `825f1d3fd5755c5d551a74201774cd8ae6d12f49`.
The separate worktrees preserve all pre-existing primary-checkout changes.

Maintained browser probe: View `scripts/verify-resource-preview-lifecycle.mjs`.
It uses actual Engine resource owners, direction-textured material, exact target
captures, object/camera checks, reset, and close/reopen lifecycle. PNGs and JSON
are generated in View `artifacts/resource-preview-lifecycle/`. Tests/builds and
any incomplete native/whole-suite checks must be recorded in the delivery report;
a mounted document or successful URL is not native pixel acceptance.

Accepted implementation commits: Engine `5253a6598e75b5be0d03deb0166b7d6c4aceffcb`,
View `1221ee96ccbf5141deb6bb3eedf8b10182aab612`. The paired PRs carry subsequent
documentation and exact gitlink updates. Product documentation and browser
evidence are published in this View repository; the earlier Harness record is
retained as historical local evidence.
See [delivery checks](evidence/material-preview-primitives-navigation/delivery.md)
and [desktop toolbar PNG](evidence/material-preview-primitives-navigation/material-toolbar.png).
