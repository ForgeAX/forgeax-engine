# Mesh Preview Roam Camera

Date: 2026-10-22. Status: implemented; native pointer/pixel acceptance remains manual.

## Problem And Behavior

An isolated Mesh preview borrows a canvas in the retained Engine document. The
outer panel cannot reliably sample input or apply the camera transaction to that
document through its own DOM controller. Mesh navigation must address the Mesh
preview camera, and restoring the view must finish any active gesture first.

The viewport input plugin now attaches the existing `ViewWorkspaceInputController`
to the admitted Mesh container inside the canvas document. Mesh input uses the
ordinary roam bindings, disables Scene selection on click, and restores the
initial preview pose on focus-selection. The Mesh panel does not attach a second
controller when presentation placement is `owner`.

## Ownership And Contract

Engine remains read-only in this delivery. The verified pair is Engine
`284f102afad1c3d33527064ecc0b84b11262e2e9`, selected by this branch's CI pin and
local package graph. Current View main selects Engine
`635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778`; remote PR checks qualify that merge pair.

Engine's public `@forgeax/engine/app` contract exposes
`EngineWorkspacePresentation.resolveTarget(targetId)` and the resolved preview's
`getCamera`, `beginCameraInteraction`, `updateCameraDraft`, `commitCamera` and
`abortCameraInteraction`. View reuses these methods through the shared
`preview-camera` input adapter. Camera input retains the exact target generation
and a canvas client identity; Engine still owns validation, integration,
transactions, versions and cleanup. No Engine exports or implementation change.

The existing native preview lease gains an optional `finishCamera` request. It
uses the same authenticated parent, project/session/World/browser scope and
active lease as surface placement. This is View input coordination: it finishes
the local controller before the Mesh panel restores its saved initial pose
through the existing camera API. It is not a new Engine camera operation.

`view-workspace-core` owns only the shared presentation adapter and request
shape. The viewport plugin owns input attachment and teardown. The Mesh plugin
owns its restore control and same-document attachment. Other asset pages keep
their current pointer routing. Hiding, replacing or closing a native preview
retires its controller; removing the input Fiber releases its listeners while
preserving the borrowed Engine canvas and retained frame.

This extends the isolated-document placement described by the
[independent-session design](2026-10-11-independent-view-session-design.md).
For isolated Mesh previews it supersedes outer-panel input sampling only.
Independent runs, Scene selection and Engine resource lifetime retain their
existing contracts.

## Implementation And Verification

- `view-plugin-viewport/src/input.ts` binds the admitted Mesh owner container.
- `view-plugin-mesh/src/ui/MeshPreviewPanel.tsx` selects the local adapter for
  same-document previews and waits for native camera finish before restore.
- `view-workspace-core/src/preview-camera.ts`, `engine-presentation.ts` and
  `preview-surface.ts` forward public target methods and coordinate the lease.
- `test/native-preview.test.mjs` covers local camera input, no Scene pick,
  finish-before-restore, plugin removal/restoration and retained borrowed nodes.
- `test/preview-surface.test.mjs` covers presentation wrapper forwarding;
  `test/workspace-input.test.mjs` retains the existing Scene and orbit policies.

The branch View build and MCP App build succeeded against the verified local
Engine. Native Codex startup opened `templates/game-3d`; public presentation
reported a mounted Shell, running project and exact project/preview target.
This establishes startup and presentation wiring only. Native MCP Apps automation
does not expose native pointer input or screenshots of nested frames here;
those observations do not establish roam motion or rendered-pixel acceptance.
The PR records automated check results separately from that manual boundary.
