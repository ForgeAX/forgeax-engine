# Compare actual Canvas pixels with simulator presentation

Use this when an official simulator image has clipped text, a suspicious border,
or another artifact whose ownership is unclear. Read the actual display Canvas
and pair it with the official image before changing Engine drawing code.

```bash
python3 skills/forgeax-engine-wechat/scripts/sample_canvas.py \
  --config /private/wechat-machine.json --project /absolute/already-open/game \
  --out /private/run/canvas-sample \
  --region 0 0 256 12 --positive-selector '.languages button'
```

The project must already be open. The script performs one official
`automation_evaluate` followed by one `simulator_screenshot`; it does not reload,
resize, rotate, change game content or send input. Private config, project/AppID
and evidence paths remain outside the repository. The ordinary game-3d language
selector is only the default: select a known visible control for another project.

`region` uses top-left **physical Canvas pixels**. Its area is bounded to 3072
pixels; the independent control adds 32×32 pixels, for at most 4096 pixels / 16 KiB
RGBA. The reader gets the control rectangle from the current Engine `ui()`
inspection and scales its center by the actual native window DPR. The 256-element
inspection bound counts unmatched nodes and open-shadow descendants, not only
selector matches. A truncated observation remains a failure even if it contains
a matching button. It requires
one driver Canvas, a live WebGL2 context and the qualified game realm described
in [Simulator](simulator.md#select-the-actual-game-realm).

In the next game frame, it reads the default framebuffer while temporarily
replacing only READ_FRAMEBUFFER, PIXEL_PACK_BUFFER, PACK_ALIGNMENT, PACK_ROW_LENGTH,
PACK_SKIP_PIXELS and PACK_SKIP_ROWS. It restores and verifies every binding,
leaves the game's GL error queue untouched, and installs no persistent hook.
The one frame wait expires after five seconds. A resized/lost Canvas, ambiguous
target, unavailable control or failed restoration remains an explicit failure.

The new private output directory retains raw tool results, two correctly oriented
PNGs, original-RGBA and PNG SHA-256, crop coordinates, actual Canvas/window/context
facts, current UI selection and before/after Renderer receipts. PNG generation
uses Python's standard library. Tool calls are each bounded to 30 seconds; run
asynchronously if necessary to keep progress updates available. Pending native
tasks are preserved as failures rather than silently retried.

Exit 0 means the readback pair and copied screenshot are available. Inspect the
images yourself: a nonzero alpha channel or flat control crop does not establish
valid image content. The positive control must contain its expected visible
feature. An empty/cleared positive crop means readback is unqualified, even if
geometry and counters look correct. Keep the existing context attributes;
changing `preserveDrawingBuffer` to obtain evidence would change the tested path.

| Observation | Interpretation |
|:--|:--|
| Actual Canvas crop contains the artifact | Capture that frame through RHI Debug and inspect the target/composite owner |
| Actual Canvas crop is clean and the positive control is valid | Exclude only the sampled Canvas region at that frame; compare simulator presentation next |
| Full IDE image places the artifact outside the rounded viewport | Evidence for simulator presentation/crop ownership |
| Readback, control or full-window image is unavailable | Keep the corresponding attribution unknown; do not manufacture a rendering pass |

The official screenshot follows the readback; it is the same observed state,
not an atomic identical-frame capture. Avoid input or layout transitions between
them and preserve both timing/receipt facts for animated scenes.

For the full IDE image, use an already qualified GUI/CDP capture of the current
window. macOS `screencapture -l` expects an observed **CoreGraphics window ID**;
the official CLI `winId` is a different identifier. A locked desktop can make
full-window capture unavailable even though the official simulator tool works.
Do not restart shared DevTools or change the Mac login/lock state to force it.

On Nightly 2.02.2610092 / macOS 26.3.1, a combined ordinary game at 1170×2532
showed tiny English/French label remnants outside the rounded top-left phone mask
in the official image. The actual 256×12 Canvas crop contained sky, while the
32×32 language-control crop visibly read `gli` and all bindings were restored.
This excluded the sampled Canvas area; the locked Mac left complete IDE-window
attribution open. These are version-specific observations, not a blanket rule
that similar artifacts always belong to the simulator.

Qualify collector changes with `test_sample_canvas.py` and
`verify_canvas_reader_browser.mjs`. The latter uses real sandboxed desktop WebGL2
with deliberately nondefault read/pack state and exact pixel controls. Its
Engine `inspectUi` walks a live DOM with more than 48 preceding elements and an
open ShadowRoot; a second tree exceeds 256 visited elements and must be rejected
even after the button is found. Synthetic Renderer receipts qualify the reader
only, never ordinary Engine or phone rendering. Keep native acceptance bound to
the actual delivered game bytes.

## Linux browser comparison with a real WebGPU Surface

For a Linux Chromium reference, retain the actual Canvas Surface and final
`screen-ui-composite` pass rather than substituting an offscreen texture. Follow
the checkout's `scripts/ci/probe-local-graphics.mjs` launch configuration. With
Chrome Beta 155.0.8059.5, Vulkan SwiftShader without the probe's
`--use-angle=swiftshader` could pass shader creation and empty queues, then fail
Surface submission with `SharedImageBackingFactory` / `Unable to create shared
image`, queue `OperationError: A valid external Instance reference no longer
exists`, and a destroyed device. A pure native 4×4 Canvas clear reproduced it;
the existing ANGLE option restored completion and exact readback. Preserve such
native logs and qualify the launch environment before editing Engine shaders.
This is an observed launch combination, not a universal WebGPU requirement.

The Chinese startup/fatal comparison then passed both real WebGL2 and WebGPU
Surfaces at 640×320/DPR1 and 390×640/DPR2 through loading, fatal, partial scroll,
maximum scroll and reset. The numeric oracle was the same document's CPU raster;
Chromium's own DOM supplied a separately reviewed visual reference. This method
does not establish packaged-host lifecycle, phone performance or physical IME.
