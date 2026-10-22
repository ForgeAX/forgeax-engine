# Mesh Material Slot Cards

Date: 2026-10-22. Product branch: `codex/mesh-material-slot-cards`.
This is the canonical product design; it supersedes the unpublished Harness
snapshots `2784ec3` and `76d46ac`. Implementation and acceptance evidence ship
together in the View repository, following the product documentation policy.

## Behavior

Mesh Properties uses the same compact material reference cards as Scene Details:
slot index/name, source label, 64px thumbnail, asset name, folder and ExternalLink
actions. The original slot fields remain in collapsed Slot details. This
supersedes generic Slot Name / Source Key / Default Material rows for this section.
Its title uses the ordinary Inspector group geometry, icon, sidebar background
and left stripe. A theme-aware blue stripe (`status-info-fg`) distinguishes
Material slots, ordered after Mesh facts and before Submeshes.

Double-click or Enter on the thumbnail, or clicking ExternalLink, opens the
existing Material page. Folder reveals the asset in Content Browser. Single
thumbnail clicks and names do not navigate. Assignment and clearing remain
disabled. Builtin, missing, stale and unregistered references cannot navigate.
Image failure does not disable navigation for a valid identity.

## Contract and Ownership

Mesh consumes its captured preview `assetBinding`, preserving slot order and
publication identity. Public `scene.tree.get` reads the exact preview with
revision-carrying pagination; `entity.inspect` returns native assetReferences.
Only one entity whose resolved MeshFilter GUID matches the opened Mesh is
accepted. Indexed MeshRenderer references supply material GUIDs; numeric defaults
must match the captured numeric handles. Names, Source Keys, catalog order and
publication dependency arrays never infer identities. World mismatch, ambiguous
entities and non-advancing pages fail closed. Engine truncation remains visible.

Wireframe temporarily replaces the preview mesh and renderer with auxiliary
assets. Already verified references remain only within the same bound identity.
An initial wireframe read cannot resolve those references and exposes an explicit
reload action; reload never changes the display mode.

`MaterialSlot` and `AssetReferenceField` are workspace-agnostic components.
Scene and Mesh retain separate product adapters. Workspace-core's shared
`observeAssetThumbnails` batches at most 32 unique GUIDs, follows thumbnailEpoch,
checks returned publication/lifecycle, and cancels obsolete reads. Each panel
owns its response projection; Engine owns image generation and caching.

The existing resource-page Fiber now subscribes its workspace reader so action
resolvers receive live state. Removal releases the subscription and stale
callbacks are guarded. Project, browser, target/generation/World, binding and
catalog changes fence Mesh references. Hidden panels release active read leases.
No backend operation, renderer, registry, execution policy or Engine owner is added.

This extends [Inspector thumbnails](2026-10-22-inspector-asset-thumbnails-design.md)
and the View-owned policy in [resident asset references](2026-10-15-view-resident-asset-references-design.md).

## Pair and Acceptance

Initial source inspection used Engine `442b22e`; local builds and browser
acceptance reuse the installed `284f102afad1c3d33527064ecc0b84b11262e2e9` artifact.
Current main selects `635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778` in CI. Read-only
comparison confirms unchanged asset-reference, target-inspection, asset-fact,
workspace and resource-presentation implementations. The consumed App exports
remain available. No Engine files or CI pins are changed by this delivery.

The [evidence report](evidence/2026-10-22-mesh-material-slots/README.md) separates
fixture layout/interaction checks, native Engine pixels/navigation and remote CI.
