# Full-scene resource updates: cold work and retained ownership

Observation: 2026-10-15/16, Voxel Frontline. These results qualify their named
owners and frozen workloads. Current source and requested settings take
precedence. Comparison rules remain in [Measurement](../measurement.md), memory
accounting in [GC](../gc.md), and attribution in [Slow frames](../slow-frames.md).

## Re-inventory after content changes

The frozen full-scene report
uses Game `7aef88e7`, Engine `92c9cf8f` and the new reconstructed Dust2 content.
It records 23,512 author parts, 20,258 unique meshes and 2,307 author materials.
Author counts are not runtime draws or admitted shader counts. Inspect the
actual loader, grouping, selected material policy and recursive asset references;
an explicit ground-material preload list does not bound the entire registry,
and the full author material library is not evidence that every material loaded.

| Frozen workload | Result and limit |
| --- | --- |
| 5v5, original ground, 1920x1080, three 1024 five-tap cascades, GTAO; destruction disabled | Ordinary LIVE 55.17 FPS, minimum rolling second 0.798 FPS, maximum interval 1252.8 ms; workload passed, performance target failed |
| Separate eight-second CPU diagnostic of that build | Original 1252.8 ms interval did not recur; retain its failure rather than transferring attribution from the diagnostic |
| Later integrated resource/Engine updates | Integration report explicitly retained pending ordinary acceptance; previous-scene results were not inherited |

Those actor, quality and duration choices belong to this user request. They are
not a default acceptance matrix for other games. Batch the relevant owner fixes
before one real cold-wall/visible-combat/tail window; run intrusive diagnostics
separately when they answer a specific remaining unknown.

## Retained static projection

Game f91ce981
stopped retaining `Source.complete` after static prepared geometry was packed.
The canonical Float64 geometry remained available for later exact projections;
accepted MeshAssets, geometry, materials, collision and recovery were preserved.

| Same complete geometry producer | Before | After |
| --- | ---: | ---: |
| Logical retained complete-projection bytes | 363,032,296 | 0 |
| After-projection, after-GC Node heapUsed bytes | 1,003,394,832 | 547,724,320 |
| Canonical prepared bytes | 334,709,716 | 334,709,716 |

The corrected report
retains identical full projection hashes, real part/material order and isolated
process checkpoints. Logical bytes and heap deltas overlap; do not add them.
This establishes retained-memory reduction, not browser FPS, RSS savings, or a
fix for the independently recorded cold stall.

## Decoded source roots and render readiness

[Engine 4004](../../../../packages/assets-runtime/reports/mesh-geometry-source-read-20261016.json)
adds `AssetRegistry.readMeshGeometry(guid)` for independently owned base geometry
processing. It uses the published Pack/artifact decoder and invalidation fences,
while ordinary `loadByGuid` continues to admit the complete render dependency
closure. The source result preserves attributes, indices, submeshes and AABB;
it carries no Asset `kind` or Ready receipt. A retained custom decoder cannot
share mutable storage with this result.

The frozen resource producer read all 20,258 published Mesh roots after the same
25 complete ground Material loads. The ordinary path admitted 40 additional
default materials, for 65 total; the 2,307 author override library was not the
Mesh default dependency population. Every geometry field and typed-array byte
had the same digest under both paths.

| Live Registry after processing and GC, bytes | Complete Asset loads | Geometry source reads |
| --- | ---: | ---: |
| Published Mesh vertex/index buffers retained in catalog | 225,489,222 | 0 |
| Incremental Node heapUsed plus arrayBuffers | 688,220,318 | 17,045,752 |

The 671,174,566-byte normalized reduction includes the Mesh buffers; do not add
those rows. Each variant ran in a fresh Node process with three GC/event-loop
turns around the measured phase. One full pair reduced CPU time from 11,165.129
to 8,219.687 ms but increased wall time from 7,224.855 to 8,244.553 ms. Accept the
retention result; this pair does not establish stable throughput or browser GC.

Game 332ed95c
uses the new official SDK for reconstructed Dust2 source processing. Author
material overrides still use complete Asset loads in the original profile;
performance ground materials retain the same full admission. Prepared geometry,
collision, navigation and appearance stay unchanged. Eight Engine ownership,
integrity and lifecycle contracts plus two Game material/projection/cancellation
contracts passed. The Game typecheck passed; ordinary browser acceptance remains
separate.

