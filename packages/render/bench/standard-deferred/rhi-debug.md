# Standard Deferred: RHI capture and replay verification

The investigation uses strict v7 tape decoding, per-work inspection, post-work
resource readback, and replay on a fresh Dawn/Lavapipe device. Each replay device
uses the recorded capability requirements through `replayDeviceRequest`.

## Defects found and repaired

| Observation | Owner repair | Permanent regression |
|:--|:--|:--|
| Packed Deferred attachments returned `readback-unsupported` | RHI-debug reads `r32uint` as four exact bytes | Browser and Dawn GPU writes, capture, strict decode, fresh replay, selected-work readback of high-bit integer values |
| Custom Standard Surface Forward omitted local lights; the full image differed from Deferred by 24/255 | The closed material cook context derives clustered lighting from storage capability; direct and scene-index layouts follow the compiled WGSL contract | Full Surface output image comparison, including a local point light |
| Cached shadow depth was absent from the tape, making a valid direct Forward image replay dark | Recorder snapshots all `depth32float` layers/mips; replay restores floats through a depth-only raster pass | Browser and Dawn cached-depth consumer, seven fresh Surface captures/replays |
| Custom Surface omitted SH; both render paths could therefore agree while both were wrong | The same cook context enables ProbeBlend; direct and GPU submission share actual binding detection and the retained zero record when no probes exist | Probe on/off checks across base and Physical material interiors, then complete probe removal and direct/Deferred parity |

The rusted-iron material has a pure-metal center. Its diffuse SH contribution is
correctly zero there. The SH falsifier inspects a bounded interior that includes
its authored nonmetal corrosion, rather than assuming every pixel is diffuse.

## Baseline and effect evidence

| Path | Evidence | Result |
|:--|:--|:--|
| Rigid and skinned Standard | `checks.json`, four source tapes and four independent repeated replays | Live HDR equals replay byte-for-byte; repeat devices agree on every selected resource |
| G-buffer transport | `deferred-rigid/`, `deferred-skin/` | Packed material `0x5912296b`, SH row 1, indirect arguments `[36,1,0,0,0]`; each attachment equals the corresponding Deferred-lighting binding |
| Shadows | `variant-checks.json`, `variants/` | Removing shadows changes HDR by 0.2430419921875; paired Forward/Deferred shadow error is 0.000732421875 |
| SSAO without direct lights | Same | Toggle changes HDR by 0.0203857421875 |
| SH | Same | Toggle changes HDR by 0.081298828125 |
| Alpha clipping | Same | Clipped output is zero in both paths |
| Mixed Surface scene before repair | `surface-checks.json`, `surface/`, `surface-replay/` | Each replay exactly matches its live capture; cross-path difference exposed the cook defect |
| Repaired mixed Surface scene | `surface-final-checks.json`, `surface-final/`, `surface-final-replay/` | Seven independent tapes cover Forward/Deferred, SH, SSAO and no-probe direct submission |
| SSR and reflection environments | `ssr-on/ssr-selected-work.json`, `ssr-replay/` | 4,624 positive reflection pixels, 1,391 accumulated history pixels, 22,294 changed compose pixels; 445 incompatible receivers with zero contamination |

The SSR tape contains 164 G-buffer draws, 164 temporal geometry draws and two
fullscreen Deferred-lighting draws for reflection environments 0 and 1. The
reflection environment 1 covers 576 pixels. The temporal geometry is the
motion/scene-data producer; it is not a Forward lighting replay. Raw compose
formula error is 0.0019521368815893503; format-interval error is 0.000244140625.

`ssr-on/frame.png` was overwritten by the smoke's later fault/recovery screenshot
because its capture and manifest evidence directories coincided. It is not the
captured frame's live image. Use `ssr-replayed.png` for the tape output; no
live/replay equality claim is made for that overwritten PNG.

## Reproduction

Run the permanent Surface Dawn test with `FORGEAX_SURFACE_LANE_PARITY=1` and
`FORGEAX_SURFACE_RHI_CAPTURE_DIR=artifacts/deferred-rhi-deep/surface-final`.
The capture includes recorder device-loss forwarding before device recovery.
Then run each tape through:

```sh
node artifacts/deferred-rhi-deep/inspect.mjs SOURCE/frame.rhitape REPLAY_DIRECTORY
python3 artifacts/deferred-rhi-deep/check-surface-final.py
```

