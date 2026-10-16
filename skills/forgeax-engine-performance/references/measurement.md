# Measurement and comparison

## Admit a comparable workload

| Record | Why it affects the comparison |
| --- | --- |
| Engine/Game/Voxel revisions, dirty state, build/publication digests | Source, cooked programs and the loaded runtime can differ |
| Runtime/backend, adapter/driver, device generation, OS/browser | Software rendering and a different backend are different targets |
| Resolution/DPR, camera/route, actor count, AI/combat/destruction, input timeline | Rendered pixels and simulated work determine cost |
| Camera near/far, shadow coverage/cascades/map size/filter/bias, material features | A lower quality or shorter range is a different profile |
| Warmup, sampling duration, completed frames, queue/drain bounds, missing rows | Submitted callbacks do not prove completed scene work |
| Instrumentation and simultaneous CPU/GPU/memory/thermal observations | A profiler, query, readback or competing workload can change timing |

Source revisions are expected to differ in A/B. The workload identity should
contain the invariant scene, quality, backend and measurement configuration;
record revision/build evidence beside it. Do not omit a setting merely to make
`compare_samples.mjs` accept the two identities. Use alternating paired runs
when order, warm caches or thermal drift matter; report group results as well as
their aggregate.

> [!IMPORTANT]
> Build success, complete sampling and hardware performance are separate claims.
> Rejected, timed-out, partial and contended captures remain evidence of their
> failure; they are not silently discarded observations of a successful run.

### Inherit the product profile before adding test controls

Build the diagnostic configuration from the complete selected product profile,
then apply the explicitly requested health, duration or input controls. Record
requested and applied features, including cosmetic effects and environment.
A test preset that silently drops smoke, gunfire or sky is a different workload,
even when its resolution, ground and shadow fields match. After a content update,
reconcile the collector's effect roster, preparation and workload assertions with
the actual weapons, abilities and environment; an old muzzle-only assertion
cannot qualify newly restored full effects.