> [!IMPORTANT]
> A geometry-only read is not permission to render an incomplete Asset or bypass
> dependency readiness during a mode switch. Load required material/LOD resources
> through their ordinary owner. Reclaiming a source reference does not retire an
> accepted Mesh, Native collider, shared handle or GPU resource.

## Cold boundaries and unexplained time

| Main implementation/evidence | Established outcome | Remaining limit |
| --- | --- | --- |
| [Engine 3988 PCM owner report](../../../../packages/audio-webaudio/reports/clip-preparation-owner-20261015.json) and Game integration | Prepare exact clips before battle admission through bounded Host PCM jobs; real OfflineAudioContext contracts reused decoded buffers with zero preparation voices | Encoded asset preload alone had not decoded PCM; native audio proof is separate from first-shot frame attribution |
| [Engine 3998 source-fact report](../../../../packages/shader/reports/material-program-comment-scan-20261016.json) | Fresh ShaderRegistry admission of 362 SHA-verified cooked WGSL sources: 236.69 to 127.36 ms median, 8/8 alternating pair wins, all admitted facts equal | Empty parameter schema isolates source facts; no GPU/pipeline or whole-game FPS claim. Invalid initial same-implementation A/B is retained |
| Frozen full-scene ordinary and CPU reports above | Public navigation fallback counters did not grow around the 1252.8 ms interval; later CPU observed a different 153.4 ms gap | Zero fallbacks do not measure successful-query cost. Shader metadata and module samples from the other gap cannot explain the earlier unprofiled interval |

The later opt-in Game collector
adds `PERF_PROGRAM_ADMISSIONS=1` to that Game's bounded cold CPU path. It observes
owned Worker messages without rewriting publication, records exact program and
resource identities, joins actual frame receipts, reports truncation, and removes
its listeners on disposal. Its named diagnostic script and metadata allocation
add observation cost. Focused contracts passed; real browser collection was not
part of that tool's delivery. Arrival alone is not proof of accepted admission.

## Pose and publication change frequency

The same-capture Engine 4000 LIVE slice selected animation and publication as
owners. Its nested spans and diagnostic observer costs are not additive product
costs. Later comparisons used nine actual 65-joint character meshes/skeletons and
three clips, 60 Hz roots, 30 Hz visual poses, a shared synthetic frozen pbr-skin
material and no static map. Each five-pair comparison completed 60 measured frames
per variant/pair plus 12 warm frames through World, animation, publisher, normal
structured-clone transfer, persistent RhiNull completion and ACK/recycle.

| Owner and receipt | Removed work | Complete-owner outcome |
| --- | --- | --- |
| [Animation f32 writes, Engine 4006](../../../../packages/animation/reports/unchanged-transform-owner-20261016.json) | Submit sampled TRS vectors only when their f32 destination changes; keep clocks, cues and sampling | CPU median 252.027 to 231.495 ms per 60 frames, 5/5 wins. Transform calls 18,090 to 7,785-7,818; field writes 36,180 to 10,086-10,149 |
| [Accepted skin dependencies, Engine 4007](../../../../packages/render/reports/retained-skin-consumers-owner-20261016.json) | Keep joint-to-skin subscriptions when full joint handles/order are equal; own the accepted list independently of packet metadata | On the 4006 baseline, CPU median 224.945 to 218.507 ms, 5/5 wins. New dependency Sets 35,040 to zero per 60 frames |
| [Rejected private WASM baseline](../../../../packages/render/reports/owned-skin-geometry-rejected-20261016.json) | Store the private geometry baseline beside SIMD scratch to avoid copying that second input on every exact live comparison | Initial saving 4.33%; final saving 1.64%, about 0.063 ms/frame. Added snapshot ownership and under 128 KiB extra committed space per cache were rejected for that small absolute saving |

The accepted changes preserve identical final local/world pose and skin-bounds
hashes, 540 template upserts per measured block and nine retained records.
Animation contracts cover current-column restoration after author edits, f32
blends, signed zero, NaN writes, clocks/cues and target rebinding. Publication
contracts cover shared joints, rebind, Skin removal, entity replacement, discard
and packet aliases. These proofs qualify the CPU owners, not browser/GPU FPS,
retained-heap reduction, a GC pause fix or the earlier ordinary long gaps.

## Internal snapshots and graph program lifetime

