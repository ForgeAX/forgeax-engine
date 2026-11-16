# Volumetric Cloud Read-Only Inspection

View recognizes the Engine's `VolumetricCloudLayer` component and presents its
returned fields in cloud-specific Details sections. Custom cloud materials and
instances use the existing generic asset identity page. They do not acquire a
Material preview or an additional cloud renderer.

## Public Contract

The selected Engine checkout is the project's `vc-ue` source, initially audited
at `70444ad7db2bfb36416eade3038254f4e5d1670d`. The delivery receipt must retain the
actual Engine, View and Demo revisions and local changes used by its running
owner. A branch name or npm version alone does not establish that identity.

| Public fact or operation | View use |
| :-- | :-- |
| `engine.entity.inspect` component names, schema and values | Classify the cloud entity and show only returned fields |
| Native `assetReferences` resolved GUID, kind and status | Reuse asset browsing, identity navigation and GUID copying |
| `engine.assets.list` Catalog identities | Match the selected asset to the current project |
| `engine.asset.inspect` identity, source and publication | Populate custom cloud material and instance identity pages |
| `view.workspace.asset.open` | Reuse the existing `detailsOnly` path for kinds without a preview owner |
| `preview.texture.get/set` | Existing RGBA, real mip and volume-slice inspection; no texture-page change |

The public Engine App types remain the authority. View does not read World,
decode cooked cloud programs, parse project authoring code, resolve material
defaults, or infer adopted GPU values.

> [!IMPORTANT]
> The current Engine inspection contract does not return complete cloud material
> parameters or instance overrides. The identity page exposes that limitation.
> Identity inspection is not an effect preview or evidence of GPU sampling.

## Component Presentation

`VolumetricCloudLayer` shares the existing `sky` presentation classification.
The original component remains a single row in the component overview.
Selecting it clears search, selects All, expands its first section and scrolls
there. Other components remain in Details.

| Section | Returned fields | Presentation |
| :-- | :-- | :-- |
| Cloud Layer | `bottomMeters`, `thicknessMeters`, `entryLimitMeters`, `traceLimitMeters` | Metres; layer height means thickness |
| Cloud Material | `material` | Existing read-only native asset reference |
| Material Overrides (ForgeaX) | `extinctionOverridePerMeter`, `coverageBias`, `layoutWeight`, `maskWeight`, `profileWeight`, `bodyWeight`, `erosionWeight`, `useDetail` | Extinction in inverse metres; explicit inheritance labels |
| Motion (ForgeaX) | `windOffsetMeters` | Returned three-component displacement in metres, not wind speed |
| Rendering and Advanced (ForgeaX) | `enabled`, `viewSampleCountScale`, `stopTransmittance`, `skipEmpty`, `diagnosticMode`, `diagnosticPixelX`, `diagnosticPixelY` | Initially collapsed; sample scale and transmittance threshold are dimensionless |

An extinction or weight value of `-1`, coverage bias of `-2`, or detail variant
of `2` displays **Inherit material**. Its tooltip and copy action retain the
original value. No effective material value is calculated. Missing values remain
missing; additional returned fields remain inspectable in Advanced.

The current built public component schema contains 21 fields, including
`viewSampleCountScale` (schema default `1`) and `stopTransmittance` (schema
default `0.005`). These defaults were checked through the public
`componentDefinition(VolumetricCloudLayer)` export. View displays only returned
component values; missing values are never replaced by those defaults. Neither
new field is an inheritance sentinel or a metre-valued distance. A schema
default is not a live World value or evidence of GPU adoption. The earlier
19-field candidate receipts retain their original input identity.

Cloud entities never enter the Inspector's Pack authoring client, even when
Engine returns authoring provenance. Their Details has no Save, Generate,
Expose, or parameter-write action. Existing authoring behavior for other entity
types remains owned by its current plugin.

Inspector resource facts use read-only reference navigation. The thumbnail and
external-link button open the same resolved asset identity; a single Content
Browser reveal action uses the existing browse callback. Use Selection and
Clear are absent from these controls and their menu. Missing identities keep
navigation disabled. Other consumers retain the reference control's default
editing mode until they explicitly select the read-only presentation.

## Asset Identity Lifetime

The generic asset Details panel reads through its current project target and
generation. Its read lease includes project, target, World, browser generation,
Catalog epoch, asset GUID and kind. The existing workspace observation cancels
reads synchronously when those identities change. React cleanup is not the
admission boundary.