For fresh-player-default acceptance, resolve the application's real defaults and
enter a fresh browser context without writing quality storage or selecting a
render profile/stage in the URL. Validate the applied HUD settings and actual FX
owner as usual. An explicitly selected performance profile is a separate entry,
even when its current settings happen to equal the default. The
[Frontline default-entry case](cases/full-scene-resources-20261016.md#fresh-default-entry-and-smoke-preparation)
retains the concrete factory and driver correction.

| Control | Required boundary |
| --- | --- |
| Invulnerability or fixed-duration combat | Explicit diagnostic option and receipt; ordinary performance mode keeps normal damage and finite ammunition |
| Reduced rendering or omitted effects | Separately named diagnostic profile; retain the full product profile for final acceptance |
| Ready/first-shot/first-wall and smoke-appearance observation | Passive existing completed-frame/HUD evidence; no rehearsal shot, added LIVE wait or post-window event used to fill a missing boundary |
| Native factory/queue observation | Separate bounded diagnostic; preserve exact build, program, descriptor, device and clock joins |

### Qualify the readiness owner

| Evidence | Readiness established |
| --- | --- |
| Asset residency or program publication | CPU resource/metadata admission only |
| Synchronous native module factory return | A returned module handle; compilation readiness remains unobserved |
| Settled async native PSO request | That device's exact requested shader/layout/state/target variant |
| Completed presentation marked ready | The owners actually admitted for that frame/view; verify explicit hidden requests also enter the real preparation path |
| Observed queue completion | Coverage through its matching submission identity; an unsettled disposal tail stays right-censored |

Keep cold-boundary warnings in the ordinary CLI/report by default, while
intrusive Native/CPU/GPU collection stays separately requested. A missing,
truncated or post-window observation cannot qualify a boundary. Native device
handles and public device generations need an observed mapping, not a guessed
numeric alias. The [full-scene cold-readiness case](cases/full-scene-resources-20261016.md#full-profile-cold-readiness-and-passive-warnings)
retains the actual transparent-lane counterexample and collector revisions.

### Replay compatibility before a long capture

Check publication schema, cooked material ABI, receipt/layout identities and
buffer ownership against the selected runtime before replaying a full tape.
Freeze the tested PR head and loaded build; recheck freshness when reporting.
The [cache maintenance case](cases/cache-maintenance-20261014.md) retained a
672-byte material-row tape rejected by a later 864-byte consumer.

| Observation | Comparison boundary |
| --- | --- |
| Original packets accepted by both runtimes with complete receipts and equivalent output | Matched replay can isolate the renderer path; source World/physics are excluded |
| Old cooked ABI rejected; materials recooked or packets transformed | New workload identity; same author files do not establish identical packets or programs |
| Replay consumes prebuilt publications | Receiver/preparation work is measured; publisher change detection, key construction and asset transfer preparation require a live producer window |

Keep a rejected replay's structured error. Recollect through the actual producer
when its contract changes; forcing a fallback lane or reducing the scene does
not restore a valid A/B. Replay scheduling also matters: mesh ACK serialization
or different outstanding completion credits can change throughput.

For an offline collector that interns POD graphs, decode references within each
message's local node table before selecting global definitions. Restore declared
buffer capacity when the storage codec trims trailing zero bytes. That artifact
codec is not evidence that production Worker transport compresses each frame.

## Use the correct clock and denominator

| Observation | Supports | Does not establish |
| --- | --- | --- |
| CPU stage timer | Elapsed time in that stage on that execution path | GPU execution or additive total when scopes overlap |
| Valid task thread-CPU clock / dedicated thread-CPU replay | CPU consumed by that task/thread within the selected boundary | Other threads, GPU work or wall-clock scheduling delay |
| CDP/V8 samples | Approximate sampled leaf and inclusive CPU attribution | Exact invocation cost, unminified ownership without mappings, GPU time |
| GPU timestamp boundaries | Measured pass interval on one device clock | Display scanout, CPU wait or exclusive whole-frame cost |
| Sum of pass durations | Repeated measured interval coverage | Frame latency when envelopes/scopes overlap |
| Union of measured intervals | Covered portion of the GPU timestamp timeline | Unmeasured work, attribution of gaps or display latency |
| First-to-last timestamp envelope | Measured timeline span including gaps | Exclusive active GPU work |
| Ordinary Renderer completion receipts | CPU-observed completion throughput/intervals | Browser callback FPS, display scanout or native GPU duration |
| Hit rate | Hits divided by its explicitly named lookup population | Commands avoided, setup cost avoided or final frame improvement |

Shared begin ticks or enclosing GPU scopes can make several pass durations
cover the same interval. Inspect their raw boundaries before treating a large
sum as costly execution. Interval union and envelope are diagnostic timestamp
coverage, not device utilization, total GPU busy time or completed-frame latency.

Inclusive CPU symbols overlap. A recursive function contributes once per sample
in the generic analyzer, while different ancestors still share that sample.
`(program)`, idle and unobserved profile spans are not inferred GPU execution.
For Host/Engine/Render Workers, keep each profile's time origin and execution
owner; overlapping worker CPU is not serial wall-clock latency.
For extreme intervals, [join exact tasks and completion events](slow-frames.md)
and reject invalid thread-clock rows before treating task CPU as exact evidence.

### Cache populations and window deltas

Sample cumulative owner counters before and after warmup/measurement boundaries.
Require matching owner/device generations and retained-view identities; a reset
or replaced roster needs separate windows, not a negative delta clamped to zero.
Last-frame fields support a last-frame statement only. Window rates require
monotonic cumulative counts or actual per-frame observations.

Define $H$ and $M$ at the actual cache decision:
$\mathrm{hitRate}=H/(H+M)$ and $\mathrm{missRate}=M/(H+M)$.
Keep bypasses separate. With no eligible lookups, the rate is unavailable rather
than zero. A miss includes first construction; it is not necessarily an
invalidation of an existing entry.

| Population | Counters/denominator to retain | Common misreading |
| --- | --- | --- |
| Prepared rows and filtered assembly | Row/batch checks, hits, rebases, builds, candidates visited and publication fast-path hits | High row reuse means the entire frame walk was skipped |
| Graph/plan | Actual queries, reuse, build/compile attempts, failures and reason markers | Several queries per frame mean hit rate equals frames without rebuilds; overlapping reason markers are exclusive causes |
| Generic command segments and prepared bundles | Separate owner hit/build/record/execute/eviction counts | A low-traffic generic cache describes the active prepared path |
| Static and final shadow layers | Per-view decisions, hits, rebuilds, draw commands and invalidation reasons | Dynamic final-layer misses imply static retention is unused |
| UBO | Content-pack reuse, backing-capacity reuse, exact-target upload skips, slot count, queue calls and bytes | Repacking bytes implies reallocating storage; storage reuse implies no upload |
| Resource residency | Mesh/texture/sampler ensure decisions, cold/upgrade attempts and receiver allocations | Validation-cache misses or mesh-prepare messages equal physical GPU residency misses |
| Publication templates | Eligible hits/misses, entity-owned bypasses, all upserts and emitted templates | Frame-local template interning is a cross-frame cache; overall deduplication equals lookup hit rate |

For template interning, report both eligible $H/(H+M)$ and total reduction
$1-\mathrm{templates}/\mathrm{upserts}$ with their own populations. Record active
typed-view bytes, backing capacity, actual transfer-list bytes/objects and mesh
control counts separately. Transfer detaches owned buffers; capacity totals do
not prove copied/compressed bytes or network bandwidth.

Label renderer-frame deltas, source packet revisions, submitted/completed frames
and completed intervals separately. Before/after inspector round trips and
in-flight publications may leave a small boundary difference. Record it and
normalize each observation to its own population; use an exact identity join or
drain when identical-frame attribution is required. Never divide one window's
CPU estimate by another window's lookup count to claim measured hit-path cost.

Derived counts need a proven branch identity, such as one capacity lookup per
eligible payload pack minus observed allocations. Verify native/probe count
equalities and document the derivation. An uninstalled or unused probe returning
zero is missing coverage, not evidence that no work occurred.

### Keep observation cost separate

Prefer native cumulative counters, then narrowly placed allocation-free integer
probes for missing decisions. Save probe coverage, original/transformed hashes
and the probe revision loaded by the capture. Authenticate injected decision
sites through the actual source maps; inspect minifier-folded conditions rather
than treating absent source-shaped statements as zero events.

| Measurement | Required interpretation |
| --- | --- |
| Per-call timers on a hot cache walk | Count invocations and calibrate an empty probe; many tiny calls can make the observer dominate. Keep raw results rather than subtracting a guessed overhead |
| Independent uninstrumented V8 profile | Keep realm time origins; clip individual sample timeDeltas to the measured completion window, checking clock alignment rather than using whole-profile duration |
| Minified profile attribution | Authenticate loaded JS, intermediate compiled modules and original source; retain unavailable maps as unmapped, not invented source locations |
| Cache-owner grouping | State owner scopes and exclude ordinary draw generation from enclosing cache callbacks; preserve native/unattributed, idle and GC separately |
| Sparse samples | Report sample count and detection limits; zero samples do not establish zero cost |

Collect final throughput without diagnostic probes/profilers. If CPU sampling
and counters use separate warmed runs, label both windows and retain workload
checks for each. Repeated runs show dynamic-phase variability; they become A/B
only when their workload and instrumentation identities admit comparison.

## Check work and cost together

| Mechanism | Preserve alongside timing |
| --- | --- |
| RenderBundle/prepared reuse | Lookups, records, commands, comparisons, builds, executed/direct work and invalidation causes |
| Material/data upload | Queue calls, bytes, dirty ranges, slot/physical-page count and replacements |
| Scene/terrain publication | Changed regions, queue depth/latency, worker jobs, completed revisions and rejected mutations |
| Allocation/GC | Samples in GC, allocations where available, heap/resource high-water and lifecycle retirement |
| Physics | Steps/update, fixed delta, dropped time, native phases, awake bodies, compound leaves, contacts and wake/publication work; [interpretation](physics.md) |
| Shader specialization | Cooked macro/layout/binding/program differences, real draws and pixels |
| GPU pass optimization | Pass presence, execution counts, measured/partial/dropped/failed observations and precision |

Report count, mean, nearest-rank p50/p95/p99/max and unit for raw samples. A
zero baseline has no meaningful percentage ratio. Unequal counts and absent
passes remain visible; missing observations must not become zero-duration work.
Keep benchmark repetitions distinct from the maintained correctness frame gate.

For lower-is-better timing, improvement is
$100(t_{before}-t_{after})/t_{before}$. A faster isolated stage is not the same
as whole-frame gain: CPU/GPU overlap, pacing and another bottleneck can limit
throughput. Use uninstrumented ordinary completion measurements to make that
claim. Descriptive percentiles alone do not establish statistical significance.

## Validate an optimization batch

Preserve the user's scene, features and stopping criteria. Choose the smallest
owner regression and complete producer A/B that can falsify the change; include
preparation, maintenance, transfer, receiving and retirement where affected.
Verify that Before and After actually load different implementations. Retain
invalid comparisons and rejected candidates, including work counts that improve
while net CPU or retained memory regresses. Do not repeat a rejected mechanism
without new evidence that changes its cost boundary. A small or inconsistent
saving can be withdrawn immediately; do not expand the matrix to obtain a green
number. Keep timed owner comparisons clear of official cooks, typechecks and
other CPU/memory runners. If overlap is discovered afterward, retain it as an
unqualified timing observation rather than rerunning a rejected candidate.

| Boundary | Next validation |
| --- | --- |
| Several verified changes address the same measured workload | Freeze their integrated source/build once, then run one representative ordinary window; separate probes and profiling |
| User reports first wall-hit stalls and sustained combat | Include the real cold shot/wall event and subsequent visible combat/tail in that window; do not pre-fire to erase the cold boundary |
| New map, asset library, shader ABI or quality configuration | Re-inventory actual loaded objects/materials, cooked bytes and feature policy; establish a new baseline rather than inheriting an older scene's result |
| User changes task scope or permits disabling a feature | Record the new profile and validate the requested outcome; retain earlier failures under their original scope |

Actor counts, resolution, shadow taps and window lengths in the
[full-scene case](cases/full-scene-resources-20261016.md) are its workload,
not Engine-wide gates. A component gain can ship with honest target acceptance
pending; it does not authorize claiming the integrated game's FPS.

## Capture and ownership

Use the existing producer's completeness/admission checks before these offline
summaries. Retain device/context/frame identity and await bounded query readback;
keep unavailable capability separate from failed collection. Do not change a
GPU lease, timeout, workload or acceptance threshold to obtain a green result.

Use the current official GPU scheduling path when a live experiment needs it.
Observe other sessions before launching work; close only processes whose
ownership and existing authorization are established. An old browser process
can contain a new active tab. Headroom observations must overlap the measured
interval, and a historical GPU snapshot does not identify current contention.

Existing target-specific collectors are routed in [Toolbox](toolbox.md).
