# UV coefficients and static material specialization

Observation date: 2026-10-13. Engine integration:
[PR 3855 submission](https://github.com/ForgeaX-Games/forgeax-engine/pull/3855#issuecomment-6149496088),
commit `4cfc84eb9bae0ec1273cc1071dbc37d5b39e5a7f`.
This is a scoped implementation case, not the current PR head or a final
performance acceptance receipt.

## Mechanism and regression boundary

| Change | Concrete owner/evidence | Boundary |
| --- | --- | --- |
| Compute material UV sine/cosine once on CPU from the f32 angle | [Coordinate writer](../../../../packages/render/src/material-texture-coordinates.ts), [actual GPU UV test](../../../../packages/render/src/__tests__/material-texture-coordinates.dawn.test.ts) | Shared 48-byte coordinate record; all affected shader/upload families migrate together |
| Disable material-map and layer work before cooking | [Static graph selection](../../../../packages/types/src/material/static-switches.ts), [real cook tests](../../../../packages/shader-compiler/src/material/__tests__/material-static-switches.integration.test.ts) | Inherited choices retain author declarations; re-enable requires a compatible published child |
| Skip an already successful material upload | [Upload owner](../../../../packages/render/src/record/material-uniforms.ts), [physical-page regression](../../../../packages/render/src/__tests__/material-upload-storage.unit.test.ts) | Exact context/physical allocation; intervening contexts, replacement and page growth invalidate reuse |
| Add fixed five-tap Vogel filtering | [Actual GPU test](../../../../packages/render/src/__tests__/shadow-vogel.dawn.test.ts) | Sampling reference and partially lit pixels; independent from caster raster work |
| Change camera/shadow defaults | [Schema default test](../../../../packages/render/src/components/__tests__/directional-three-defaults.unit.test.ts) | New default profile is separate from old fixed-quality benchmark evidence |

The current source may evolve beyond this commit. Read
[Materials and shaders](../materials-shaders.md), [CPU ownership](../cpu-submission.md)
and [Shadows](../shadows.md) for the maintained decision guidance rather than
copying the case's particular settings.

## What was established

The submitted clean commit completed a normal Engine build with 73 workspace
packages and pnpm 12.10.1, plus 364 tests in 21 focused files with no type errors.
Those tests covered selection, publication/admission, layouts, physical-page
reuse, shadow retention and light defaults. The separate Game consumer source
passed its build and full software tests on the earlier feature producer; it
was not current integrated-head live-game evidence.

Earlier feature-only GPU fixtures exercised UV coefficients and Vogel sampling.
The larger earlier Dawn run retained one independent-shadow-frusta plan failure;
Browser/core acceptance remained incomplete. No full integrated-head GPU,
ordinary-game visual acceptance or whole-frame optimization gain was established
by this submission. Its new far/resolution/filter profile could not be compared
as an unchanged-quality A/B against the older capture.

## Offline analysis qualification

The initial toolbox was replayed against retained old-source data:

| Input | Analysis result | Claim |
| --- | --- | --- |
| Host CDP/V8 combat profile | 12,859 samples; 16,397.433 ms profile interval | Real producer format accepted; sampled attribution remains approximate |
| Ordinary browser GPU capture | 192 unique complete frames; 52 semantic pass rows | Completeness retained; dynamic graph/execution indices do not split every sample |
| Same GPU capture, `main` | Nearest-rank p50 7.274496 ms; p95 13.1072 ms | Reproduces the retained baseline summary, not a new timing run or improvement |

The captured Engine was `37888f1356e06811a042c1772886fdcbd7b0124d`,
Game `848dad688c649b7d5906670cd5df174f5220e68a`, under the older
three-cascade 1024/grid-PCF5 profile. Raw profiles/reports stay in private
artifacts, outside this skill. Tool regression fixtures instead preserve the
analytical falsifiers: overlapping intervals, large raw ticks, recursive
symbols, partial/conflicting frames and mismatched quality identities.
