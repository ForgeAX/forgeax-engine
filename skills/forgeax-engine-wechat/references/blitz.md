# Blitz implementation and diagnostics

The persistent implementation is owned by
[`packages/ui-blitz`](../../../packages/ui-blitz/README.md), using the Engine's
`third_party/blitz` gitlink. The maintained source supplies open ShadowRoot with
Stylo scoping/inheritance, retained fragments and input values before layout. Source, lockfile, generated native glue
and WASM are one publication. Read the package contract before claiming a feature.

| Symptom or task | Route |
|:--|:--|
| Browser/native geometry, font or focus mismatch | [Control comparison](#compare-browser-and-native-controls) |
| Dialog breaks only after scrolling | [Fixed dialogs and scroll ownership](#fixed-dialogs-after-excess-scrolling) |
| Correct isolated UI, wrong game composition | [Production GPU gallery](#composed-gallery-through-the-production-gpu-compositor) and [settings/inventory](#settings-and-inventory-through-the-same-gpu-compositor) |
| Native form behavior differs | [Confirmed failure routes](#confirmed-failure-routes) and [actual controls](#actual-settings-controls) |
| UI module, startup or generated WASM fails | [Ordinary import](#ordinary-ui-import-and-startup) and [cold build](#cold-build-and-repair) |
| Missing text, symbols, images or list markers | [Published resources](#published-fonts-and-images) and [builtin markers](#builtin-markers-and-control-audit) |
| Active controls are slow | [Current WASM](#measure-the-current-wasm) and [performance diagnosis](performance.md) |

## Persistent DOM in the official simulator

Build `ui-blitz`, `platform-wechat` and the Engine facade from the same checkout.
Run the package's Rust, real-WASM and browser differential tests first. The
diagnostic consumes public `@forgeax/engine` subpaths; no handwritten JS/WASM
imports or global WebAssembly interception is used.

```sh
node scripts/build_ui_dom_fixture.mjs \
  --engine-root /absolute/forgeax-engine \
  --out /absolute/new-ui-diagnostic \
  --appid wx0000000000000000 \
  --font /absolute/licensed/DejaVuSans.ttf \
  --font-license /absolute/licensed/LICENSE
```

The output must be new. The builder copies the explicitly supplied font license
and includes it in the artifact inventory. Do not use a system-font path as the normal game
resource authority. The builder records source provenance and every payload
digest; a dirty-fork receipt is not release acceptance.

Use [Simulator](simulator.md) to import/open the output. Query exactly
`FORGEAX_UI_DOM_READY`, require all boolean checks to be true, positive
`buttonGlyphs`/`inputGlyphs` counts, and tap the returned button
rectangle using `automation_game_action`. Query `FORGEAX_UI_DOM_ACTION`: the Grid
tracks must change, `sameNode` must remain true, and submissions must increment
once per tap. View `simulator_screenshot` to check actual text and geometry.

This path uses a native 2D canvas to isolate the UI owner. It does not establish
Renderer composition, native keyboard, startup UI, a normal DevKit
target, full game-3d or device performance. Keep these missing gates explicit.

### Compare browser and native controls

Retain the same authored HTML/CSS, viewport/DPR, control values and input gesture.
Record element rectangles alongside paired screenshots: form submission and focus
tests can pass while intrinsic control widths distort Grid columns or inline
control baselines accumulate into a taller dialog. Repair the control/layout owner
instead of adding a fixture-only width or shrinking the authored dialog.

Match the actual font bytes and selected family before attributing a geometry
difference to layout. Registering a font does not make Chromium's generic families
select it. A task-private Fontconfig mapping can isolate this variable; label that
comparison separately from the production generic-font result. Do not modify the
machine's global font configuration. Small system-font or antialiasing differences
are distinct from wrong columns, clipped text or misplaced controls.

A 15 CSS-pixel horizontal difference that scales with a transformed scrollport can
come from headed Linux Chromium's classic scrollbar gutter. The portable scroller
currently reserves none. The scrolling-control and inventory differential tests use CDP's
matching zero-gutter display setting and restore it afterward, while retaining
their original CSS, scrolling, focus and geometry assertions. See the
[UI verification contract](../../../packages/ui-blitz/README.md#verification).
Do not widen coordinate tolerances to absorb this environment difference.

Use the same real pointer modality on both sides. In the mixed-form fixture,
Chromium mouse input and Blitz touch input produced different readonly focus-ring
states; matching native touch gestures made both controls focus-visible. Preserve
correct native focus semantics instead of compensating for unlike test inputs.

Native browser validation feedback animates independently of the authored UI.
Chromium 155's popup initially faded and scaled into view; its sampled background
became opaque after approximately half a second. Keep immediate interaction
assertions, but let that popup settle before taking the visual reference. In the
qualified fixture, waiting alone could leave compositor painting deferred: an
initial `Page.captureScreenshot` followed by 600 ms produced the stable popup.
Wait for dismissal before capturing a recovered submission as well. If
transparency or placement is disputed, retain a
short timed sequence with capture start/end intervals before changing the painter.
This observation does not waive stable layout or color differences, and is not a
blanket delay for every screenshot.

### Fixed dialogs after excess scrolling

A correctly sized dialog can still fail after scrolling reaches its last control.
Keep its authored CSS and reproduce with an actual wheel or native touch drag,
then compare the panel, its scrolled contents, and the final button's pixels,
client rectangle and hit result. A programmatic scroll offset alone misses input
scroll chaining. Check safe-area and live menu-capsule bounds separately.

The short-window settings failure had two owners: the authored panel exceeded the
viewport, and native fixed compensation assumed that the root element had no
containing block. Its parent is actually the Document. The maintained native
predicate now distinguishes viewport-fixed boxes from boxes contained by a
transformed ancestor; paint, geometry and hits use it, and `elementFromPoint`
converts client coordinates to the page-coordinate traversal. Keep the transformed
ancestor case when changing this code. The
[regression](../../../packages/ui-blitz/src/__tests__/settings-responsive.browser.test.ts)
uses the same 1000-pixel wheel that originally displaced the panel; native tests
also check exact pixels and hits at DPR 1 and 3.

The official simulator subsequently passed two real touch drags, the trailing
checkbox and Done, with the panel retaining its safe rectangle. Background
scrolling is a distinct behavior: Blitz currently transfers the same event's
unused delta through `ScrollOverflow::Chain`, while Chromium may retain that event
in its starting scrollport. Do not describe the fixed-dialog repair as whole-page
pixel equality or replace real input with synthetic clicks to hide a hit failure.

### Composed gallery through the production GPU compositor

`build_ui_gpu_benchmark.mjs --scene gallery` runs the same retained gallery as
`packages/ui-blitz/src/__tests__/composed-images.browser.test.ts`. Its shared
HTML and controller exercise Grid/Flex, six image fits, content-box padding,
scroll clipping, an inert page behind a viewport modal, and retained image nodes
through window/DPR changes. It uses the existing `createUiCompositor` sparse-strip
raster and RHI canvas surface, with real Host input and GPU completion receipts.

Build a browser reference and a native package from the same selected Engine:

```sh
node scripts/build_ui_gpu_benchmark.mjs \
  --engine-root /absolute/forgeax-engine --out /absolute/new-gallery-browser \
  --backend wgpu-webgl2 --scene gallery \
  --font /absolute/forgeax-engine/third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf \
  --font-license /absolute/forgeax-engine/third_party/blitz/packages/blitz-dom/tests/fonts/LICENSE
node scripts/build_ui_gpu_benchmark.mjs \
  --engine-root /absolute/forgeax-engine --out /absolute/new-gallery-wechat \
  --backend wgpu-webgl2 --scene gallery --host wechat --appid wx0000000000000000 \
  --reference /absolute/new-gallery-browser
```

Both output directories must be new; use the already supplied private AppID.
`inputs.json` binds the scene/controller, image, font, native UI provenance,
bundled module hashes and emitted files. The native package retains the reference
WASM/font bytes. The gallery uses actual Host display facts, including pixel ratio;
the benchmark's fixed 2532×1170 extent does not apply to it.

After opening through the official simulator, require `FORGEAX_UI_GALLERY_READY`
and query `globalThis.__forgeaxUiGallery.snapshot()` in the game module. Require
`phase: "ready"`, backend `wgpu-webgl2`, no errors, positive `completed`, a completed
`receipt`, and `sameImages: true`. Use the returned `points.open`, `points.close`
and `points.scroll` for actual native taps/swipes. Verify scrolling, opening the
modal over a scrolled panel, rotating/resizing with the modal open, closing it,
and reaching the bottom. Re-read geometry after each display change; do not reuse
stale coordinates. `scrollTo(top)` is available for exact CSSOM comparison with
the browser regression, but does not qualify native swipes.

The gallery applies the current Host `safeArea` to its page and overlay; controls
stay beside the title instead of under the native menu capsule. The safe area
excludes display cutouts but does not exclude the capsule. Check the complete
control rectangle against `wx.getMenuButtonBoundingClientRect()` before tapping;
correct CSS hit testing alone does not establish native reachability. Keep an
occluded-control failure and repair the authored layout, then rebuild and use
native input again. A synthetic DOM click would skip that failure.

The official simulator qualified native swipe, Preview, modal retention through
landscape-to-portrait rotation, native Close, landscape restoration and end-of-list
scrolling with the composed-image payload. The corresponding browser comparison
covers eight Grid/Flex/image/modal states through DPR changes. These are separate
observations of the same source and native payload; neither is a phone or FPS
measurement.

Keep screenshots for every state, including the visible image fragments outside
the modal and beneath its translucent backdrop. Require `pageInert` to follow
`modalOpen`, stable image identity, and clamped scroll after growing the viewport.
`dispose()` drains GPU work and detaches the owned input/frame/platform resources.
This fixture qualifies the production UI raster/compositor seam; it does not create
an App, World or full game. Offline build checks and browser pixels do not establish
official-simulator or phone acceptance.

### Settings and inventory through the same GPU compositor

Use `build_ui_gpu_benchmark.mjs --scene settings` with the same browser/native
build sequence above. It reuses `controls-workflow-fixture.ts`, its inventory
controller, and the actual capability-lab settings asset/controller without
changing their HTML/CSS. Gallery and settings share one interactive GPU loop,
Host input bridge, resize handling, completion receipts and cleanup. The legacy
`build_ui_dom_fixture.mjs --scene settings` remains a separate CPU 2D diagnostic.

For the matching published font, supply
`packages/devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2`
and its package `LICENSE`. The existing authored fallback travels through the
same data URL as the browser differential. `--reference` rejects changed scene,
controller, GPU runner or native payload bytes; it preserves the supplied font.

Require `FORGEAX_UI_SETTINGS_READY` and inspect
`globalThis.__forgeaxUiSettings.snapshot()`. As for the gallery, require the
production compositor, `wgpu-webgl2`, positive completed work, a completed receipt
and no errors. `points` exposes Add, settings Open/Close, quantities, Apply and
settings controls. `geometry`, `values`, `valid`, `ids`, `submittedValues`,
`active`, `settings`, `pageInert` and `modalOpen` expose the retained author state.
Use real Host taps, scrolling and keyboard events; `scrollTo(top)` only supports
exact CSSOM comparisons. Browser keys forward to the UI owner, including number
stepping, F2, Tab and Escape; the WeChat bridge retains its native keyboard owner.

Capture insertion, invalid quantity feedback, repeated modal opening, changed
settings and close/recovery using the returned current coordinates. The authored
inventory has a fixed desktop width: keep that same layout and record actual
viewport/safe-area clipping rather than rewriting CSS for a diagnostic. This is an
owner fixture using production GPU UI composition, not an ordinary App/World game
or an FPS measurement. Simulator/device acceptance still requires actual target
operation and screenshots. `dispose()` drains and releases the shared owner.

### Confirmed failure routes

| Symptom | Owning repair / regression |
|:--|:--|
| Control rectangles exist but text is absent | Bind prepared fonts to generic families including `system-ui`; qualify intrinsic height for number controls. Font registration alone is insufficient. |
| Readable text but missing disclosure/list glyphs | Ensure `BaseDocument::new` registers builtin Bullet after selecting either the supplied or default font context. Changing authored text or adding consumer marker CSS does not repair this native resource gap. |
| Checkbox/radio pixels ignore `.checked` or peer radios stay checked | Inspect native checkedness and dirty-default state through the real input port. The DOM facade must call the native owner; an arbitrary JS property can silently become an expando. |
| Ordinary project fails before `mountUi` with `sourcePath must be an author-relative file path` | The UI importer must publish the author filename relative to its companion directory. `ImportContext.source` can be an absolute physical path; keep that path only for import diagnostics and dependencies. Preserve the loader's relative-path check. |
| UI authoring dependency fails a native bundle with Node `module/createRequire` | The UI owner imports css-tree's published portable ESM distribution for its parser/lexer. Use the same runtime-safe entry for resource projection; do not add Node shims to the Mini Game or remove validation. |
| Explicit font `readFile` fails with `permission denied` | Check the producer's code-package filename. A settings diagnostic using `ui/font.woff2` failed on the qualified simulator. The maintained builder retains the existing allowed `ui/font.ttf` route and the exact supplied font bytes; Blitz detects the font format from bytes. Keep the failed package and verify the regenerated output. |
| Shadow descendants lose inherited color/font | Stylo's `inheritance_parent` must follow the flattened tree; selector ancestry must still stop at the shadow boundary. |
| Native control pixels/value change but the authored settings state stays unchanged | Inspect the real controller for global `document` or browser `instanceof` checks. Use the root's `ownerDocument` and standard node/tag identity, preserving the same controller in browser and native tests; do not install global DOM shims. |
| Modal background controls still take input or regain a held gesture after closing | Verify native `inert` attribute reflection, composed shadow ancestry, focus retirement and contact cancellation. An expando property does not isolate the underlying document. |
| A scrolling panel paints in place but its own CSSOM rectangle moves | Compare the panel and its descendant separately. Subtract ancestor scroll offsets from client rectangles; a scrollport's own offset moves its contents, not its border box. The ordinary guide regression caught an exact 16.59375-pixel error that must not be classified as font tolerance. |
| Initial Tab never enters the UI, or invalid numbers are rejected without an explanation | Use the complete `game-guide-keyboard.browser.test.ts` path with the ordinary controller. Verify initial keyboard entry, canceled defaults, `validationMessage`, native shaped feedback, focus/scroll, and DPR/resize together. Then test the same form through the actual native keyboard; a browser differential does not prove simulator keyboard/popup coexistence. |
| A button receives keyboard focus but has no visible indicator | Check the native UA outline and actual painted pixels, not only `activeElement`. The maintained native UA uses `:focus` for all controls, including pointer/touch focus. Author `:focus-visible` reads the existing native `FOCUSRING` state under Document-owned input modality; use the unchanged HUD differential for pointer, keyboard and script transfer. `:focus-within` is still rejected before mutation. Author styles can override the outline. After a select popup closes, compare against its focused baseline rather than requiring all surrounding pixels to be transparent. |
| Submitting an invalid number reopens the keyboard over its validation message | DOM focus alone does not request native editing. Open the native keyboard for an accepted input or associated-label tap, including taps on an already-focused field. Native Complete commits the pending change and retires the edit lease without blurring the document; Confirm separately follows the ordinary form default. In the qualified simulator, tapping its native Done emitted Complete only. Observe actual events before claiming Confirm or physical IME coverage. |
| Old native editing callbacks or port replies affect a remounted guide | Reproduce using the original controller and real WASM (`keyboard-wasm.test.ts`). Cancel, Complete, unmount and core disposal must retire the editor; borrowed MessagePorts stay usable and remove exactly their own listeners. Drain late port replies through the same FIFO before checking absence of changes. Listener/node baselines qualify those owners, not WASM capacity or GPU memory. |
| The first select tap is followed by paint/query `borrow_fail` | Retain the earliest exception before inspecting the poisoned document. A label-wrapped select once recursed through label activation because the TS activation candidates omitted select/textarea; stack exhaustion then left a WASM borrow unreleased. Reproduce direct control clicks and label-caption forwarding before changing Rust. |
| Tapping visible button returns an internal-node failure | Convert the core hit to its nearest DOM element before exposing a facade. Anonymous formatting boxes are derived layout state. |
| `mountUi` fails with missing AbortController | Install missing standards through `installWechatStandards` before starting UI; preserve existing native identities. |
| Subpackage source or WASM stays stale after transfer | Match file digests, clear only `cleanCompileCache`, refresh, then require markers from the new source. A refresh acknowledgment is not completion. |

The official simulator qualified ordinary `mountUi`, open-root isolation and
inheritance, numeric required/step validity, glyph pixels, a real tap producing
one cancellable submit, and dynamic 1:1 to 3:1 Grid with retained node identity.
Browser differential tests cover the same style/hit/event paths. These results
do not qualify keyboard editing, complete game UI or phone execution.

Use the same builder with `--scene guide` for the full authored `game-3d` guide,
shared localization/control-mode controller and generated numeric controls. It
uses a landscape native canvas and explicit fixture replies over the same realm's
standard MessageChannel. The official simulator qualified parameter submission,
failure-state recovery and the [native keyboard API round trip](simulator.md#native-keyboard-round-trip).
Screenshots must be labeled as simulator output or browser reference. This UI
diagnostic still does not establish Renderer composition or ordinary-project
acceptance; those use the normal DevKit target.

The current clean native build also passed the complete guide in that independent
simulator project: a real Generate tap delivered the numeric values once, the
fixture's intentional failure reply restored the retry controls, and a real
French tap updated the authored guide. This path has number and localization
controls; checkbox/radio interaction evidence below comes from real WASM and
Chromium, not from that guide screenshot.

### Actual settings controls

Use `build_ui_dom_fixture.mjs --scene settings` with the same required engine,
output, AppID, font and license arguments. The fixture imports the complete
capability-lab settings UiAsset and its real `mountSettings` controller. It uses
`createWechatInputBackend` with `ui.input`; no synthetic controller, browser-global
shim or reduced CSS is involved. Its portrait viewport retains the authored modal.
The builder records controller/UiAsset digests in `consumerSources` alongside the
bundle and matched native publication. For the same font as the browser regression,
supply the DevKit-published `noto-sans-sc-latin-wght-normal.woff2` and its license.
The copied filename remains `ui/font.ttf`: the [code-package whitelist](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/code-package.html)
includes `ttf` and `bin`, not `woff2`. Payload identity and decoding still use the
original WOFF2 bytes; changing a source font's name inside an emitted package by
hand would lose the producer's reproducibility.

Check `FORGEAX_UI_FIXTURE_BUILD` against `diagnostic.json.buildIdentity`, then wait
for `FORGEAX_SETTINGS_CONTROLS_READY`. `programSha256` identifies the bundled
program before the producer's identity prefix; `artifacts` still records complete
emitted file hashes. A refresh acknowledgement does not establish source freshness.
The qualified simulator realm can read
the current state through `automation_evaluate --fn-source`:

```js
function () {
  return GameGlobal.__gameContextWindow?.forgeaxSettingsControlsDiagnostic?.snapshot() ?? null;
}
```

The snapshot contains control values, controller state, rectangles, touch targets,
event traces, errors and paint count. Each real touch end also emits it as
`FORGEAX_SETTINGS_CONTROLS_TOUCH`; value events emit
`FORGEAX_SETTINGS_CONTROLS_ACTION`. Query these exact markers to avoid console
truncation. Keep a fresh snapshot with each official screenshot.
The helper's `build()` returns the live identity. If native queries fail, use
`errors()` first: it reads retained recursive name/message/code/operation/cause
records without touching the native document. `FORGEAX_SETTINGS_CONTROLS_ROOT_FAILURE`
prints the concise earliest root cause separately from the full error record.

Start with music `70`, antialias `fxaa` and Bloom checked. Tap a select's `point`,
capture its popup, then use `popup.rows` for hit-derived option centers. Tap
`points.range25`/`range75`, drag `range0` to `range100`, and toggle Bloom and mute.
Require controller state to match the native values, ordered `input` then `change`
for committed changes, and `focusedText: null` for these non-text controls. The
Done target must close the actual modal. Optional `cancelNext(setting, eventName)`
and `setDisabled(setting, boolean)` prepare standard cancellation/disabled checks
before real simulator input; they do not implement defaults. Reopen with `open()`.

The shared Chromium/real-WASM regression also covers Tab through the actual select,
focus restoration, composed `inert` isolation and retirement of a held contact.
Those tests and a successful fixture build do not establish an official simulator
run. Record its actual input, screenshots and artifact identity separately. This
fixture still declares `engineGameAcceptance: false`; ordinary 3D composition and
Renderer completion retain their own gate.
The current publication's actual native sequence and byte identities are recorded
in [Sources](sources.md#settings-controls-on-the-current-native-publication).

### Ordinary UI import and startup

The guide fixture supplies an already assembled `UiAsset`. It cannot detect an
ordinary import failure. The
[development publication regression](../../../packages/vite-plugin-pack/src/__tests__/ui-dev-artifact.integration.test.ts)
writes a real source pair, localization JSON and image companion into an absolute
temporary directory, then uses the ordinary importer, HTTP publication and
`AssetRegistry.load` decoder. It reproduced the rejected absolute `sourcePath`
before the importer repair and now restores the authored HTML/CSS, localization
and verified companion bytes. The
[UI importer regression](../../../packages/ui/src/importer/__tests__/resource-closure.test.ts)
also exercises Linux and Windows source separators while retaining physical
dependency identities.

Do not hand-edit a generated Pack to repair this failure. Rebuild the UI owner and
restart its producer; changed CookProduct and transport digests select the new
publication without weakening path admission. A successful UI load still requires
the ordinary game to finish startup before its loading overlay releases input.
Retain the next structured cause if another plugin fails and cleanup retires UI.

### Cold build and repair

`ui-blitz` uses the same cache/release/source ladder as the other WASM owners.
`pnpm -F @forgeax/engine-ui-blitz fetch-wasm` verifies a content-keyed release;
`build:wasm` rebuilds from the exact source and lockfile. `prebuild` rejects missing,
stale or corrupt glue/WASM. SDK source rebuilds work without `.git`; do not create
fake Git metadata or copy unmatched generated files to bypass validation.
See the [CI operating guide](../../../scripts/ci/README.md#cross-platform-host-build-inputs).

An isolated source snapshot may reuse an installed checkout's `node_modules`
through symlinks. Invoke installed tools directly in that snapshot; `pnpm exec`
can run `verifyDepsBeforeRun` first and attempt a workspace install. A measured
failure rewrote shared package dependency links relative to the snapshot before
rejecting its symlinked hoist directory, breaking the original checkout's links.

```bash
node /absolute/installed-engine/node_modules/vitest/vitest.mjs run \
  --config /absolute/snapshot/packages/ui-blitz/vitest.browser.config.ts \
  src/__tests__/trailing-scroll-margin.browser.test.ts
```

Run that command from the snapshot's `packages/ui-blitz` directory. Native builds
likewise use `node scripts/build-wasm.mjs` with their explicit private Cargo target.
If an automatic install has already failed, retain its log and restore only
identified incorrect links whose original installed targets can be verified.
Inspect every shared dependency target containing the snapshot path, including
links that still resolve: an existing isolated source directory can lack the
original owner's build output. Restore the same workspace owner or unchanged
package-store artifact, record each old and restored target, and confirm no
shared dependency still routes through the snapshot instead of reinstalling.

### Measure the current WASM

```sh
node scripts/measure_wasm.mjs /absolute/forgeax-engine/packages/ui-blitz/pkg/ui_blitz_bg.wasm
```

The native publication from Engine SDK commit `a78d9bd45149`, at maintained
Blitz revision `0b2252f8447b74ce0051f65e81db66c21e6051f6`, measured on
2026-10-11 (Asia/Beijing). Its WASM SHA-256 is
`90212fb259ff9c1abec4966d9968617dacfed0d828d7d35aca678113529f2207`.

| Representation | Bytes | Decimal MB |
|:--|--:|--:|
| Raw WASM | 16,455,393 | 16.455 |
| gzip, level 9 | 3,602,462 | 3.602 |
| Brotli, quality 11 | 2,226,908 | 2.227 |

Re-measure after source/features change. This excludes JS glue, fonts, images,
renderer/physics WASM and game assets. Generic transport compression does not
establish the official tool's final code-package size or runtime memory use.
Different checkout paths produced different native bytes at the same source
digest; follow [native publication identity](verification.md#match-the-delivered-native-publication)
before reusing simulator evidence.

### Published fonts and images

The UI core discovers stylesheet, font and image requests through its real resource
graph. The Host supplies the owning package reader; errors retain the requested URL
and native cause, and disposal aborts reads before stale bytes can reach the core.
The formal Noto Sans SC Variable package is exact-pinned by DevKit and carries its
OFL license. Its 101 WOFF2 subsets cover the tested French and Chinese text without
depending on a developer machine's installed fonts. PNG, JPEG and WebP decoders are
explicit maintained features; enabling the image crate alone did not enable PNG.

Browser references must declare UTF-8 in HTTP or document metadata and wait for
`document.fonts.ready`. A misdecoded reference once displayed corrupt French and
Chinese while Blitz rendered correctly; that image was a fixture failure, not a
font difference. Match the authored strings, font bytes and viewport before judging
layout or glyphs. Browser/WASM resource tests do not qualify native keyboard input.

For missing authored characters, inspect the selected glyph and the supplied
font's coverage before changing text. An ASCII-only fixture has no `×`, `±`,
`U+00E9` or `€`; glyph 0 may have an empty outline. Loaded covering fonts must enter
the existing Fontique script-fallback lists through both bootstrap and resource
registration. Keep explicit CSS family priority and deduplicate registrations;
do not replace the authored symbol to hide a missing fallback.

Separate coverage from typography parity. Chromium may use an installed DejaVu
fallback while Blitz uses published Noto, even with the same primary family.
Use an explicit published family on both sides and retain the actual selected
font, bytes, glyph IDs, size, weight, variation axes and baseline. A variable
font's internal name can contain “Thin” while the selected weight is 400.
If layout matches but pixels differ, compare glyph bounds and coverage; do not
claim pixel equality or blame antialiasing without checking the raster stage.
The [font fallback regression](../../../packages/ui-blitz/src/__tests__/font-fallback.browser.test.ts)
keeps the implicit-coverage and explicit-same-font cases separate.

In a same-font comparison fixture, setting only the host's family does not
override form controls' UA `system-ui` fonts. Apply the named fixture family to
both hosts and their controls, retain authored sizes and line heights, and verify
the actually selected font. Match the browser's scrollbar mode for exact layout
comparisons too: a visible 15-pixel gutter changes Grid widths and focus scrolling.
Restore fixture overrides afterward; ordinary projects retain their authored
styles and normal system-font differences.

For validation-popup opacity or placement, follow the compositor and animation
checks in [Compare browser and native controls](#compare-browser-and-native-controls).

When a thin focus ring seems absent in a long comparison sheet, inspect a
nearest-neighbour crop of the original full RGBA outputs. Verify sheet-to-source
coordinates and hashes before changing the painter: thumbnail resampling can
hide a one-pixel outline that exists in both CPU and GPU output.

For simulator journeys, derive native taps from current source-mapped control
rectangles and confirm the hit path before sending input. Assert the intended
effect, such as the translated title or `aria-expanded`, as well as unchanged
game state. A retained language journey once clicked obsolete coordinates and
passed only its game-state checks; all four screenshots were still English.
Preserve that failed evidence and repeat through the actual control owner.

### Builtin markers and control audit

Keep generated markers separate from authored font coverage. The native
[list owner](../../../third_party/blitz/packages/blitz-dom/src/layout/list.rs)
selects Bullet for disc, circle, square and disclosure glyphs; the
[inline constructor](../../../third_party/blitz/packages/blitz-dom/src/layout/construct.rs)
does the same for inside markers. Closed/open disclosures are U+25B8 `▸` and
U+25BE `▾`. The bundled font contains U+0020, U+2022, U+25AA, U+25B8, U+25BE,
U+25C2 and U+25E6. Register it for every document, including prepared host font
contexts. Ordered marker text and authored arrows, French or Chinese still use
the ordinary published font/fallback path.

The [real-WASM resource regression](../../../packages/ui-blitz/src/__tests__/resources.unit.test.ts)
compares implicit builtin registration against an explicit `@font-face` using
the same Bullet bytes. It covers closed/open details and inside/outside disc,
circle, square and ordered lists alongside native controls. The test was red
before unconditional registration. Shared startup HTML/CSS and lifecycle
captures also exercise touch expansion through `ui.input`, without changing
the consumer markup.

Checkbox/radio glyphs come from the native
[vector painter](../../../third_party/blitz/packages/blitz-paint/src/render/form_controls.rs),
not a symbol font. Static checked/unchecked captures qualify appearance only.
The [browser differential](../../../packages/ui-blitz/src/__tests__/dom.browser.test.ts)
also compares real clicks, labels, Space, radio arrows, current/default checkedness,
input/change ordering and canceled preactivation. State stays in the native
document; radio exclusion follows the same DOM tree, form and nonempty name.
The shared [checkable sequence](../../../packages/ui-blitz/src/__tests__/checkable-fixture.ts)
asserts `.checked` versus reflected `.defaultChecked`, dirty-default behavior,
unnamed radios, cross-form isolation, cancellation rollback and `input` before
`change`. A checkable without an authored value uses the native default `"on"`.
An arbitrary JavaScript property assignment on an unimplemented facade field
can merely create an expando: assert actual native state and pixels. `checked`
is now a native-backed accessor, with explicit errors outside checkbox/radio.

Local WASM captures establish the tested glyphs and control paths, not official
simulator output, ordinary Renderer completion or device behavior. Retain failed
captures; label each capture's backend and verify the target's final WASM identity
before extending acceptance to the normal WeChat package.

## Original isolated kernel experiment

> [!IMPORTANT]
> This fixture proves parsing, Grid layout, CPU painting, native WASM loading and
> two pixel samples. It reparses the document on every call. It is not the Engine
> UI implementation, a persistent DOM facade, or acceptance
> of ShadowRoot, forms, game-3d, performance, RHI composition or phones.

## Inputs and build

Use a clean checkout of `DioxusLabs/blitz` at the revision required by
`build_blitz_probe.py`, Rust 1.99.0 with `wasm32-unknown-unknown`, wasm-bindgen
0.2.129, Node, and an Engine source checkout with its dependencies installed.
The fixture carries its complete Cargo.lock. Its path dependency is the verified
Blitz checkout; the locked Taffy and Parley git dependencies still require network
access or a populated Cargo cache. The script never installs or updates toolchains.

```bash
python3 scripts/build_blitz_probe.py \
  --blitz-source /absolute/clean-blitz \
  --engine-root /absolute/forgeax-engine \
  --out /absolute/new-probe \
  --appid wx0000000000000000
```

Replace the example AppID with the user's supplied local value. Non-default tool
paths use `--cargo`, `--wasm-bindgen` and `--node`. `--target-dir` reuses a Cargo
build cache. The script runs the native pixel test, builds the WASM kernel with
`--locked`, derives experimental import/finalizer access, bundles the game module,
and records the actual generated identities. Output must be a new directory.
Transfer `project/` to the DevTools machine and follow [Simulator](simulator.md).

The required console marker is `FORGEAX_BLITZ_KERNEL` with `passed: true`, left
pixel `[255,0,0,255]`, right pixel `[0,0,255,255]`, and 40,000 RGBA bytes. View the
actual screenshot; it should show adjacent red/blue blocks and the explicit
"Not Engine UI acceptance" label. Use the actual game module for timing and
globals, because official AI evaluation may use another execution context.

## Measured baseline, 2026-10-10

| Fact | Observation |
|:--|:--|
| Headless dependencies | Blitz 0.3.0-beta.2; Stylo 0.22.0; AnyRender 0.14.0; CPU adapter 0.18.0; Vello CPU 0.3.0 |
| Execution | Default features disabled; sequential style; no second JS engine |
| Kernel size | 15,004,074 WASM bytes in the original qualified build |
| DevTools | Nightly 2.02.2610092, base library 3.17.3, macOS ARM64 |
| Real simulator | Grid pixels passed; load 845-869 ms, one parse/layout/paint 32.5-33.3 ms |
| Node diagnostic | Same generated glue/WASM parsed and painted; one run 47.77 ms |
| Game-module globals | WXWebAssembly available; WebAssembly, HTMLCanvasElement and WebGL2RenderingContext constructors absent |
| Original upstream gaps | ShadowRoot, state/style invalidation and text-shadow painting were subsequently implemented and regression-tested in the maintained fork |

These timings are small-fixture observations, not throughput budgets. The fixture
has no text by default. Supplying a font exercises the render function's font
parameter but does not establish glyph coverage, shaping, input or IME behavior.

The official [code-package contract](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/code-package.html)
read on 2026-10-10 allows 30 M total, 4 M main package, and no individual subpackage
size limit. WASM is an allowed file type. Recheck current conditions for the actual
mode. Include Engine, shaders, physics, UI, fonts, assets and duplicated files in
the final package budget; a 15 MB UI kernel alone does not prove a game fits.