[Scene presentation, Engine 4011](../../../../packages/scene/reports/borrowed-presentation-owner-20261016.json)
removed full Transform component materialization and detached Children snapshots
only from the synchronous sampler. TRS typed views already borrowed their column
bytes; their backing data was not copied. The fixed-pose history still copies its
inputs. A nine-character complete owner
used the actual 65-joint GLBs and three clips, public interpolated roots driven
by synthetic FixedUpdate motion, one shared synthetic skin material, and no
static map or Native physics. Five interleaved 60-frame pairs without World.get/
set counters reduced median thread CPU from 377.172 to 264.564 ms, 5/5 wins.
Local/world pose and skin-bounds hashes remained equal, with 540 upserts and nine
records per measured block. A separate probe counted about 64.5k TRS and 36.2k
Children snapshot reads removed per block. The TRS count denotes component
object/field-view materializations, rather than copies of backing bytes. Reparenting, teleports, catch-up,
external author copies and current child animation have distinct contracts.

[Deferred lighting, Engine 4010](../../../../packages/render/reports/retained-deferred-program-owner-20261016.json)
kept immutable PSOs/layouts within their live device generation while graph views
and bind groups retained graph lifetime. Complete World/publication/transfer/Null
completion with actual AR/USP/MP7 meshes and materials showed startup lighting
PSOs 2 to 1 and first-switch PSOs 1 to 0. All observed native descriptors,
including shader source and bind-group layouts, had the same SHA. Other repeated
pipeline labels had different descriptors and were left alone. These are work
and structural-owner proofs; no real GPU compilation duration, pixels or FPS was
measured for either contribution.

## Reject local wins that do not survive the producer

Use a full affected chain, including World changes, publication/transfer,
receiver and retirement when changed. Keep identical output and workload checks.
The retained Game negative results
preserve a rejected changed-Transform span traversal despite fewer row scans.
The raw results remain available alongside successful implementations.

The [rejected 16 MiB material frontend cache](../../../../packages/shader-compiler/reports/material-pack-frontend-rejected-20261016.json)
kept only 13-14 of one material's 20 contexts: four real GUIDs caused 80 misses
in 80 lookups. Complete Native Pack cook median CPU regressed 5.98%, with no
pair wins, despite equal output hashes and passing contracts. Measure the
working set and complete maintenance/serialization cost before selecting a
budget; this rejects that implementation, not an independently measured larger
working-set design. A later [fixed 64 MiB owner](../../../../packages/shader-compiler/reports/material-pack-working-set-20261016.json)
qualified its own complete-cook saving (22.21%, four pair wins); neither receipt
is a runtime/FPS result.

Cache/build reuse follows the same ownership rule. [Engine 3994](../../../../packages/import/reports/pack-native-free-dependency-20261016.json)
narrows dependencies only for proven native-free products; Native/custom/nested
cookers keep the full relevant registry identity, source closure and external
evidence checks. A migration or real shader/authoring dependency change can
legitimately miss. Pure Render runtime changes are not themselves a reason to
re-cook unchanged resources or bypass source validation.

## Project shader cache invalidation

The [read-only DDC audit](../../../../packages/import/reports/project-shader-ddc-invalidation-20261016.json)
compared Game `11c5bc9b`/Engine `d4e2052c` with Game `25356fe5`/Engine `31553897`.
The first build had 92 Pack hits. During the second build, per-Pack decisions
were 67 hits and 25 misses, rather than 92 misses; preflight and execution logged
some decisions twice. Completion time and a new runtime result were still
pending at the audit's observation point.

| Input checked | Observed boundary |
| --- | --- |
| Dust2 material-00 and its source producer | Source bytes unchanged; old/new DDC keys differed |
| Executing shader compiler, naga, shader, Pack material cook, types and VFX compiler JS | All six SHA-256 pairs equal; Native compiler fingerprints equal too |
| Project shader namespace | Merge `8fd53547` added `assets/shaders/gunshot-billboard.wgsl` |
| Product cache selection | Native-free mesh/audio retained hits; Native material products used the changed registry identity |

`createMaterialPackCooker.cacheIdentity()` hashes all collected WGSL records
before receiving a material input. The Pack discovery row records output kinds
and whether a product is native-free, without a per-material shader dependency
witness. The addition therefore invalidated unchanged map material products.
The audit made no cache-key, artifact, producer or runtime change. A future
scoped identity must also admit the current catalog and preserve entry, slot,
conditional import, transitive dependency and backend-variant semantics; the
presence of an old source-closure list alone cannot authorize a cache hit.

## Keep preparation distinct from per-view work

