# Cloud Material Details and Volume Textures

The `vc-ue` delivery adds read-only details for cooked cloud materials and their
instances. The user explicitly authorized changes to the paired Engine `vc-ue`
worktree for this task.

| Concern | Owner and behavior |
|:--|:--|
| Material facts | Engine `asset.inspect` loads the registered cloud decoder, reads the verified material closure, resolves instance overrides, and returns at most 256 parameter rows with a truncation flag. The selected asset's adopted publication accompanies those rows. |
| Labels and groups | Optional `CloudParameter.label` and `.group` belong to the authored Pack. View displays them and retains the parameter identifier as a tooltip. Missing groups use Parameters. |
| Detail presentation | The existing fallback asset page displays collapsible groups, search, values, override indicators and texture references. It creates no cloud effect renderer. Numeric formatting changes presentation only. |
| Texture navigation | Shared `AssetReferenceField` and `observeAssetThumbnails` retain navigation and cached PNG ownership. Project, exact target, selected material, Catalog and texture publication changes revoke reads and actions. |
| Volume inspection | The existing exact-target `preview.texture.get/set` supports atlas, flat slice and volume surface projections for 3D textures. Other dimensions reject those projections. Engine performs all sampling on the original GPU texture. |
| Default display | RGB is enabled and Alpha disabled initially, including thumbnails, so data textures with zero Alpha remain visible. Alpha inspection/compositing remains available from the existing channel control. Transparent thumbnail margins are preserved. |

Atlas columns are the next power of two above the square root of the selected
mip's depth. Rows round up, and unused cells remain background. A 128-slice
volume therefore unwraps into 16 by 8 tiles, matching the supplied UE reference.
The volume mode samples the three visible surfaces of an orthographic cube;
it is a texture inspection view, not density ray marching. Volume thumbnails use
that same GPU mode. Pan, zoom, channels, exposure and selected mip retain their
existing owners and semantics.

## Validation

| Evidence | Result |
|:--|:--|
| View TypeScript and architecture gates | Passed against the selected local Engine build. |
| View tests | 672 passed. |
| Engine focused tests | 15 passed for cloud authoring, cloud inspection, texture options and preview lifetime. An unrelated project-reference failure in the default test runner was bypassed using the same repository base TypeScript configuration in an external test config. |
| Project import tests | 11 passed; all four `.uasset` hashes match the recorded UE source hashes, and runtime/raw hashes match their manifest. |
| Real project browser | Passed: grouped material details, four ready thumbnails, three ordinary 2D texture viewers, volume atlas/slice 64/cube modes, and 480px layouts. Volume rendering completed at least 60 frames; its sampled screenshot region contained 8,399 distinct RGB colors. No page errors. |

Screenshots and the browser receipt are retained in the research workspace at
`vc/ue/ue-rev/evidence/cloud-asset-preview-2026-11-05/`. Complete Engine browser,
Dawn and CI matrices were not run; the browser result above is the real changed
asset workflow, not a claim about those broader gates.

This extends the native inspection and texture inspection contracts. It does
not turn a cloud material into an ordinary surface MaterialAsset or reproduce
UE's full material graph or platform compression.
