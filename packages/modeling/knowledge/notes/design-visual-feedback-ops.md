# Design note: visual feedback and verification operators

Status: proposal implemented in one change. Source of ideas: img2threejs (Apache-2.0),
its review stage (Divine Eye ensemble, interior difference, microscope tiers, turntable gate,
correction loop). Everything here is pure TypeScript; no WASM, no Python, no model call.

## Purpose

An agent that rebuilds a subject from a reference image needs measured feedback on what it
cannot see in a thumbnail: a deleted small feature, a hole through the head, a billboard that
only looks right from the front, a loop that keeps repeating one mistake. The kernel already
measures geometry against geometry (`validate`, `diff`, `interference`, drawing checks) and
pixels against pixels for bakes (`ssim`, `imageDeltaE`, `flip`). It has no operator that holds
a render to a reference image, and none that decides when to stop iterating.

## Owner and siblings

The image operators live next to `src/tools/image-metrics.ts` (Node-only: PNG decode and file
output). They consume what `model.render` already produces, so the capture path and the
renderer are untouched. Reports follow #274: `pass`, `issues: Issue<Code>[]`, located facts in
`detail`, schema tag `forgeax.model.<op>/1`.

## Operators (four ToolRuntime operations)

| Operation | What it answers | Ported from |
|:--|:--|:--|
| `model.compare` | Does this render match the reference image overall, and where does it differ? | `divine_eye.py`, `interior_difference.py`, `objectness.py`, `make_comparison_sheet.py` |
| `model.microscope` | Is each declared feature (ROI) right at the pixel level, with every critical one passing? | `divine_eye_microscope.md`, `per_feature.py` |
| `model.turntable` | Is every required orbit angle present, does the silhouette survive orbiting, is there a hole through the subject? | `turntable_gate.py` |
| `model.converge` | Given the scores so far, keep iterating or stop, and with which next action? | `correction_loop.py` |

### `model.compare`

Hard gates: silhouette IoU >= 0.85, scale delta <= 0.08 (bbox area), palette (CIEDE2000 of the mean silhouette colors <= 15: the tonal and SSIM signals are color-blind, so a wrongly colored render needs its own gate), plus a refusal when a
foreground mask is unreliable (the subject is not isolated: the mask is tiny or covers the
frame). Soft signals, weighted into one fidelity: proportion 1.0, symmetry 0.5, pHash 1.0,
SSIM 1.5, edge overlap 1.0, blowout parity 0.8, flat-region 0.8, tonal parity 1.0, objectness
1.5. Hue-zone gate: per hue band present on both subjects, CIEDE2000 <= 15 (`hue-zone-mismatch`, error; a mean color hides a hue swap, so palette alone is not enough), and a band that holds at least 5 % of one silhouette but is absent from the other is an error too (smaller shares warn). The tighter per-band bound 2.3 stays report-only. The interior difference
(mean luma difference inside both silhouettes on a bbox-aligned 192 grid, `cellsCompared`
always reported, optional height band). Verdict routing is a pure function of which signal
failed: `pass` / `reject` (refine-code) / `low-confidence` (probe, when the soft spread is
above 0.35 and the fidelity is below target). Outputs: a ΔE heatmap and a four-panel
comparison sheet (reference, render, ΔE, edge difference) when `out` is given.

### `model.microscope`

Each feature is `{ id, tier, roi, minimumScore?, concave?, mask? }`; `roi` is a box in
subject-bbox coordinates (both images are aligned on their foreground bbox, so photos and
renders of different size and framing compare). A feature is scored on a patch grid; its score
is the worst patch (worst-of aggregation), and a patch is a weighted mean of SSIM, a two-way
chamfer edge score (missing and extra detail are different defects) and a colour term
(CIEDE2000; skipped for `concave` features, because cavity shading is not albedo). Rules:
fail closed when a ROI is outside the frame or the reference shows no signal there; return
`insufficient-reference-resolution` instead of scoring detail the reference does not resolve;
the optional per-feature `mask` PNG limits the compared pixels to the visible footprint. Gate:
every critical feature meets its minimum, then important, then detail; the overall score is
never an average that can hide one wrong critical feature. Registration: the bbox alignment is
exact only while both subjects share one extent, so a local edit that moves the bbox would put
every untouched feature out of register. Each feature therefore searches a translation of the
render within `maxShift` grid pixels (default 8 of 256, `0` disables; the smallest shift wins ties)
that best overlaps the reference edges and silhouette inside its ROI, and reports the chosen
`shift`. A feature that is genuinely missing still fails, since no shift can bring it back.
Translation only: a scale change is not registered.

### `model.turntable`

Takes `captures: [{ azimuth, path }]`. Required azimuths (default 0/90/180/270, tolerance 5 deg)
are mandatory, a missing one fails. Per capture: silhouette area against the capture nearest 0
deg (collapse below 0.15 means a billboard), and a border flood fill of the background; background the fill never
reaches is an enclosed hole (more than 4 pixels and more than 1% of the silhouette). `allowHoles`
declares a legitimately holed subject. An unsegmentable capture fails the gate whatever
`allowHoles` says.

### `model.converge`

Strict priority: empty, hard gate, pending review, success, repeated defect, oscillation,
plateau, hard ceiling. The ceiling depends only on history length, so a caller that loops
until `stop` runs at most `maxIter` iterations.

## What it replaces and the concept delta

Replaces nothing; nothing in the kernel overlaps. New concepts a reader holds: four operations
and one shared helper module (foreground mask, bbox alignment, area resampling, enclosed
holes). Reused rather than reinvented: `ssim`, `deltaE2000`, `srgbToLab`, `heatmapPng`,
`readPng`, `ColorImage`, `maskIoU`, `Issue`. No new error code in the capture protocol: the
operations read files and report `tool-invalid-args` on bad input.

## Deliberately not ported

- Scores calibrated on img2threejs's corpus: the weights and thresholds are theirs and are
  provisional; the report records every weight and the thresholds used so a later calibration
  is an edit of one table.
- `specularWash` (advisory hue-theft heuristic) and the browser capture passes
  (ID/depth/normal): `model.render` owns capture.
- Pairwise penetration, attachment anchor and swept-arc fitting: the kernel has `interference`,
  rig joints and swept sections.

## Honest limits

The signals measure image similarity, not likeness. A pass means "no measured defect", and the
report states sample sizes (`cellsCompared`, pixels per ROI, patches) so a small sample is not
mistaken for evidence. The weights are provisional until calibrated on labelled pairs.