Use the qualified Lavapipe wrapper on this host. The inspector retains tape
headers, digests, device capabilities, work/event anchors, shader sources,
bindings, integer attachments, selected-work images, and structured errors.
`readResourceAtWork` reads the resource after its producer; initial-resource
readback does not establish G-buffer or lighting output correctness.

`forensic.mjs` contains explicitly labeled shader-override negative controls on
immutable original tapes. They are localization experiments, separate from the
unmodified baseline and repaired renderer captures.

Some local Vitest runs report a fork termination timeout after their completed
assertions and exit with code zero. This harness teardown warning is retained
in the logs; it is distinct from native WebGPU validation, which the permanent
Surface gate explicitly rejects.

## Final Surface replay and tool usability

All seven recaptured Surface tapes match their live RGBA output byte-for-byte.
Four Deferred tapes each retain two admitted G-buffer works and one fullscreen
lighting draw, with zero matching opaque Forward replays. All five G-buffer
attachments match the corresponding lighting input bytes. The seven replays
perform 174 selected resource readbacks with no native validation or structured errors.
Whole-image Forward/Deferred maximum error is 2/255 without SH and 4/255 with
SH, below the permanent 0.05 bound. Each base/Physical default/custom material
responds to the SH falsifier (interior maxima 106, 166, 144 and 81 byte levels).

The old direct no-probe tape differed from live at 373,972 byte positions
(maximum 210/255). Disabling shadow sampling in a labeled diagnostic shader
made that old replay exactly match live. Fresh depth snapshots now reproduce
the unmodified live image exactly; the old tapes remain preserved under
`surface-before-depth-fix/` and `surface-before-depth-fix-replay/`.

`cli-summary-old.json` identifies four absent depth32float seeds;
`cli-summary-new.json` shows those omissions repaired. The remaining
unseeded transient resources are explicitly reported; the live/replay byte
comparison establishes their correctness in these frames. `cli-inspect.json`
was produced by the installed DevKit command on a fresh Dawn device, and
`cli-digest-mismatch.json` preserves the rejected wrong-identity case.
The new summary is about 5.5 KB for this frame and omits repeated WGSL.

Final local tool gates: 177 RHI-debug assertions, 28 RHI-debug Dawn
assertions, 10 DevKit RHI operation assertions, and two Browser integer/depth
assertions pass. Render's 2,216 assertions and compiler's 249 assertions passed
for the renderer/cooker repair. Full CI and the complete 300-frame fleet must
also pass at the final pushed PR commit.

The seven deep Surface tapes describe renderer/cooker revision `2b55aab66`.
A final cache-reuse follow-up keeps a zero-record lookup from invalidating the
accepted scene projection: the existing 300-frame stable-revision regression
now interleaves sentinel and scene consumers, reducing redundant uploads from
300 to zero. It changes buffer reuse, not shader or material evaluation; the
full Surface Dawn gate is rerun after this follow-up.

Viewer correctness also retains stage identity when vertex and fragment share
one shader module. The regression fails before the fix (two editors have one
identity), then 94 Viewer assertions pass. The real browser smoke uses one
module for both stages and proves editing the fragment produces green pixels
with zero red pixels, while invalid WGSL clears the preview and reset restores
canonical source. Local Chrome Beta runs under Xvfb/Lavapipe through an
untracked launch-only carrier; the Viewer unit regression also runs in CI. This
bounded Viewer check is separate from the command-based Surface replay proof.

The complete CI CSM Browser gate also exposed a capture transport failure:
large cached depth snapshots were expanded into a Chromium protocol string.
Browser uploads now use Blob bodies while preserving the raw tape endpoint,
MIME and exact bytes. Shared verifier, browser admission and live CLI capture
use this transfer; the full CSM gate remains the regression.

A Browser VFX/Standard IBL parity failure was also reproduced with the exact
CI shader payload. The failed ordinary draw binds fallback irradiance and
prefilter textures while its tape still contains precompute work; fresh
replay preserves its gray `[67,66,67,255]` pixel. The later VFX sample uses
the completed environment and returns `[8,5,93,255]`. The existing regression
now waits for `Renderer.inspect().iblBinding.active` within 300 frames before
comparing sequential materials, preserving all pixel thresholds and cases.
This prevents asynchronous readiness from being reported as a BRDF mismatch.
