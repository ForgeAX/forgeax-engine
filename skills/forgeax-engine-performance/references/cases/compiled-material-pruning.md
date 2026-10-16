# Compiled material graph pruning

Observation date: 2026-10-14. Implementation `46cab91a7c` is integrated into
[Engine PR 3855](https://github.com/ForgeaX-Games/forgeax-engine/pull/3855).
The matched source baseline is `c17e52a2296cdab52aed7d4ca4ec6dff198fafdb`.
This case records compiler and CPU mechanisms; GPU/FPS acceptance requires its
own current-head runtime evidence.

## What the compiled contract established

The probe recooked the same exported Game soldier author material, rather than
comparing different scenes. Both producers used WebGPU/storage-buffer and the
same default eight-UV compiler profile. Artifact digests were checked against
cooked receipts. This profile's attribute count differs from the Game build's
one-UV profile; do not mix their baselines.

| Matched stock material | Before | After |
| --- | ---: | ---: |
| Selected parameters | 19 | 9 |
| Published scene material row | 864 bytes | 80 bytes |
| Main vertex attributes | 11 | 2 |
| Lexically reachable `selectedMaterial` call sites in the main fragment | 3 | 1 |
| Material UV transform call sites in the main fragment | 0 | 0 |

Disabling alpha clipping selects eight parameters, retains an 80-byte row after
alignment, and gives the rigid shadow writer a position-only input. The scalar
alpha-clipping variant also removes unused stock UV, tangent and object-basis
inputs. Custom Surfaces keep their declared inputs. A zero-weight clearcoat with
an explicit `true` retains dynamic clearcoat work; an omitted choice removes the
layer and its parameters. Textured and skinned cases retain their required ABI.

These are WGSL/receipt facts, not native GPU instructions. A smaller storage row
does not prove that a fragment previously read all 864 bytes, and fewer source
call sites do not prove a proportional GPU-time reduction. Lighting/environment
samples and spatial Vogel rotation remain legitimate shader work.

## Reusable repair boundaries

| Remove work | Existing owner | Regression |
| --- | --- | --- |
| Optional BRDF layers unless explicitly enabled | [Selected static contract](../../../../packages/types/src/material/static-switches.ts) | Omitted/nonzero and explicit-zero weights, inheritance, custom Surface fields |
| Dead map scalars, inputs, temporals and repeated material selection | [Cook](../../../../packages/shader-compiler/src/material/cook.ts), stock shader families | Actual compiler reflection, direct/scene, rigid/skin, temporal and shadow coverage |
| Repeated IOR conversion | [BRDF helper](../../../../packages/shader/src/brdf.wgsl) | Shared dielectric F0 feeds opaque/transmission paths |
| Canonical padding of heterogeneous material rows | [GPU Scene](../../../../packages/render/src/gpu-scene.ts), [address lowering](../../../../packages/shader-compiler/src/material/scene-material-address.ts) | Mixed row strides, second material address, growth, partial upload retry |
| Repeated candidate encoding across views | [View GPU](../../../../packages/render/src/gpu-driven/view-gpu.ts) | Retained topology plus allocation revision; replacement/abort reseeds physical resources |
| Unrelated table growth and bind-group invalidation | GPU Scene and View GPU | Independent material capacity, 16-byte dirty writes, compute/raster resource generations |

`MaterialProgramAbi.materialRow.addressUnitBytes = 16` makes the address meaning
explicit. Legacy row-ordinal scene receipts fail admission instead of silently
reading another material. Keep the selected schema, CPU allocation, WGSL address
conversion, reflection and publication identity together. Ordinary direct-only
programs preserve their own uniform contract.

The CPU queue reconstruction regression proves a mixed 16/32-byte ABI and a
single changed roughness upload of 16 bytes. This is upload work evidence, not a
whole-frame timing result. Material buffer replacement must rebind raster views
while preserving valid compute groups and shadow depth; failed uploads and
aborted views must seed again.

## Verification boundary

Initial affected cache/view/graph regressions passed 45 tests; a matched baseline
passed 49. Initial native readbacks passed 10 checks across color, UV, rigid/skin
and scene material selection. A manual shadow fixture still used a row ordinal;
it was migrated to the published address unit while retaining its two-depth,
clipping, alpha-mask and LOD assertions. The additional stock shadow compilation
suite passed seven checks.

Full package CPU, Browser, Dawn and maintained 60-frame Smoke results belong to
the final integrated PR receipt. Preserve failed and interrupted captures; the
checks above alone do not qualify the complete rendering gate or a Game FPS gain.

## Validation findings added during integration

Removing synthetic variant-identity work preserves 2304 supported public choices
while allowing 2048 unique programs. The independent oracle requires code equality
only when extended lighting has neither cluster nor atmosphere consumers, and
requires distinct code for the remaining effective choices.

An explicit physical-layer fixture must use a real cooked publication; an uncooked
static selection correctly refuses admission. Its normal-incidence emissive
control includes clearcoat's 0.96 energy factor at IOR 1.5. The fixture retains
its original pixel tolerance, complete light-mask cases and Forward/Deferred view
paths. RHI evidence identified an older cooker capability gap: storage-capable
materials omitted rect-light/projector support. The shared context lowerer now
provides those capabilities, and the physical GPU light/channel check passes.

A full CPU capture's resource-cache count failure was reproduced on the original
baseline with forced GC. Byte reuse is a weak hint: collection can legitimately
cause another verified read. Retry/invalidation tests now retain hint referents
while preserving their original exact transport counts; a separate collection
control requires a fresh read and independent caller bytes. This changes the test
conditions, not the production cache's lifetime or memory policy.

## Carry explicit choices through runtime loading

| Integration boundary | Required contract | Evidence |
| --- | --- | --- |
| Authored optional layer | Declare `staticSwitches.clearcoat: true` before cooking; zero may be an animated initial weight | Lab BlueBall cook and gameplay clone |
| Inline pack loader | Preserve static choices and the cooked publication on roots and children | The actual BlueBall loading/admission regression |
| Runtime-created demonstration | Load the cooked opted-in material through Catalog before assigning its handle | Bevy clearcoat production path |
| Native addressing fixture | Compare visible material addresses in 16-byte units; keep Surface candidate addressing independent | Both hardware first-instance modes, LOD, growth and recovery |

Do not compensate for a dropped author choice by enabling layers from runtime
weights. An uncooked default invocation cannot introduce a new static feature;
its author or asset producer must publish that specialization first. Keep the
loader's selected domain and the compiler's selected graph together.