While a new identity is loading, a previous asset or generation's facts are not
rendered. A missing or mismatched returned GUID fails inspection. Disconnected
or retired targets cannot publish stale results. A header copy action uses the
accepted asset GUID and the existing platform clipboard service.

## Catalog Query Lifetime

Content Browser catalog reads share the existing workspace reader and synchronous
observation owner. Automatic and manual refresh pass a cancellation signal to
all three directory queries. Project ID/root, target ID/generation, session,
World and browser generation identify their binding; the client identity also
owns the request lifetime. A catalog epoch or revision published by the read
itself does not retire that read.

Local source/HTML facts, loading and failure state are projected only for their
accepted client and binding. A new binding cannot display the previous binding's
cached directory before its own pending read completes. Replaced clients and
unmounted panels retire active reads. Retired failures do not become current
command notices; a genuine failure on the current binding remains visible.
This does not globally filter error codes or change Engine target validation.

| Content Browser entry | Local lifetime and visible-fact boundary |
| :-- | :-- |
| Initial `tabs.get` | A client-lifetime signal wraps the existing reader; project changes do not cancel workspace status. Retiring this consumer does not close its borrowed transport or another reader's shared request |
| Automatic/manual directory refresh | One binding lease supplies every asset/source/HTML request signal; cached sources, HTML facts and loading are keyed by client and complete binding |
| File preview | The read captures its client, combines caller and binding signals and rejects retired results. A client/binding/selection key remounts local file-preview state before a replacement can display old content |
| Thumbnail batches | Binding and Catalog publication guards own requests; cached rows include client and binding in addition to target/publication identity |
| Selection and reference inspection | `asset.inspect` remains a protocol command. Its selection lease retires consumer work without query sharing, replay, or an assumption that an accepted command was undone |
| Resource/Pack reveal | Inventory reads and intent signals retire synchronously. Cancel, navigation and new intents dispose the old signal; each later tab/panel continuation rechecks the live reader |

Open/select/ACK commands retain their existing protocol. A retired continuation
is stopped; the View does not assume a dispatched command failed to apply and
does not replay it. Controlled lifecycle checks include current-scope failures
as positive controls rather than hiding an error code globally.
Direct asset/file selection handoffs retire the previous inspection and file
read synchronously without retiring the reveal intent performing that handoff.

## Verification

| Check | Evidence scope |
| :-- | :-- |
| `node --test test/volumetric-cloud-inspection.test.mjs` | Classification, all 21 fields, inheritance, missing values, native references and both inspect-only cloud kinds |
| `node --test test/readonly-asset-reference.test.mjs` | Read-only reference structure, existing default editing mode, Inspector reveal binding and unresolved identities |
| `node scripts/verify-volumetric-cloud-inspection-ui.mjs` | Actual Inspector UI with controlled public client facts; English/Chinese, search, component navigation, raw copying, asset actions, no authoring calls, light/dark at 280/360/520 px |
| `node scripts/verify-asset-details-lifetime-ui.mjs` | Actual generic Details panel; exact target, hidden previous facts, synchronous cancellation, same-GUID generation replacement and late-response rejection |
| `node scripts/verify-content-browser-query-lifetime.mjs` | Actual Content Browser with controlled public transport; auto/manual cancellation, cached-fact isolation, client/unmount retirement and catalog readback |
| `pnpm check:packages`, `pnpm check:architecture`, `pnpm test`, `pnpm build` | Complete local static, source-boundary, unit and artifact checks |
| Harness `--verify`, KB lint, `git diff --check` | Repository bootstrap requirements |
| Paired Engine View integration, all four browser shards | Required before delivery; separate from the controlled UI fixtures |

The UI probes write PNGs and JSON receipts under `FORGEAX_EVIDENCE_DIR` and use
an installed browser selected by `FORGEAX_BROWSER_EXECUTABLE`. Their controlled
facts are explicitly not Engine rendering evidence.
The catalog query fixture is also required by the maintained
`verify-resource-preview-lifecycle.mjs` roster before its existing Engine checks.

The B acceptance receipt must separately prove the real `vc-ue5` Scene, all
three cloud materials and three instances, four textures including volume slices
0/64/127, Play/Stop/reload target isolation, unchanged authoring bytes and the
existing cloud GPU regression. Native Codex presentation and ordinary browser
evidence retain their distinct scopes. These checks do not automatically grant
human B approval.