The [frame-local cascade owner](../../../../packages/render/reports/frame-local-cascade-preparation-20261016.json)
used the existing [same-capture CPU window tool](../toolbox.md#same-capture-live-and-completed-frame-cpu-windows)
to separate loading from 4,004.5 ms of actual LIVE. Paired page/CDP anchors
identified Render Worker request-key construction as a repeated owner; the
loading-inclusive ranking was not used as LIVE evidence.

A complete public World/publication/transfer/receiver/Null producer used the
restored 88-material, 344-chunk, 2,715-range scene and three 1,024 shadow cascades.
Only successful native preparation requests with identical PSO facts and the
same batch address were shared within one stock frame. View culling, depth
draws, pending requests and subsequent frames retain their own work. Four
interleaved 60-frame pairs reduced median thread CPU from 906.645 to 770.615 ms
(15.00%, 4/4 wins), including the temporary roster and comparisons. Calls fell
from 8,155 to 2,715 per frame; native pipeline creation was not removed.
An earlier context-to-encoder handle handoff saved no requests and lost all four
pairs, so it was withdrawn. These results prove the complete CPU owner, not
GPU execution time, image equivalence or ordinary combat FPS.

The follow-up [per-layer graph demand owner](../../../../packages/render/reports/shadow-graph-preparation-demand-20261016.json)
removed ordinary preparation when the same graph's retained depth layer would
not raster. Its pure decision shares the actual execute condition; queries do
not promote depth or consume first-execution state. Explicit hidden-resource
requests still prepare, and dynamic final layers remain independent of static
hits. The full 88-material scene plus nine existing mesh casters translated
every frame retained 335 static casters and three dirty 53-batch final views.
Four complete 60-frame pairs reduced median CPU from 877.399 to 723.995 ms
(17.48%, 4/4 wins); ordinary requests fell 2,757 to 95 per frame. These are
equivalent moving casters, not measured character animation or combat FPS.
Canonical Terrain's extra receiver targets can re-record a logical GPU view;
the current graph-demand optimization keeps their full preparation path.

## Preserve surface math while reducing batch fragmentation

The scene series first used per-vertex authored parameters, then an
exact nearest-sampled RGBA32Float table.
The cross-mode owner
then shared two compatible algorithm families. All 7,080,645 original corner position/normal/UV0/tangent words and
surface math remained qualified; 25 ground, eight sandstone and eleven
transmission materials kept their original assets and states. This reduced 44
eligible families to two, effective assets from 88 to 46, and ranges from 2,715
to 821 across the same 344 scene records. Material counts, ranges and native
commands are different quantities: passes, views and submission lanes determine
the actual draw and PSO work.

The complete public World/publication/transfer/receiver/Null completion owner
used real cooked records and three cascades. Six matched-camera 120-frame
samples in separate bounded processes reduced median CPU from 2,004.124 to
616.727 ms (69.23%); this was not an interleaved-process A/B or a pixel test.
Startup projection instead cost another 284.348 ms, with 216,624 extra bytes
including the table. Ordinary surfaces grew from two to four texture loads,
and ceramic surfaces add three more. Exact parameters and fewer CPU batches do
not make those GPU loads free.

The subsequent ordinary capture
of Game `c58a00d0`/Engine `6f0beb59` recorded LIVE 58.84 FPS, rolling minimum
45.36 and maximum 50.4 ms: the requested stability still failed. A separate
195-complete-frame GPU diagnostic
measured timestamp-envelope p50/p95 10.748/14.352 ms with no read failures or
dropped samples. Concurrent CPU work was allowed there, so its completed-frame
intervals are not ordinary FPS. Overlapping passes must not be added together;
neither result attributes a different capture's long interval.

## Full-profile cold readiness and passive warnings

The later canonical basic-shot profile restored 96 bounded flash/tracer/impact
slots. This is a different workload from the earlier effects-off captures;
restoring all authored effects is another profile change. Construct the test
from that full product profile before adding explicit invulnerability or fixed
LIVE duration. Preserve ordinary damage, ammunition, scene and effect budgets
outside those diagnostic overrides.

The same-capture Native report, Game 11885ceb
bound the actual `mesh/shot-hot` and `material/shot-hot` slots to their program.
That program was published at source frame 713 before the ready receipt, yet
native module creation began 193.9 ms after ready; the exact async PSO began
263.9 ms after ready and settled another 23.4 ms later. Earlier publication did
not establish native readiness. Its instrumented 156.7 ms completed interval
overlapped those events; this does not attribute the separate ordinary 103.6 ms
interval or prove the compiler exclusively consumed the gap.

[Engine 4045's hidden transparent owner](../../../../packages/render/reports/hidden-transparent-preparation-20261016.json)
found two admission gates: sorted transparency skipped an empty visible
selection, and main geometry also required a visible draw. A hidden-only roster
therefore reported ready without preparing its authored PSO. The complete
World/publication/transfer/persistent-Null producer retained 96 actual slots,
no shadow participation and a controlled async completion:

| State | Before | After |
| --- | --- | --- |
| Hidden loading while the native request is held | Ready, no pending request | Pending through all four observed frames |
| First actual visibility | Three pending presentations, one new PSO | Three ready presentations, zero new PSOs |
| Hidden preparation raster | No useful preparation | Zero transparent rasters; preparation opens no attachments or draw bindings |

The existing device-owned resolver retains shader/layout/state/view and failure
ownership. Visible glass in the full map could make the pass run and mask the
hidden-only defect. The report separately joins the same exact real Native
program; it does not establish post-fix ordinary FPS or every weighted-OIT
hidden-topology case.

Game 0cf238c6's collector report
made ready/first-shot/first-wall completed-gap warnings ordinary CLI/report
output. The passive owner is installed before deployment and summarized after
the measured window, using existing callbacks without delaying LIVE or adding
native factory, CPU or GPU timestamp probes. `PERF_FIRST_SHOT=0` explicitly
disables it; inapplicable or incomplete captures retain `notObserved`.
The eeb74bf4 closing-window correction
refuses a first wall event after the measured closing receipt, even if a later
camera/FX tail observes it.

Native observation remains an explicit `PERF_NATIVE_PIPELINES=1` diagnostic,
separate from ordinary FPS and CPU/task/heap probes. The immutable reports bind
raw files, collector hashes and loaded runtime separately. They retain two
unsettled queue-completion calls as right-censored: observed submission coverage
is not a duration, an exact GPU-frame join, or proof of an entirely drained GPU.
A public completion receipt proves its public device generation; native
`deviceId` alone supplies no alias. Apply the same identity and coverage limits
when reusing these collectors on another build.

## Full effects: program, publication and preparation lifetimes

> [!IMPORTANT]
> Fewer native creations establish removed work, not completed-frame acceptance.
> Requalify the restored product profile after batching owner changes.

The full-profile ordinary capture
used Game `e6dcf28c`/Engine `ea1ff4b8`, full authored presentation and normal
ammunition/reloads, with no CPU, native-factory or GPU-timestamp probes. LIVE was
24.44 FPS, rolling minimum 16.43 and maximum completed gap 253.3 ms; stability
still failed. The earlier 1,386.8 ms gap did not recur in this capture, which does
not prove its cause was removed. This was not a matched A/B: the declared low
smoke compositor changed from nine to five samples. The earlier basic-shot and
effects-off profiles cannot supply its baseline.

| Actual owner | Qualified work removal | Reuse boundary and evidence limit |
| --- | --- | --- |
| [Volume programs, Engine 4051](../../../../packages/render/reports/retained-volume-program-owner-20261016.json) | Four stages each created 21 PSOs on the original device across graph changes; each fell to one, with one per stage on each recovered device | Retain immutable programs/layouts in the live DeviceScope. Keep graph targets, groups and temporal histories local. The real Renderer/Null lifecycle producer proves creation counts, not native compile time or FPS. |
| [Color stage, Engine 4054](../../../../packages/render/reports/color-stage-device-lifetime-20261016.json) | Across 24 complete fresh-graph executions, PSO/layout/sampler creation fell from 24 to one; module-factory requests stayed 24 | Consult the current factory module witness, exact source, device, factory method, format and sample count. Pending/invalidation cannot reuse an old PSO. Bind current input views and LUT resources. The original native population was 441 late PSOs, not 441 modules; CPU samples were mixed. |
| [Authored material publication, Engine 4055](../../../../packages/vfx-render/reports/vfx-authored-material-publication-20261017.json) | Feature V8 serialization size fell from 1,425,344 to 235,392 bytes; the complete producer's bounded CPU comparison fell 26.21% | Omit only duplicated cooked metadata with an exact captured-reference witness. Preserve fresh author fields and the normal asset/program dependency closure. V8 size is not browser wire size; one comparison with concurrent build activity does not establish FPS. |
| [Mixed particle projection, Engine 4057](../../../../packages/vfx-render/reports/vfx-mixed-material-projection-20261017.json) | The same owner's next bounded comparison reduced feature V8 size from 235,392 to 87,290 bytes and CPU by 6.00% | Only the stock provider can omit ordinary raster programs from particle frame projection. Preserve authored state, non-raster programs and dependency publication. Do not add these separate CPU percentages or extrapolate them to whole-game throughput. |

The [shader change, Engine 4050](../../../../packages/shader/reports/volume-composite-vacuum-low-profile-20261016.json)
kept the default/high nine-sample path and specialized the declared low profile
to five samples. Its exact vacuum shortcut requires every retained optical
neighbor to equal `[0, 0, 0, 1]`; a vacuum center beside non-vacuum smoke is not
sufficient. The controlled native compositor readback/timing owner does not
qualify a full game's pixels or FPS. No later three-sample result is covered
by these measurements.

The publication optimization does not treat a MaterialAsset object as immutable.
Its cooked field must be an enumerable own data property and the accepted
capture must match exactly; accessors, missing witnesses and mismatches retain
the original inline form. Mutable authored fields are captured again, including
in-place changes. A prior deeply-frozen-reference candidate captured zero of 11
materials and removed no payload. A comparison with changed cooked-pack hashes
was also rejected before the retained byte-identical comparison.

Mixed modern/legacy particle admission supplies a separate falsifier: classify
all original programs before pruning. If removing ordinary raster entries would
change that classification, retain the full projection and its original
admission behavior. Custom instance or prototype projection providers retain
their own output. A smaller packet must not silently select another ABI or turn
an existing admission failure into success.

Game 7d1cd6ab's loading preparation owner
separates temporary Players from retained programs. The actual deployment's
completed presentation-ready acknowledgment retires 24 loading-only Players;
feature-source ACK alone is insufficient. Actual playing effects keep explicit
preparation requests, so cache eviction or device recovery still gates their
presentation. The complete public producer retained zero idle preparation
Players and observed zero new factory requests on the qualified first-use
recipes. A held async raster request stayed pending for four frames before
ready; actual Null Renderer device generation 0 to 1 also passed through pending
before ready. These counts and recovery checks are stronger than assuming a
fixed number of warmup frames, but are not hardware GPU or ordinary FPS proof.
A later [published brick-material owner](../../../../packages/vfx-render/reports/public-warm-retirement-owner-20261017.json)
kept actual group-1 binding qualification and native factory counts across
paused loading, retirement, live effects and asynchronous preparation. Its
normal closure and controlled delayed-retirement cases passed while the real
game still reported a missing brick-material GUID handle. Keep such negative
controls: they reject blindly adding more warm Players, but do not establish
that the full Worker transport, Standard graph or native driver has the same
lifetime behavior. Only a matching failing owner and a repaired ordinary capture
can close the product interruption.
A permanently paused three-recipe pool had added about 3.3 ms/frame of idle CPU
and was rejected; do not generalize program retention into permanent Player
retention.

## Fresh default entry and smoke preparation

Game 60915bab
corrected `PERF_DEFAULT_SETTINGS=1`: expected settings come from
`createPresentationSettings().value`; the fresh context writes no quality
storage and removes both inherited `renderProfile` and `renderStage` URL
parameters. Explicit profile/stage/settings-file selection conflicts with this
entry. Actual performance HUD, quality and full-FX checks still run. Six focused
contracts and syntax checks passed; this tool delivery itself ran no browser or
FPS test.

The smoke CPU preparation report, Game 91028409
moved a fixed mask, half-float palette and one real terrain query into loading.
The queried mask is immediately discarded: every actual cloud clips against
current terrain and owns its own density bytes. Two fresh-process observations
on the authored map measured first construction 28.15 ms before and 2.83 ms after
27.93 ms of explicit loading preparation; these were not a matched ordinary FPS
A/B. Live terrain/color mutation and byte-equivalent density contracts keep the
preparation from reusing a stale smoke shape.

The later small VFX owners use the same completed public producer, including
loading retirement and nine actual firing schedules. Their separate reductions
must not be added or inherited as whole-game FPS:

| Owner report | Complete producer result and boundary |
| --- | --- |
| [Immutable logical bindings, Engine 4074](../../../../packages/vfx-render/reports/vfx-immutable-binding-layouts-20261017.json) | CPU -7.19%; raw inline mutation, provider fallback, retry and recovery retained; an initial separate-Render-bundle fixture lacked ownership qualification |
| [Shared compute programs, Engine 4076](../../../../packages/vfx-render/reports/vfx-shared-compute-programs-20261017.json) | CPU -8.76%; representative program counts 106/114 became 14/21 while Player storage and actual dispatch/ACK remained independent |
| [Static no-upload buffers, Engine 4078](../../../../packages/vfx-render/reports/vfx-static-buffer-layouts-20261017.json) | CPU -5.40%; only exact owned metadata reused, with 337/355 representative upload declarations still fresh; no concurrent official cook or timed runner |

## Bilateral AO: qualify the shader operation on the actual backend

The [native AO report](../../../../packages/shader/reports/ssao-bilateral-rejected-20261016.json)
retains two rejected candidates on Chrome/Apple Metal 3. Both used the actual
GTAO32 calculation and bilateral shader at 1080p, with identical half-resolution
raw AO/depth/normal inputs in eight analytic scenes. Four paired timestamp
batches alternated order after warming; readback, errors and source hashes remain
in the report. These are controlled shader results, separate from game pixels
and ordinary FPS.

| Candidate | Pixel result | Native blur result and decision |
| --- | --- | --- |
| Medium/low center plus six symmetric pairs, fixed pixel-parity phases over the original 5x5 extent | High25 and repeated inputs were exact; thin foreground and recessed tiles exceeded the predeclared error bounds. Recessed active-AO p95 error was 0.0353 and maximum error 0.1373 on the [0,1] visibility scale. | 25-tap median 0.3059 ms to 13-tap 0.3619 ms; all four pairs regressed. Reverted. |
| Keep all 25 taps; replace nonnegative normal agreement raised to eight with three squarings | Every medium/high readback was byte-identical in all eight scenes. | Median 0.3067 ms to 0.3123 ms; all four pairs regressed. Reverted. |

Retain contact-band and thin-feature error populations when reducing spatial
samples; a mostly empty full image hides local loss. Fixed spatial sampling can
remain temporally deterministic while degrading a single frame. Qualify
arithmetic rewrites on the backend too: fewer source operations or texture
samples do not establish less GPU work. The original whole-game pass-boundary
span cannot be substituted for this isolated pass timing or summed with
concurrent passes. Preserve the negative result and move to another owner.

## Scene batching has several independent populations

These Game/Voxel changes retain the complete authored map and ordinary public
rendering boundary. Their CPU fixtures include source World, publication,
transfer, persistent Null Renderer, completion and ACK; they do not execute the
real browser AI/motor or measure native GPU time. The following rows have
different frozen workloads and must not be added into a frame saving.

| Actual owner and durable receipt | Measured work and outcome | Falsifier or cost |
| --- | --- | --- |
| Opaque static aggregation | Keep 344 native/query bodies, combine 316 known opaque draw bodies into 19 spatial batches and leave 28 other bodies unchanged. Published rows 401 to 104, mesh assets 360 to 63, topology batches 832 to 242; two complete-owner CPU pairs fell 17.45% and 20.79%. | Visibility-only hiding retained source draws: rows 401 to 420 and topology 832 to 951; rejected. Accepted aggregation retains original geometry for edits/recovery and adds 134,261,312 packed VB/IB bytes plus 25,751,496 CPU position bytes; these declared arrays are not total residency. |
| Grass collection regrouping | Change 47 spatial collections to 18, preserving all 1,424 world-space f32 matrices bit for bit. Published rows 105 to 76; two complete-owner CPU pairs fell 2.37% and 6.89%. | GPU topology 242, candidates 1,665 and encoded draws 114 all stayed equal: the grass already shared a GPU batch. Source-verified per-instance culling remains; no native pixel/GPU/FPS saving was measured. |
| Held-weapon loading retirement | Clear explicit pipeline preparation for the admitted 35-entity local/remote held roster after completed loading readiness. Preserve meshes/materials/entities, and rearm newly selected or replaced meshes. | This retires a loading request, not an invisible weapon's dependency or draw authority. The public complete-owner result does not prove ordinary FPS or device-recovery pixels. |
| Rejected firearm material batching | Actual M4/M249/MK14 material and adjacency constraints reduced topology 31 to 27 and encoded draws 53 to 45. CPU pairs disagreed: -17.3% and +2.8%. | Startup modules 115 to 119, PSOs 35 to 57 and geometry increased. A same-family material label did not prove equal textures/state. Retain the negative result; no runtime asset change was merged. |

Game e4e95e16
also avoids decoding 94,422,152 bytes of attributes that the static aggregate
constructor immediately discarded. Packed output and CPU geometry hashes remain
equal. This is an allocation/constructor result, not an extra steady-state frame
saving to add to the table.

The later qualified ordinary wall capture
uses Game `632e34c1`, Engine `73fbfcd1` and Voxel `a99deca6`, including opaque
aggregation, shared tracer Instances and held preparation retirement, before the
grass regrouping. Complete authored presentation, 1080p, three 1024 five-tap
Vogel cascades, medium GTAO and five-sample smoke were retained. Thirty LIVE
seconds with normal nine-bot ammunition/reloads and explicit player-only test
ammo/invulnerability produced 41.02 completed FPS, rolling minimum 26.57 FPS and
maximum interval 123.5 ms. All ten actors fired and stayed alive; pressure shots
hit terrain 298/298 times. The cold ready/first-shot/first-wall neighborhood
still reached 63.5 ms. The performance target remained unmet; this is a fresh
baseline rather than a causal percentage A/B against an earlier camera path.

> [!IMPORTANT]
> Count actual effects in the measured owner before accepting a speedup. A
> plausible logical shot count can coexist with zero visible muzzle Players
> when a fixture's camera and eye position disagree and the real safety gate
> correctly rejects them. Require exercised emitter/retirement evidence at the
> changed boundary; repairing that fixture starts a new qualified comparison.

## Exact skinned vertex welding

An upstream replacement of all eight character bodies retained 42 clips and
the shared Biped, but increased authored geometry. The receiving Game branch
kept those new bodies and welded only byte-identical complete shader inputs
offline. Position, normal, tangent, palette UV, joint indices and weights all
participated; hard shading, color and deformation seams remained distinct.

| Source observation | Before | After |
| --- | ---: | ---: |
| Unique attribute rows across eight assets | 284,140 | 155,059 |
| GLB bytes | 22,533,696 | 13,239,840 |
| Ordered triangle corners | 426,210 | 426,210 |

The Game report
retains the incoming revision, per-asset hashes and actual checks. Its
read-only comparison tool
compares every indexed corner's six streams, plus unchanged hierarchy, material,
image, inverse-bind and animation data. Whole-Game type checking and the focused
asset checks passed. A separate upstream firearm clipping test timed out at its
unchanged five-second limit; the batch did not claim an entirely green suite.

This removed 45.43% of source vertex rows and 41.24% of GLB storage without
approximate decimation. Triangle count stayed unchanged. GPU post-transform
cache behavior, actual vertex shader invocations and product FPS were not
measured by this asset proof; do not promote its row reduction into a GPU/FPS
percentage. Rebuild and ordinary workload acceptance remain separate work.

### Inspect the decoded geometry and optimization admission

A shared glTF accessor does not guarantee one receiving vertex stream. In a
later normal built AssetRegistry/Scene/World probe, two material primitives
expanded the full source accessor twice. The 15,230-row source role became a
30,460-row MeshAsset; its position, joint-index and weight streams exceeded the
existing 1 MiB bounds-cache gate. Three real-pose calls never entered the
conservative envelope path, while six other roles did. A sampled function's
entry coordinate alone had not established that branch.

Before changing a cache limit, inspect the actual decoded attribute lengths,
backing-buffer kinds, mutable-input contract, renderer policy and admission
branch. Compare each primitive's referenced rows with its full accessor. An
exact per-primitive row projection can remove unused imported rows while
retaining ordered triangle-corner shader inputs and material ranges; prove
those bytes, skin/animation data and actual receiving admission before claiming
a runtime or FPS improvement. Source-file welding and smaller GLB bytes do not
by themselves prove that an existing runtime optimization remains enabled.

The subsequent Game correction
kept all 426,210 triangle corners and six input streams byte-identical, retained
skin/animation/material data, and left the other six GLBs unchanged. The two
receiving meshes returned to 15,230 and 15,822 rows and passed the existing
conservative-cache admission in three actual-pose calls. On eight real imported
skins, 200-round bounds-function CPU pairs changed from 185.223/185.696 ms to
63.522/63.601 ms. The cache limit was unchanged; whole Engine Worker and product
FPS gains still required separate measurement.
