# SDK and Dawn workload follow-up

> [!IMPORTANT]
> Preserve all four public point-shadow/SSAO configurations, the complete Dawn
> roster, real GPU assertions, 60-frame policy and existing metric thresholds.
> The changes remove duplicate production work rather than changing scheduling.

## Measured starting point

The final green checks of PR #3265 are the comparison point:
[CI 35436173324](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/35436173324)
and [SDK 35436173320](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/35436173320),
head `f246d3eed8e385bafef1482f6fe0f7f40732f03c`, attempt 1. The follow-up starts
from its merged commit `7235d2cd69255626c784513a1d51c2a483d3a7d7`.

| Work | Measured duration | Owning cause |
|:--|--:|:--|
| SDK job | 1,648 s | Build 990 s, followed by exact consumer and ZIP verification. |
| Three SDK release profiles after Engine build | 573.33 s | Each profile compiles the entire material fleet, even though SSAO only adds one utility entry. |
| SDK source-template verification | 324.63 s | Includes a real public-source rebuild and semantic browser journey; retained. |
| Dawn job / command | 1,140 / 1,069 s | Complete serial backend groups and required native lifetime boundaries. |
| VFX mesh Dawn owner | 74.95 s | Point-shadow source production before real lighting/depth/capture assertions. |

## One stored manifest per material configuration

The Vite source owner uses `hdrpSsao` only to add the independent SSAO fullscreen
entry. It does not change material defines, imports, variants or receipts.
Previously `base-base` duplicated `base-ssao` without that entry, and
`point-base` duplicated `point-ssao` in the same way.

Store only `base-ssao` and `point-ssao`. The packaged loader and transferred-input
loader now share the existing SSAO entry projection. All four caller
configurations still produce their requested output; this is not substitution
of the point-shadow material profile for the base material profile.

With a verified `point-ssao` input from `build:engine`, SDK now invokes the full
source producer once for `base-ssao`, rather than three times. The producer
removes obsolete generated copies without deleting declarations. Missing,
stale, malformed, wrong-profile and corrupt acceleration still rebuilds.

## Standalone point-shadow preparation

Dawn admits its transferred point profile through the same producer used by
browser tests. Standalone point-shadow requests without authored material
packages consume the prepared profile instead of recompiling every engine
variant. Missing inputs and explicit source-validation requests retain the
source route; authored point-shadow packages retain their separate compilation.

The public point-shadow source regression explicitly sets
`FORGEAX_ENGINE_SHADER_SOURCE_BUILD=1`. Its cache identity includes that choice,
so a prior packaged result cannot hide source compilation. GPU tests keep their
existing frame, pixel, shadow, IBL, latency and capture assertions. The VFX mesh
owner records preparation and verification/cooking durations separately.

## Verification evidence

- The profile producer regression was red with three source calls instead of
  one, then passed with the two stored profiles and obsolete-output cleanup.
- The standalone builder regression was red when it selected source despite an
  available prepared profile, then passed for reuse, source fallback and authored
  package routing.
- The optional-entry regression checks both SSAO states without mutating input
  or removing unrelated entries. Explicit source mode bypasses packaged loading.
- Local unmodified VFX GPU acceptance passed twice in 112.66 s and 115.13 s of
  test/hook time. These runs shared the host with compiler work; they are not CI
  latency or P95 measurements.

The two independent no-SSAO source builds took 245.03 s and 249.10 s locally.
For each point-shadow state, removing only the SSAO entry from the new stored
manifest produced identical serialized JSON to the independent no-SSAO source
result. All four configurations then passed through the real Vite plugin and
matched every entry/material value (including WGSL, bindings and variant
receipts), allowing only the packaged loader's existing `uvSetCount: 0`
normalization. Stored manifest bytes fell from 566,381,066 to 283,200,604,
removing 283,180,462 bytes before archive compression.

| Point shadows | SSAO | Entries | Materials | Source-manifest SHA-256 |
|:--|:--|--:|--:|:--|
| Off | Off | 48 | 20 | `357e0b414370b672d9c711eed2c5f6abcbdf3904cdf726c2dc20088776937ad4` |
| Off | On | 49 | 20 | `bf78cb032217d063b09ca523100fb984a78b69ee8876e0d65245731f2286de94` |
| On | Off | 48 | 20 | `02f32223394e21daa2f184d2d4ba6f4bd61c99673c138b8beff9b71cbf3db15d` |
| On | On | 49 | 20 | `b6071494063f42a6e64e6db746465b421c1daa61a798c08cce59aff716310466` |

Digests cover the compact serialized full manifest, not only entry names.
The unchanged VFX mesh Dawn acceptance passed through the actual gate entry in
36.08 s of test/hook time, versus the local source baselines of 112.66 s and
115.13 s. Profile admission took 1.194 s, prepared-manifest loading 0.911 s, and
GPU verification 34.086 s (including 63 effect cooks totaling 4.772 s). The
whole diagnostic gate process took 57.176 s including Vitest startup; this is
not a full-Dawn job measurement. Shared-host load varied between samples.

Final PR checks are recorded after execution. Do not treat producer invocation
counts as measured end-to-end SDK time savings.
