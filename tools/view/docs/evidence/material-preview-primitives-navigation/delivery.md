# Material preview delivery evidence

Date: 2026-10-22. All product work is isolated from primary-checkout edits.

| Owner | Branch | Commit |
| --- | --- | --- |
| Engine | codex/material-preview-primitives-navigation | 5253a6598e75b5be0d03deb0166b7d6c4aceffcb |
| View | codex/material-preview-primitives-navigation | 1221ee96ccbf5141deb6bb3eedf8b10182aab612 |

These are the accepted implementation commits. The paired PR descriptions name
their published delivery heads, including subsequent documentation and gitlink
updates. Engine's tools/view gitlink selects the exact paired View candidate.
View workflow configuration remains unchanged.

The PR delivery merges the maintained View main and Engine view bases. After
that merge, View strict source checking and all 615 source tests pass; the four
Engine App workspace/material/browser/display files still pass all 45 tests.
The original rendered/native acceptance below applies to the accepted
implementation pair, not a claim that full GPU gates were repeated after merging.

## Passed

- App and DevKit package TypeScript checks; View full strict package source check.
- Engine App workspace/material/browser/display tests: 4 files, 45 tests.
- DevKit resource-backdrop and workspace-provider tests: 2 files, 68 tests.
- View full source suite: 593 tests, no failures or skips.
- App, DevKit and View production bundles built successfully.
- Engine staged-tree documentation policy and both product diff whitespace checks.
- Actual sandboxed Chromium/GPU `verify-resource-preview-lifecycle.mjs` passed.
  Four primitives use a real direction-textured MaterialAsset. Captures are
  completed-frame outputs from the exact preview target. Left drag changes only
  the object quaternion; right drag and wheel change camera position with FOV
  unchanged; middle drag changes pan/pivot. Reset restores orientation and camera,
  retaining Cube. Hiding retains Cube and close/reopen returns Sphere.
  The existing Mesh replacement/capture and close lifecycle remains covered.
- Toolbar fits a 390px viewport. The narrow image qualifies the new toolbar,
  not unrelated pre-existing narrow Inspector/Stats layout behavior.
- Native Fiber removal restores borrowed mesh/orientation, releases the generated
  geometry, rejects retired controls and reinstalls at Sphere. Public ToolApi
  tests reject wrong targets and generations. Input tests cover coalescing,
  one in-flight rotation, focus loss, abort, teardown and Scene dolly defaults.
- After switching game-3d to the paired build and updating its same-project
  native plugin package with explicit approval, the user reported successful
  acceptance in the Codex plugin panel: "我验证通过了" (2026-10-22).

`result.json` and material-*.png beside this file are from the final successful
browser run. The underlying material is an explicit test Pack, never product
fallback data. A separate optional backend serves the same fixture for manual
review. A later user-approved native acceptance switched the game-3d backend and
its machine-local Engine binding to this feature worktree, without changing
project asset sources. Missing generated Rapier artifacts were restored before
native acceptance. The plugin retained its exact original game-3d project root.

## Unverified Gates and Recovery Attempts

- Full `pnpm test:browser` reaches its maintained browser launcher but the
  configured Chrome Beta executable is absent at
  `/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta`.
  Focused acceptance instead uses installed Playwright Chromium with its sandbox
  retained; this does not qualify the full browser suite.
- Full `pnpm test:dawn` rebuild reaches wgpu-wasm and rejects the copied local
  artifact because its source provenance differs from this exact checkout.
  The supported fetch requested `wgpu-wasm-pkg-c57b5f5a.tar.gz` from the Engine
  wasm-artifacts release and returned `E5_AUTH_FAILED` / HTTP 403. The native Dawn
  carrier expected at dist/native/darwin-arm64/dawn.node is also absent.
- The maintained full 60-frame hello/learn-render roster was attempted with the
  exact product revision. Its preflight fails on missing demo shader manifests.
  No frame, pixel, provenance, sandbox or gate requirement was relaxed.
- Native acceptance is the user's reported successful check after the approved
  package/backend switch. The automated PNGs remain ordinary sandboxed browser
  evidence; no automated native screenshot or full native frame-count gate is
  claimed.
- Before the maintained-base merge, View CI pinned Engine
  284f102afad1c3d33527064ecc0b84b11262e2e9. The current main baseline pins
  635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778, which also predates these material
  operations. This PR introduces no workflow changes relative to main. Its
  description identifies the published Engine candidate; an unapplied
  administrator patch updates that CI pin. Engine's final tools/view pin must
  be updated to the accepted View main commit after View merges.
