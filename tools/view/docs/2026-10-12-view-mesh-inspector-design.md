# Mesh Entity Inspector

Historical first delivery: View-only presentation of ordinary non-skinned mesh entities.
The mesh-only entrance and five-group scope below are superseded by
[All Scene Entity Details](2026-10-12-view-entity-inspector-design.md). Its
resource identity and Engine read-only restrictions continue to apply.
Engine is read-only for this delivery. Product edits are limited to View and,
when needed, `game-brotato-v2`; no Engine or separate Harness repository changes.
This explicit user constraint supersedes the earlier proposal to extend
`entity.inspect` with mesh/material binding projections.

## Layout and ownership

The Inspector orders object identity, local relationships, search, functional
groups and collapsible details. Common is the default and contains only
Transform, Static Mesh and Materials. Object, Rendering and Physics appear when
their existing components provide data; All preserves every raw component,
including derived transforms and unknown game components. The subsequent
all-entity delivery also applies this layout to non-mesh and skinned entities.

This replaces the flat mesh layout recorded under the existing read-only Editor
tools boundary. Resource pages and independent run ownership remain governed by
the prior asset-page and independent-session decisions.

Entity nesting uses Engine `parentId` facts; components are siblings attached to
their owning entity. The current entity is expanded, descendants are collapsed,
and the tree has its own scroll area bounded to 180px. Parent and child selection
uses `scene.select`; component clicks locate properties without changing the
scene selection. Pagination carries the first structural revision and displays
incomplete/error states rather than inferring missing children.

## Existing data contract

Shared types derive from the installed public `EngineWorkspaceTargetTools`
methods through type-only imports. View does not read World directly, load
assets, add a resolver/registry, or introduce a workspace operation.

Transform consumes local `pos`, `quat` and `scale`. The merged rotation change in
PR #161 displays local
`quat` as intrinsic XYZ degrees. The returned XYZW remains available in tooltips
and copied values; position and scale retain Engine coordinates and units. Common
formats Float32 display noise to six significant digits.

Static Mesh displays the actual `MeshFilter.assetHandle` value. A numeric handle
does not establish a GUID or asset name. Material rows display positional
`MeshRenderer.materials` overrides, including zero/inherited references. The
existing operation does not return the complete declared slot table or effective
default-material identities. Those facts stay explicitly unavailable; an empty
override array is not labelled as an empty material table. Catalog names are
used only after a GUID is explicitly present in the inspected reference.

Known-GUID links use existing `asset.open` and independent asset pages. They do
not borrow the Editor surface, rebind an AI run, or silently resolve a handle by
name/source matching. Entity reads remain on the selection's exact Editor
target/generation while a resource page is selected. State publication revokes
old reads synchronously, and current operation failures remain visible.

## Verification

Tests cover group visibility, raw-field retention, XYZ rotation display and the
original quaternion copy value, explicit
GUIDs versus local handles, empty material overrides, local hierarchy/cycles,
pagination revisions and synchronous cancellation. Chromium exercises the
production Inspector with explicit fixture responses at 320/480/640px in both
themes, plus search, group navigation, expand/collapse, copying, selection and
capability failure/recovery. Numeric text width is checked as well as control
bounds. Fixture evidence is UI evidence, not Engine/GPU acceptance.

Local evidence on 2026-10-12:

| Check | Result |
|:--|:--|
| Inspector/source/workload tests | 18 passed |
| View suite | 440 of 442 passed; the two independent frontend/CLI session failures also reproduce on unchanged View HEAD with the same installed SDK |
| Architecture source gate | 15 packages, 309 source files, zero violations; architecture contract tests are included in the View suite |
| Product build | Passed through `node scripts/build-tool.mjs` |
| Inspector UI probe | Passed through `node scripts/verify-mesh-inspector-ui.mjs`; 320/480/640px, light/dark, raw copying, whitespace search, catalog label refresh, cancellation, target replacement and capability restoration |
| Real Engine probe | Passed through `node scripts/verify-mesh-inspector-engine.mjs`; actual cooked scene, numeric handles, empty overrides, unnamed mesh child, parent selection and preserved Editor identity; captured pixel contrast was 87 |
| Brotato browser | Native Backend/View startup opened `game-brotato-v2`, then `scene/arena`; selecting `Farm Floor` showed exactly three Common sections, read-only numeric controls and the 180px relationship scroll area |
| KB lint and whitespace | Passed; no separate Harness data edits |
| Strict package types | Blocked by existing `listPackSources` imports in `src/plugins/backend.ts` and `src/plugins/product.ts`: installed Engine Pack JavaScript/source exports it, but its declaration artifact does not |
| Harness install verification | No local install manifest in this worktree; no installation or data-repository mutation was performed |

The focused real browser probe uses ordinary public startup/workspace operations
and the installed Engine artifacts. Its Vite dependency cache is scoped to the
disposable project's `node_modules`; it does not rebuild or modify Engine. Real
screenshots/results are saved under `artifacts/mesh-inspector-engine/`, and the
Brotato screenshot under `artifacts/mesh-inspector-ui/brotato-farm-floor.png`.

## Remaining limits

This is not acceptance of the original proposed resource projection. Existing
numeric references cannot establish bound resource names, full slot names,
default-material origin, stale-handle status or retained publication versions.
Inspector resource navigation is tested with explicitly supplied GUIDs in UI
fixtures; current real mesh references expose no GUID and keep that control
disabled. View does not infer one from authored scene data or the latest Catalog.

The complete `bootstrap` delivery gate is not green: the two baseline tests,
installed declaration mismatch and missing local Harness manifest remain. The
four paired Engine browser shards were not run; their preparation would rebuild
Engine, outside the authorized repositories. The focused real Engine/browser
evidence above verifies the changed Inspector behavior only.
