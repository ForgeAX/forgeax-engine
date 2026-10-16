# Directional PCF receiver-depth follow-up

The directional PCF3 path now uses its existing nine samples throughout the cascade. The removed four-sample reduction combined bilinear weights even when the receiver-plane correction gave the contributing samples different comparison depths. Comparison is discontinuous: combining coordinates and reference depths does not preserve the original visibility result.

> [!WARNING]
> This is a bounded sampling correction. It does not resolve the curved/folded heightfield self-shadow limitation or establish terrain performance acceptance. The original image and performance thresholds remain in force. The complete Landscape foundation and earlier negative evidence are described in [implementation.md](implementation.md).

## Fixed source comparisons

These are the actual Knowledge Base reference checkout revisions. They are comparisons, not authority over ForgeaX behavior. Unreal source is described by file/function references; its private source is not redistributed with the evidence.

| Reference | Verified mechanism | Consequence for this correction |
|:--|:--|:--|
| [Three.js `d3b629c`](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js#L115), `getShadow` | Bias is applied to projected depth once. Five rotated Vogel samples use that same depth with hardware comparison filtering. | This is not ForgeaX's gradient-adjusted sampling path. Its sample count does not justify combining ForgeaX samples with distinct reference depths. |
| [Godot `4c311cb`](https://github.com/godotengine/godot/blob/4c311cbee68c0b66ff8ebb8b0defdd9979dd2a41/servers/rendering/renderer_rd/shaders/scene_forward_lights_inc.glsl#L254), `sample_directional_pcf_shadow` | Rotated directional kernel samples retain one `coord.z`. The [clustered directional receiver](https://github.com/godotengine/godot/blob/4c311cbee68c0b66ff8ebb8b0defdd9979dd2a41/servers/rendering/renderer_rd/shaders/forward_clustered/scene_forward_clustered.glsl#L2079) projects `geo_normal` bias perpendicular to the light and adds light-direction depth bias. | `geo_normal` is captured before normal-map application; it can be interpolated or fragment-hook modified, rather than an exact primitive normal. Its bias/filter policy is not evidence that a larger ForgeaX bias preserves the near caster. |
| Unreal Engine `71fe36a`, `Engine/Shaders/Private/ShadowFilteringCommon.ush`, `FPCFSamplerSettings`, `CalculateShadowVisibilityTransmittanceFactor`, `Manual3x3PCF` | The inspected classic manual PCF path carries one scene depth and computes depth-difference transition visibility before filtering. | A soft transition and a strict hardware comparison have different acceptance behavior. This observation does not describe every UE shadow path, particularly Virtual Shadow Maps. |
| Unreal Engine `71fe36a`, `Engine/Source/Runtime/Landscape/Private/LandscapeRender.cpp`, `CreateRenderThreadResources` | Landscape sections share regular-grid vertex/index resources keyed by topology and read heightfield texture/mip data. | Retains the basis of ForgeaX's shared-grid Landscape implementation; this sampling fix belongs in Standard directional shadow reception, not a parallel terrain renderer. |
| [Terrain3D `630eb41`](https://github.com/TokisanGames/Terrain3D/blob/630eb4179d2daf4a262b0b34fd3b9415f81ab43a/src/shaders/main.glsl#L145), `vertex` | Camera-distance grid morph shifts horizontal vertices and interpolates height samples at the morph endpoints. | A Godot addon comparison, distinct from Godot core. It supports checking actual submitted triangles rather than treating a baked smooth normal as current geometry. |

Unreal's additional Landscape mechanisms have narrower contracts. At this same pin, `LandscapeProxy.h:796–815` defines non-Nanite Virtual Shadow Map height-error bias and screen attenuation; `LandscapeVertexFactory.ush:856–861` supplies that bias to `ShadowDepthVertexShader.usf:86–90`. `LandscapeRender.cpp:4572–4636` uses LOD height-error bounds to invalidate cached VSM pages. Those controls address continuous-LOD/cache mismatch and do not solve this fixed-LOD fold by themselves. Their numerical defaults are not transferred into the eight-centimetre caster contract.

The classic writer's slope bias (`ShadowDepthVertexShader.usf:97–110,132–140`) receives a Landscape normal interpolated from heightmap normal channels (`LandscapeVertexFactory.ush:682–685`), rather than an exact current primitive normal. The directional VSM receiver (`VirtualShadowMapProjectionDirectional.ush:16–35,100–110`) has plane-slope/texel bias, while SMRT (`VirtualShadowMapSMRTTemplate.ush:87–121`) uses additional depth history, slope extrapolation and clamping. These are useful bounded comparison mechanisms, not proof of exact visibility for arbitrary neighboring geometry.

## Regression and RHI evidence

The Native Dawn regression compiles the actual production receiver functions, rasterizes three frozen `depth32float` layers, and reads back coverage from a linear `greater` comparison sampler. Expected coverage is analytic; it does not duplicate the production implementation. Positive and negative gradients, zero gradient and a clamped edge are checked with the original numerical tolerance.

| Case | Analytic coverage | Removed four-sample path, real GPU |
|:--|--:|--:|
| Positive gradient, blocker depth 0.41 | 0.833333333 | 1.000000000 |
| Negative gradient, blocker depth 0.59 | 0.833333333 | 0.666053951 |
| Zero gradient, blocker depth 0.51 | 0.666666667 | 0.666053951 |
| Clamped edge | 1.000000000 | 1.000000000 |

The earlier completed production-source regression checkpoint passed (`data/logs/terrain-pcf-gradient-green.log.gz` in the archive, corrected source SHA `e134afe51eb333fcb92a776d5f5890a2b7896d4afe71b097a703420fe727aab6`). The zero-gradient discrepancy is an observed difference in combined sampling coordinates, weights and filtering precision; this experiment does not isolate a single numerical cause or establish a driver defect. It is not used to relax the `2/255` image threshold.

At the earlier completed fold checkpoint (`data/forward-nine-tap-replay/report.json` and `data/deferred-nine-tap-replay/report.json` in the archive), fresh-device unmodified replay was byte-identical to the captured live frame in both Forward and Deferred. Those original tapes contain pre-correction source SHA `8edfa519b196574fda0e1f6c20172eb6c9452d59b237b317d58ece1db991ba21`. Changing only the recorded shader to bypass the four-sample branch changed 483 channels beyond `2/255`, with a peak change of `14/255`. The corrected replay still differs from the unshadowed control by `23/255`: the fold falsifier remains **FAIL**.

Single-frame replay pass intervals were 0.459 → 0.524 ms in Forward and 0.590 → 0.655 ms for Deferred lighting. These coarse timestamp observations are not exclusive shader cost or an outer GPU frame measurement. Empty and overlapping pass intervals remain in the raw report.

The final checkpoint at `cca410d1de5379ce9d25b2197a3264dd972cbca5` completed the manifest-selected five-test Native Dawn gate in an exclusive window (`16:50:10–16:50:32 UTC`, 2026-10-03). Measured coverage was `[0.833333313, 0.833333313, 0.666666687, 1]`. Mesh/terrain × Forward/Deferred near-plate gates each retained PCF1 dark=100 and PCF5 dark=97, against the original PCF1 dark >50 and PCF5 dark ≥0.85 × PCF1 dark requirements. The initial unnecessarily recompiling invocation remains recorded as exit −15, not a pass.

Fresh-device replay of the final corrected fold tapes also passed: Forward tape SHA `2bc0afb6b0a349f706823e68aead192554d0e11087176bdd3b15e5be06a4646e`, Deferred `a5751f53df26b53056d558710320807acb93d174b8729e8397f8fb9df6045c5f`; presentation works 5/8. Both unmodified replays are byte-identical to live. A diagnostic replacing only the receiver shadow factor by one is byte-identical to the off control in both paths. This isolates the residual 23/255 darkening to reception; the diagnostic is not shipped as a fix.

## Remaining information boundary

At a filter tap, the current receiver position, local geometric normal and first shadow-map depth can describe either an adjacent rising terrain triangle or an independent plate above a flat receiver. The former can be unoccluded under vertical light while the latter casts a real shadow. A local plane extrapolation cannot distinguish those cases. Terrain/entity identity alone also cannot exclude legitimate slanted-light terrain self-shadow.

Increasing bias previously removed the real near-caster shadow. A broader correction therefore needs verified neighboring receiver geometry or equivalent visibility information, tested against both controls. That is a separate rendering change; this patch introduces no speculative attachment, identity channel or terrain-only exception.

## Performance boundary

An instrumented CPU attribution capture retained 60 frames per path with no dropped events. Draw wall p95 was 53.618 ms in Forward and 23.884 ms in Deferred; thread CPU p95 was 7.760 and 7.890 ms. Nested phase intervals overlap and cannot be added as exclusive cost. These are diagnostic captures, not the uninstrumented fixed-series acceptance result. No contention or observer estimate is subtracted.

The corrected production source (`e134afe51eb333fcb92a776d5f5890a2b7896d4afe71b097a703420fe727aab6`) passed all 74 planar/near-contact receiver cases. The full curved matrix retained 16 control pairs, including eight vertical-light failures with peaks of 44–81/255. All eight continuous-fold cases failed with peaks of 18–24/255, against the original 2/255 budget.

The uninstrumented Metal series ran Forward then Deferred three times, with eight scenarios per run and 60 warmup plus 60 measured completed frames per scenario. Apple M4 Pro, macOS 26.4.1, 960×540, 1024 shadow map. Every run failed its frozen budgets:

| Metric | Frozen p95 budget | Failing scenarios / 48 | Worst scenario p95 |
|:--|--:|--:|--:|
| CPU draw | 8 ms | 37 | 113.252 ms |
| GPU interval union | 16.67 ms | 0 | 4.063 ms |
| Frame to completion | 33.34 ms | 25 | 136.012 ms |

Every raw GPU interval is retained with sum, union, duplicated overlap and measured envelope. Native outer GPU timing is unavailable. These series show CPU/completion failure on this device; they do not establish the nine-sample shader's exclusive cost, and no contention or observer estimate is removed.

The local browser carrier completed 60 frames at 1280×720 and passed the browser-fresh pixel oracle (mean 0, maximum channel delta 0.00392157, original threshold 0.05). Its independent adapter probe does not establish exact carrier device identity. Complete latest-head CI remains the delivery gate for the full browser/Dawn and hello/learn-render roster.

The immutable archive below contains completed local checkpoints. Full final-head delivery CI is tracked by Engine PR #3628.

## Immutable evidence and reproduction

Assets PR #45 merged as `71cb408f4f21f51feb916ffb3386eda46ba48019`. The archive records source revisions, all command terminals and boundaries; its inventory verifies 371 payloads, 208,840,267 bytes. Raw logs and tapes are losslessly gzip-compressed. Private reference repositories require their normal source access; no UE source is copied into this archive.

Production-function RED/GREEN readback

| Corrected fold baseline, quality still FAIL | Receiver-factor-one diagnostic, not shipped |
|:--|:--|
| Baseline | Diagnostic |

All fixed performance series

<details>
<summary>Reproduce focused checks from a built contributor checkout</summary>

```sh
FORGEAX_SHARED_APP_INPUTS_MANIFEST="$PWD/shared-build-inputs/manifest.json" \
  pnpm exec vitest run --project dawn \
  packages/runtime/src/__tests__/shadow-pcf-receiver-gradient.dawn.test.ts \
  packages/runtime/src/__tests__/shadow-receiver-plane.dawn.test.ts \
  --retry 0 --maxWorkers 1
node apps/hello/terrain/scripts/receiver-quality-dawn.mjs
node apps/hello/terrain/scripts/curved-shadow-dawn.mjs
node apps/hello/terrain/scripts/fold-shadow-dawn.mjs
```

The last two commands retain the original failing thresholds. The archive's inert recipes document fixed six-run order and native device selection. Decompress the original tape before applying the existing `curved-shadow-replay.mjs` diagnostic. Fresh replay changes only its stated receiver function; it does not recook or reconstruct the captured geometry.

</details>
