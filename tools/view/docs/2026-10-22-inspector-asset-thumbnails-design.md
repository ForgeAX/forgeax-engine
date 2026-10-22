# Inspector Asset Thumbnails

Date: 2026-10-22. Product branch: `codex/inspector-asset-thumbnails`, based on
View main `825f1d3`. Engine remains read-only.

Implementation: product commit `8cae88e`. See the
[delivery report](evidence/2026-10-22-inspector-asset-thumbnails/README.md) for checks,
screenshots and native acceptance limits.

## User Behavior

All explicitly resolved entity asset references use a fixed 64x64 thumbnail.
Ready images display the Engine PNG with `object-fit: contain`. Pending, failed,
unsupported and missing references preserve geometry and use the type/empty
placeholder with a localized status tooltip. A missing image does not disable
navigation when an asset identity is available.

Double-click and Enter invoke the existing `openAsset` action exactly once.
Single-click and the asset name do not navigate. Existing folder and ExternalLink
buttons remain available. No asset assignment, clearing, picker, drag-and-drop,
inline renderer, thumbnail camera or real-time animation is introduced.

This extends the native inspection policy recorded by
View PR #183 and the
[resident reference design](2026-10-15-view-resident-asset-references-design.md).
It supersedes the type-icon-only thumbnail presentation while preserving the
read-only asset name and separate folder/ExternalLink actions. Epic's
[Object Reference Control](https://dev.epicgames.com/documentation/en-us/unreal-engine/object-reference-control?application_version=4.27)
documents the reference-thumbnail double-click convention; the page is explicitly
versioned 4.27. UE5's
[Content Browser thumbnail settings](https://dev.epicgames.com/documentation/en-us/unreal-engine/content-browser-settings-in-unreal-engine)
provide additional presentation context, not an Engine capability contract.

## Public Contract and Ownership

The paired source dependency resolves to Engine worktree
`scene-triangle-picking-10-20` at `442b22e`. The running native Game 3D uses Engine
main `0e90968`. View CI selects Engine
`284f102afad1c3d33527064ecc0b84b11262e2e9`; read-only inspection confirms that
revision also declares the operation. These revisions expose DevKit `engine.assets.thumbnails`
operation and its owner implementation in `workspace-thumbnails.ts`.

The existing View `assets.thumbnails` operation delegates to that owner, carrying
the accepted project identity and exact project target, with at most 32 unique
GUIDs per batch. The result supplies `queued`, `cooking`, `ready`, `failed` or
`unsupported`; ready rows include a 128x128 PNG data URL. The workspace's existing
`thumbnailEpoch` announces progressive changes. Project mismatch and unavailable
operations remain owner/query failures.

Inspector holds only the current entity's response projection. It deduplicates
all explicit mesh, effective material, scalar and collection reference GUIDs.
Publication identities are checked only when returned by the public contract;
View does not synthesize them. Engine owns generation, source interpretation,
rendering and its disposable DDC cache.

Project, target/generation, primary selection, browser generation, Catalog and
returned publication/lifecycle changes fence the projection. The workspace reader
revokes a mismatched read synchronously. Hiding or removing the Inspector releases
its read lease; returning obtains fresh results. Epoch notifications reread pending
rows, without repeated queries for terminal ready/failed/unsupported results.

Shared `AssetReferenceField` accepts optional presentation-only thumbnail props.
It imports no workspace or Engine API. The Inspector-owned React context forwards
its projection through existing reference fields; it adds no global service,
asset registry, renderer, page lifecycle or sibling-plugin dependency.

## Verification Boundary

Read-only calls to the live Game 3D owner returned cache-hit, ready PNGs for
`mesh/astral-bloom` (`51fb3285-a68b-5b7d-81d7-7b9e1d1e4090`) and
`material/fantasy-azure` (`482404b3-be7b-5800-8869-5991df2afe66`). Those exact PNGs
are the checked-in Storybook/test images. They are not View-generated substitutes.

The changed Inspector UI regression uses the actual PNGs with fixture transport.
It verifies real image decoding, 64px geometry, contain sizing, light/dark and
220/280/360/640px widths, double-click/Enter, missing identities, progressive
completion, hide/show, texture-reference navigation and image/open failures.
It asserts the submitted GUID and exact target/generation. Pure tests cover
batching, all-reference collection, synchronous invalidation and late responses.

The native Codex display artifact was subsequently rebuilt against View `8cae88e`
and loaded through the existing plugin's public View stop/start flow. The retained
Game 3D binding reached `projectPhase: running`; the mounted document was checked
for the new thumbnail control. The user supplied a native-panel screenshot for
the PR comment, preserved unchanged in the product evidence directory. This is
native presentation evidence, not automated completed-frame/GPU acceptance.
No Play or independent game run was started. The delivery report records the
checks, local setup limits and screenshots.
