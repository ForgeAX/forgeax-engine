# Standard deferred acceptance

Standard Deferred evaluates admitted Standard/custom Surface materials once in
the G-buffer, then resolves lighting with fullscreen triangles. The rigid and
skin GPU capture gates require one indirect G-buffer draw for their single
receiver and forbid Forward receiver geometry in the Deferred frame.

## Reproduce

Build both checkouts with `pnpm build:engine`. Execute the same
[benchmark script](../../../../scripts/bench/standard-deferred.mjs) from each
checkout, using that checkout as the working directory:

```bash
node /absolute/path/to/feature/scripts/bench/standard-deferred.mjs before
node /absolute/path/to/feature/scripts/bench/standard-deferred.mjs after
```

Use a qualified native graphics environment from the
[CI operating guide](../../../../scripts/ci/README.md#build-inputs).
The script reads the checkout's built packages and cooked shader manifest,
records their source commit and manifest digest, awaits every frame receipt,
warms 60 frames, and measures 180 fixed-camera plus 180 moving-camera frames.
No GPU timestamp intervals are added together.

## Measured software GPU cohort

These measurements describe the original Deferred implementation, not the
compact G-buffer change below.

The baseline is `8be64decae4acdc96517792fc7e81e37ec89774b`, including the upstream
opaque texture and shadow specialization. The implementation is
`ce47551c2f5a3f8cb19eac215245f82d094938ab`. Both runs use 306 sphere receivers,
960 triangles each, 320 x 180, medium SSAO, FXAA, four 1024 directional shadow
cascades, 35-unit shadow distance, identical Standard materials and Skylight.
Native Dawn/Vulkan uses Mesa Lavapipe 25.2.8 with four software-rendering threads.
A subsequent readiness fix selects only device-reachable skin shader variants
at startup; these warmed-frame measurements retain the exact measured commit
above and do not measure that initialization change.

| Camera | Completed FPS before | Completed FPS after | Submit interval before | Submit interval after |
|:--|--:|--:|--:|--:|
| Fixed | 5.478 | 5.924 | 182.718 ms | 168.975 ms |
| Moving | 3.373 | 3.718 | 296.678 ms | 269.205 ms |

[Raw measurements](measurements.jsonl) retain the two complete JSON result
lines printed by the script, including GPU-driven inspection and pass rosters.
The runs were sequential on a shared host, with one sample window per case;
other host workloads were not isolated. These measurements show local completed
throughput improvements of 8.1% and 10.2%, without establishing statistical
significance, physical GPU bandwidth behavior, Apple M4 Pro/Meadow performance,
or a 60 FPS outcome.

## Permanent regression evidence

| Gate | Invariant |
|:--|:--|
| `standard-deferred-parity.dawn.test.ts` | Requested Deferred frames must contain fullscreen lighting and no Forward receiver geometry; direct/indirect, rigid/skin, fixed/moved HDR parity; four-cascade shadow, SH, AO, light-removal and alpha-clip falsifiers; shared emissive/lighting SceneColor, additive RGB, preserved opacity and HDR emissive above one |
| `standard-gbuffer.dawn.test.ts` | Production GPU encode/decode over 1,024 sphere/ramp samples: normal angular error below 0.07 degrees, linear scalar error at most 1/510, RGB absolute error below 1/255 |
| `standard-gbuffer-replay.{browser,dawn}.test.ts` | Four live Renderer captures, strict v7 decode, fresh-device replay, post-work packed integer/HDR reads, whole-image live parity, alpha preservation, nonzero SSAO/SSR output and a separately encoded missing-lighting falsifier |
| `surface-standard-pipeline.dawn.test.ts` | Default/custom base and Physical Surface, water, GPU submission, SSAO, AA, scaling and device recovery; advanced Physical and transparent surfaces retain explicit Forward admission |
| `standard-texture-specialization.dawn.test.ts` | Upstream texture specialization and opaque vertex-only shadow behavior remain valid |
| `standard-pbr-artifact-assembly.unit.test.ts` | Probe-enabled shader selection cannot alias the non-probe publication cache |
| `skin-motion-regression.unit.test.ts` and learn-render triangle Browser gate | Device-matched skin prewarm retains all supported draw/reflection/material axes; the original 15-second bootstrap assertion passes without a timeout change |
| `lint:grep` Standard lighting gate | Rigid, skin and Deferred each call the shared environment/direct helpers once; no duplicate base diffuse/SH/cluster evaluation, and both geometry entries use the shared G-buffer encoder |
| `typed-pipeline-topology.unit.test.ts` | Lighting samples G-buffer resources without replaying receiver geometry |

The Dawn parity fixture writes tapes, compiled fragment sources, RGBA16F paired
frames, topology JSON and maximum HDR error to `artifacts/standard-deferred/`.
The tested HDR tolerance is 0.025. The integrated rigid/skin fixed/moved
measurements range from 0.000732421875 to 0.0009765625. Display PNGs use Reinhard
plus gamma 2.2 and four-times nearest enlargement; assertions use raw HDR data.
Their columns are Forward fixed, Deferred fixed, Forward moved, Deferred moved.
The quoted error range is historical; rerun the fixture for the current packed
layout rather than treating the original FP16 errors as current measurements.

The replay fixture writes immutable source tapes and raw post-work evidence to
`artifacts/ue-gbuffer-verification/rhi-debug/{browser,dawn}/`. Its report records
tape digests, shared work/event anchors and maximum live/replay HDR error against
the unchanged 0.002 bound. The falsifier has a separate digest; it must recover
pure emissive and diverge from the lit image. Failed runs preserve their original
error and Renderer state. Follow the [Browser lifecycle
recipe](../../../../scripts/ci/README.md#browser-gates)
when a capture/replay process fails.

> [!NOTE]
> Same-environment replay fidelity and cross-environment pixel identity are separate
> claims. Both environments use Engine's `rhi-webgpu`; Chrome 155 selects
> SwiftShader, while Node/Dawn selects Mesa Lavapipe. The browser capture replayed
> on Dawn/Lavapipe retains
> bit-exact packed values in jointly covered pixels, but four silhouette pixels
> differ in coverage and a bright specular sample differs by 0.09375
> (about 0.21%). The strict cross-backend 0.05/byte-identity diagnostic fails.
> Against the independently captured Dawn fixture, those same replayed integer
> attachments are all byte-exact; geometry/lighting/AO match exactly and SSR
> composition differs by at most 0.0009765625, within the original 0.002 bound.
> Preserve both results instead of calling cross-backend identity passed.

The follow-up reduction isolated the differences without changing the original
tapes, shader implementation, or strict diagnostic threshold:

| Difference | Controlled experiment | Measured cause |
|:--|:--|:--|
| Four silhouette pixels | Identical fixed clip-space vertices and constant color, no material, lighting or depth test | The same `(35,14)`, `(38,15)`, `(38,48)`, `(35,49)` pixels differ. Complete 64 x 64 coverage masks match nearest 1/16-pixel vertex snapping for SwiftShader and 1/256-pixel snapping for Mesa; this is an empirical model, not queried Vulkan limits. |
| Bright specular pixel `(31,32)` | Same tape with separately digested float32 intermediate probes | Depth and reconstructed position are identical. Normalization and dot products differ by 1-2 float32 ULPs; near-normal, low-roughness GGX amplifies them into distribution values 889.2321 and 890.5718. |
| Opacity half-float difference | Constant fragment output `0.37`, without material evaluation or blending | Mesa stores 0.369873046875; SwiftShader stores 0.3701171875. The sampled writes follow truncation and nearest rounding respectively, without implying a universal conversion-mode guarantee. |

Raw reductions, probe tape digests, adapter identities and the full-mask oracle
are retained in
`artifacts/ue-gbuffer-verification/rhi-debug/cross-environment-diagnosis.json`.
Instrumented values explain the divergence; they do not replace the original
HDR result or prove pixel identity on other devices. These reductions found no
G-buffer packing or RHI-debug replay defect responsible for the observed pixels.

## Compact G-buffer and SceneColor ownership

The layout follows UE's separation of normalized material facts from HDR
SceneColor, including geometry-owned emissive and additive lighting.
[UE 5.3 GBufferInfo.cpp](https://github.com/chenyong2github/UnrealEngine/blob/5.3/Engine/Source/Runtime/RenderCore/Private/GBufferInfo.cpp)
is the format reference. This is not a byte-identical UE layout: ForgeaX retains
colored F0/IOR and its full reflection/SH context, using Oct12 normals and
square-root encoded reflectance instead of UE's RGB10A2 normal and sRGB base color.
The current format and ownership SSOT is the
[Render contract](../../README.md#ssr-admission-and-bounded-inspection).

The compact-layout Dawn run on Linux Mesa Lavapipe 25.2.8 / LLVM 20.1.2
measured maximum linear-HDR error of 0.0015869140625 (fixed) and
0.0018310546875 (moved), for both rigid and skin and both direct and GPU-driven
geometry. The separate HDR-emissive/opacity assertion also passes its 0.025
Forward-parity bound. These are correctness measurements, not GPU timings.

| Storage or traffic | Original | Compact |
|:--|--:|--:|
| Material attachments, excluding SceneColor | 32 B/pixel | 16 B/pixel |
| Material attachments plus SceneColor | 40 B/pixel | 24 B/pixel |
| Geometry color attachment writes | 32 B/sample | 24 B/sample |
| Lighting material texture reads, excluding depth/AO/environment | 32 B/sample | 16 B/sample |

> [!NOTE]
> These are uncompressed format-size calculations, not measured DRAM traffic or
> GPU throughput. Additive SceneColor blending reads the destination, and hardware
> compression, tile memory, overdraw and cache behavior determine actual bandwidth.
> No hardware performance improvement is claimed for this change without a paired
> timing run. Depth, SSR side outputs and post-processing are excluded from this table.

The complete Browser/Dawn gates and 300-frame hello/learn smoke roster remain
required on the final PR commit. See the PR checks for that execution evidence.

## RHI verification

Capture/replay verification records the per-work, integer
attachment, cached depth, Surface lighting and Viewer/CLI evidence. The
[seven Surface results](rhi-debug-surface-results.json) retain tape digests,
work coordinates and measured whole-image errors.
