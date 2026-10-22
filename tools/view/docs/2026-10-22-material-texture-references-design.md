# Material texture references

## Behavior

Material Details places Texture references between Material facts and Passes in
one scrolling body. Each unique referenced texture has the existing 64px
`AssetReferenceField`, including contained PNG presentation, loading/error
states, folder navigation, thumbnail double-click/Enter and ExternalLink open.
Single clicks and asset names do not navigate. Missing assets cannot open;
thumbnail failures do not disable otherwise valid navigation.

These cards describe declared texture dependencies. They do not claim shader
slot names, slot indices, sampler associations, repeated bindings, or which
textures a shader actually samples. The shared `MaterialSlot` wrapper retains
its actual mesh-slot semantics and is not used here.

## Engine boundary

The verified installed Engine is revision
`284f102afad1c3d33527064ecc0b84b11262e2e9`. Engine source, tests, configuration,
Game 3D assets and Git state remain unchanged by this implementation.

The existing public `EngineWorkspaceAssetBinding.publication` is a captured
`AssetPublicationEnvelope`. Its `outputs` carry `guid`, `kind` and ordered GUID
`refs`. View selects exactly one material output matching the displayed GUID;
it never combines sibling outputs. The current Catalog explicitly identifies
`texture` and `equirect` dependencies and supplies their names. GUIDs are
deduplicated case-insensitively in first-reference order. Unknown dependencies
produce an incomplete-information status, without invented types or navigation.

For a bound preview only its captured publication is accepted. A missing bound
publication is unavailable even if current inspection could return another
version. Without a binding, the existing `asset.inspect` result supplies
`publication` or `source.publication`. Unavailable publication, empty texture
references, loading and unresolved dependencies have separate states.

Thumbnails use the existing `assets.thumbnails` contract through workspace-core's
`observeAssetThumbnails`: at most 32 GUIDs per batch, progressive readiness from
`thumbnailEpoch`, publication checks and cancellable reads. These thumbnails and
navigation address the current Catalog assets by GUID, not a reconstruction of
old GPU bindings from the retained material publication.

## Ownership and lifetime

The Material plugin owns dependency projection, its UI and its read leases.
Shared components remain workspace-agnostic and workspace-core remains
React-free. No public API, Engine operation, shared contract or asset registry
is added. Existing `ResourceAssetActionResolver` owns PageType selection, page
reuse and navigation failures.

Project/root, project target, preview target/generation, browser generation,
material binding, Catalog epoch and relevant asset revisions fence reads and
actions. Fallback inspections carry their scope into stored results; a stale
scope cannot render a late response. Hiding the native panel cancels inspection
and thumbnail observations and releases the workspace subscription while
preserving local UI state.

## Implementation and evidence

The Material plugin's `texture-references.ts` projects owner facts and scopes;
`MaterialTextureReferences.tsx` composes shared fields and thumbnail leases.
`MaterialPanel.tsx` splits existing Inspector groups without changing them and
mounts the native visibility provider through `ui/mount.tsx`.

This extends the presentation reuse in the
[Mesh material slots design](2026-10-22-mesh-material-slots-design.md) without
changing its native entity-reference mechanism or the
[Inspector thumbnail design](2026-10-22-inspector-asset-thumbnails-design.md).
Validation boundaries and results are recorded in the
[delivery evidence](evidence/2026-10-22-material-texture-references/README.md).
