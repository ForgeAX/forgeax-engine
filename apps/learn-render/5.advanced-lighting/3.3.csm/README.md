<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# 3.3.csm：Directional CSM / PCSS MVD

This carrier reuses one `3.3.csm` scene and renderer for five closed profiles: `off`, `pcf3`, `pcf5`, `pcssMedium`, `pcssHigh`. It writes only authored `DirectionalLight` facts and reads backend, device/graph generations and directional-shadow inspection from the same `renderer.inspect()`. Engine retains algorithms, fallbacks, timing and RenderGraph submission.

## Run

The fixed dev URL is `http://127.0.0.1:5201/`. Query parameters select MVD variations of the same scene:

```text
?mvd-profile=pcssMedium&mvd-scene=near
```

Profiles: `off`, `pcf3`, `pcf5`, `pcssMedium`, `pcssHigh`. Scenes: `near`, `far`, `seam`, `motion`, `alpha`, `transparent`, `fallback`. Keys `o`, `3`, `5`, `m`, `h` switch profiles; `n`, `f`, `s`, `v`, `a`, `t`, `b` switch scenes; Space toggles shadows.

## Evidence and Boundaries

The Dawn path in `smoke.mjs` uses real `copyTextureToBuffer` readback, writing the same frame's RGBA hash, PNG, renderer generation and structured inspection to `.forgeax-debug/m4-csm-mvd/<profile>-<scene>.json`. PNG supports visual review; paired readback supplies numerical facts. Both must come from the same renderer frame.

`smoke-browser.mjs` reuses shared RHI-debug capture for live/replay pixels and PNG output. Missing `deviceGeneration` / `graphGeneration` stays `null`; the verdict cannot become complete generation-bound evidence. WebGL2 supports actual Medium/High PCSS using raw depth and shader comparison, still requiring real backend pixel evidence. RhiNull permits structured evidence only, never pixel or GPU-timing claims.

## Eight Visual Expectations

Engine-owned `bindCsmMvdVisualExpectations()` fixes eight IDs: `off`, `pcf3`, `pcf5`, `pcss-medium`, `pcss-high`, `near-far`, `seam`, `motion-alpha-transparent-fallback`. Callers must provide backend and generation from real inspection, never placeholder generations.

## Explicit Failure

When Browser WebGPU, capture hooks, paired readback, PNG or GPU timing are unavailable, smoke must report explicit `not-run` / environment concerns. CPU wall time, RhiNull command bookkeeping, logs and absent screenshots cannot qualify as GPU timing, pixel success or visible-quality conclusions.

Following the AI-user charter, output retains stable IDs and machine-readable source/backend/generation. Unsupported, not-run and pass remain distinct so AI users can continue diagnostics from the same receipt.

## Caster header contract

The Browser tape gate verifies each automatic CSM caster header as
`[cascadeIndex, isSpot, clampNear, pad] = [i, 0, 1, 0]`. The third lane carries
the near-plane pancaking policy; it is no longer padding. Cascade selection,
light mode and the remaining padding lane stay strict. Pixel parity and
receiver-quality thresholds remain independent of this binary contract check.

Receiver source checks trace the physical array layer through the plane-aware
comparison helper, its native `shadow_sample_compare` hardware comparison,
and all four raw depth texels. PCSS retains that layer and
uses a bounded, one-sided receiver-plane reference toward the light. These
checks complement the live/replay pixel gate; they do not replace it.
