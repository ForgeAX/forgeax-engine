# Extreme slow frames and simulation/render scheduling

## Join the actual slow interval

Start with the longest qualified picture-completion intervals and retain their
exact IDs, timestamps and raw captures. A whole-window CPU ranking selects busy
functions; it does not explain why one picture took hundreds of milliseconds.
Use [Measurement](measurement.md) for workload admission and clock definitions.

| Join | Required evidence |
| --- | --- |
| Loaded source to profile | Immutable build/script digests; source maps when available, otherwise authenticated generated coordinates/excerpts |
| Host, Engine and Render roles | Actual Worker targets and transport marks; Worker creation order alone is insufficient |
| Page/Worker clocks | Exact time origins or paired anchors, offset and uncertainty; never align separate `performance.now()` values directly |
| Simulation to pictures | Distinguish request, publication and fixed-step events; admitted requests and pictures share a frame ID, while fixed-step ticks and World/session/device generations retain their own identities |
| Work to completion | Admission, Worker receive, task start/end, publication, submitted receipt, completed receipt and Host relay |
| Task to sampled functions | Samples whose timestamps fall within the task; report sampling/reordering uncertainty |
| Picture to GPU | Its own device/context/picture/pass receipts and completeness; a neighbor's timing cannot fill a missing row |

Read the existing [Host admission](../../../packages/app/src/execution/host-controller.ts),
[Engine Worker](../../../packages/app/src/execution/engine-worker-runtime.ts)
and [Render transport](../../../packages/app/src/execution/source-render-worker.ts)
owners when resolving these identities. Build a short event table for each
selected interval, including the next picture's work when it overlaps completion.

### Distinguish ready-picture gaps from individual frames

Before naming a long ready-to-ready interval a slow frame, join its endpoint
source frame IDs and every intervening completion, including non-ready receipts.
Report all-completion and ready-picture intervals separately, with non-ready
counts, durations and coverage. Several pending submissions between ready
pictures establish a readiness interruption, not one long CPU task or GPU frame.
Keep that interruption in product acceptance; removing pending intervals cannot
turn a failed continuity target into a pass. Missing intermediate receipts or
unknown pending reasons remain explicit gaps in attribution.

| Pending-reason evidence | Required boundary |
| --- | --- |
| Producer blocker | Capture the first blocker during the actual draw, alongside its readiness decision; bound metadata and reset it for each draw |
| Submitted/completed receipt | Freeze the reason with that frame, World/session and device identity; transport the same value through Worker completion |
| Ready or legacy receipt | Ready clears the reason; absent metadata on a pending legacy receipt means unknown |
| Interpretation | A first blocker is neither an exhaustive blocker list nor exclusive cost attribution; a later mutable `inspect()` cannot fill an earlier receipt |

When an existing error merges several guards, distinguish those guards in its
bounded reason before choosing a repair. For material preparation, a missing
World, missing GUID handle, unavailable pipeline state and wrong asset kind
require different owners. Preserve the actual World index and bounded material
identity in the same receipt; do not create a second diagnostic ledger or infer
an asset-publication failure from a generic availability message. A failed
lookup identifies a branch, not whether publication, alias retirement or an
older retained plan caused it.

## Mark cold gameplay boundaries

Use existing matched completion receipts and passive gameplay observations;
keep the declared window and closing receipt when summarizing a boundary.

| Boundary | Preserve in the result |
| --- | --- |
| First ready, shot or real wall hit | Completed-gap maximum and coverage around the event; distinguish the immutable first-cartridge wall witness from later HUD counters |
| First grenade/skill smoke appearance | A prior zero-zone observation and first positive count in the same World/device window; already-active, absent or truncated smoke remains not observed |
| Visual or causal claim | HUD publication can lag creation, and a zone may be outside the camera. Owner counters and intersecting gaps prove neither visible pixels nor exclusive CPU/GPU cost |

[Existing Frontline collectors](toolbox.md#reuse-live-producers) report cold
warnings without firing a rehearsal shot or adding a loading/LIVE inspection.
The [CPU window adapter](toolbox.md#same-capture-live-and-completed-frame-cpu-windows)
automatically selects observed smoke receipt/gap windows from the same raw capture.
Use an exact same-capture task/native join for attribution; retain missing
coverage instead of filling it from a later ordinary or instrumented run.

## Account for owned native tasks

A `scope-receive` observer registered after application listeners can execute
after the handler has finished. Use it to locate the containing owned native
task; its timestamp is neither message arrival nor handler entry. Read actual
`ThreadControllerImpl::RunTask` start/end events on the marker-authenticated
`pid`/`tid`, with paired clock anchors and their uncertainty. Keep intervening
scheduler tasks when joining a completed send to its preceding draw task.
The [owned-task toolbox entry](toolbox.md#owned-native-tasks-and-closing-receipts)
uses the existing Game analyzer and preserves rejected evidence.

| Native task evidence | Accounting |
| --- | --- |
| Finite nonnegative wall duration and valid thread clocks (`tts >= 0`, `0 <= tdur <= dur`) | Report wall and thread CPU separately; sum thread CPU only for wholly contained, nonoverlapping tasks on the owned thread |
| Missing/nonfinite/negative thread clocks or `tdur > dur` | Retain the valid wall interval and rejected clock fields; thread CPU remains unavailable, rather than zero or a wall-time substitute |
| `X` or matched `B/E` RunTask | Preserve original event indices and endpoints; pair native nesting without synthesizing `X` records |
| Instant `I` RunTask or unmatched `B/E` | An instant has no duration; unmatched starts/ends are unknown trace boundaries and invalidate intersecting windows |
| Invalid wall clock | Keep the rejected row outside duration totals |
| Task crosses the selected window edge | Preserve its complete original clocks as an edge task; never distribute thread CPU uniformly across the wall intersection |
| Nested/overlapping native tasks | Retain ambiguity and withhold an aggregate that would double count clocks |
| Window starts before the owned-thread marker | Mark native coverage left truncated; later ownership cannot attribute the earlier interval |

A Home-installed transport prefix and a later in-trace thread marker are distinct
facts. Join their exact target ID from the retained lifecycle receipt; do not
rename a `:thread:` marker to fit an older `:owned:` parser. A closed lossless
trace still needs exact marker and clean transport-restoration evidence.

`closingFrame` is a separately stored real completion receipt. Include it when
checking window endpoints and completed gaps, using exact World, device
generation, frame ID and completion timestamp. Identical receipts can deduplicate;
conflicting identities/timestamps or missing boundaries refuse the join. If an
analyzer accepts only `frames[]`, create a derived adapter containing that actual
receipt and retain the original files/hashes. Never drop the boundary, invent a
completion time or borrow a neighboring frame.

### Select a late sampled task cohort

When cold-only profiles miss a recurring late gap, reuse the same frozen build
with one explicit delayed CPU+Task window. Send the original READY first; trigger
from its real first-LIVE completion anchor, keeping the entire cold/LIVE receipt
prefix. Record actual trace and profiler request/ack bounds. Time before actual
activation remains unobserved, even when complete picture receipts exist there.

| Admission | Keep or reject |
| --- | --- |
| CPU/native clock | Each original profile endpoint lies in its own measured native CDP RTT bracket; a wide RTT is uncertainty, not a clock offset |
| First sample | Exclude header-to-first-observed-sample time from function ownership; retain the startup hole per realm |
| Exact task cohort | Join source World/device/frame stages, then keep whole endpoint tasks inside both profile headers and the selected observed-sample interval; retain excluded edges and interior holes |
| Source and observers | Freeze actual loaded JS and both source-map levels; identify this capture's inline wrapper/mark script IDs before product rankings |
| Out-of-order samples | Reconstruct original timestamp/sample pairs, order them without rescaling, and keep reordered weights separate from stable weights |

A submitted-containing task is an endpoint cohort, not all asynchronous Renderer
work. Keep receive, preparation continuations and completion delivery separate.
A later same-build profile can select a recurring owner; it cannot fill the CPU
stacks of an earlier capture's exact long gap. The
[late-window case](cases/late-task-clock-boundaries-20261017.md) records a successful
cohort whose large startup holes happened to end before its first selected task.

### Scoped Frontline task case, 2026-10-16

The committed task report
joins Game `cdf3ec2` / Engine `e317195` in one intrusive 4.028-second LIVE CPU
capture. The 164 draw-tagged Render tasks included 159 valid thread-clock rows
and five invalid thread-clock rows. In the exact World/device interval from completed frame
1098 to 1099, the Host completion gap was 41.700 ms. The preceding Render draw
task, tagged with frame 1100, consumed 25.919 ms wall / 24.891 ms valid thread CPU;
frame 1099's completed send followed its end by 0.123 ms. Sampling inside that
actual task attributed 23.855 ms to script and 1.497 ms to GC.

This establishes CPU work overlapping delayed completion notification. It does
not establish exclusive frame cost, GPU execution/serialization or an ordinary
FPS gain. The separate 75.100 ms cold gap from frames 929 to 930 has complete CPU
sample coverage but precedes owned native-task markers; its cause remains
unresolved. The original closing-receipt omission was repaired only in a derived
adapter; raw report, frame and profile bytes remained unchanged.

## Split the gap between draw tasks

An idle Render thread can be waiting for the next publication while the Engine
thread produces it. Join adjacent draw IDs in the same native trace, then split
the gap at actual Host dispatch, Engine task start and publication begin/end.

| Gap segment | Evidence before selecting a change |
| --- | --- |
| Before Host dispatch | Resolve the exact previous simulation and older Render completion required by the captured publication capacity; ACK send bounds do not establish Host arrival or ledger eligibility |
| Engine production and publication | Separate task wall time from synchronous `postMessage` work; the Render task may start before the publication wrapper ends |
| After publication | Inspect owned native tasks, including incremental GC outside the draw task, before calling the residual transport latency |

The [native-gap analyzer](toolbox.md#native-gaps-between-adjacent-draws) preserves
disjoint wall segments and actual overlapping production. The scoped
Frontline evidence
rejected treating the whole inter-draw gap as removable scheduling overhead.
Composite receipt completion includes software delivery and ordered retirement;
it does not isolate GPU hardware readiness or justify enlarging publication slots.

## Explain the dominant duration

| Observed pattern | Next discriminating measurement |
| --- | --- |
| Sampled hotspot explains only a few ms of a very long interval | Get real task wall/thread clocks and transport events before optimizing that hotspot |
| Task wall greatly exceeds valid thread CPU | Inspect preemption, task gaps, async waits and concurrent host load; do not label the residual GPU time |
| Task wall and thread CPU are both high | Attribute functions inside that exact task; check repeated preparation, allocation and submitted work counts |
| Submitted-to-completed wait overlaps a following Render task | Measure that task and notification delivery separately from actual GPU execution |
| A long picture interval contains many short simulation tasks | Keep task boundaries; it is not one large Engine update or one large physics step |
| Four physics steps repeatedly follow Render backpressure | Measure simulation admission gaps, steps/update and new dropped time; inspect scheduling before changing physics delta |

CPU sample weights remain approximate attribution, including when their sum
looks precise; use [native task accounting](#account-for-owned-native-tasks)
for exact wall/thread-clock validity and window containment.

Cross-thread overlap is not a serial frame budget. Sum only compatible scopes
with a stated purpose; keep inclusive parent/child timers separate. CPU task
duration, completion-notification latency and GPU pass duration are distinct
observations. Report the unexplained interval when evidence cannot assign it.

A public zero-fallback counter excludes only observed fallback activity in its
covered population. It neither measures successful-query duration nor attributes
a preceding unprofiled stall. A later CPU capture that misses the original long
interval cannot explain that interval through its new hotspot ranking. Preserve
the original failure and obtain only the missing owner identity or bounded
timing evidence; the [full-scene case](cases/full-scene-resources-20261016.md#cold-boundaries-and-unexplained-time)
keeps this distinction for an un-reproduced 1.25-second gap.

## Use controls to choose the next owner

Prefer the cheapest experiment that distinguishes current hypotheses; exhaustive
binary search is optional. Add opt-in controls at existing behavior boundaries,
with defaults preserving production behavior and bounded cleanup. Capture the
same source, initial state, actions, quality and correctness guards; inventory
what each control changes. Remove observers/hooks on stop or failure.

A control disabling collision, shadows, destruction or publication changes work
and often state evolution. Its faster result supports sensitivity to that path;
it is not an equivalent-behavior optimization or additive subsystem CPU share.
Restore the original behavior for final correctness and ordinary performance
measurement. Keep concurrent owners of GC, terrain or other subsystems explicit.

## Preserve publication backpressure before World updates

When render completion gates World updates, a backlog can increase Host deltas,
force catch-up bursts and drop simulation time. Measure and reduce the work
holding that credit. Keep simulation admission bounded by the existing Render
publication capacity; a faster simulation counter does not establish faster
completed gameplay pictures.

Continuing World updates while skipping publication changes observable behavior:
short-lived entities can disappear before rendering, and bounded VFX tick intents
can overflow while simulation keeps producing them. It is not an equivalent
performance optimization.

| Boundary | Required invariant and regression |
| --- | --- |
| Simulation admission | Check actual publication capacity before input/camera/World mutation; two occupied slots block the next update |
| Sealed publication | Count both the consuming picture and its sealed successor, including publications not yet GPU submitted |
| Credit release | Submission alone retains the slot; successful completion and buffer recycle reopen capacity and admit one due update |
| Bounded effects | Preserve each admitted update's publication and ordered effects; do not replace missing intermediate events with only the latest World state |
| IDs and feedback | Every healthy admitted simulation frame publishes with the same frame ID; feedback reads its exact sealed picture, and simulation completion is not GPU completion |
| Pause/resume and recovery | Temporal reset reaches actual publication; known render loss follows the existing recovery freeze, World identity and resource retirement |

The source publisher owns sealed storage. Host admission uses the existing frame
credit and completed prefix: this count is valid because every admitted frame
publishes with the same ID. Recovery retires the lost epoch's completed simulation
prefix while preserving the one request still in flight. A Host tick waiting for
publication capacity is not an issued frame awaiting admission. Keep the real GPU
timeout and generation fences with their current owners.

Keep the existing fixed timestep, accumulation cap and dropped-time policy unless
the task explicitly changes simulation semantics. Ten overdue steps capped at
four are not four steps with 2.5 times the delta. A larger delta changes contacts,
controllers and collision behavior. Report fixed steps/second, steps/update and
the increase in dropped time alongside rendered intervals; improved simulation
cadence alone is not a whole-game FPS gain.

The [firefight case](cases/firefight-physics-scheduling.md) retains a measured
native gain, two unexplained/partially explained extreme intervals and their
acceptance boundaries.

## Follow the stopped-fire tail

Use [Destruction update chain](destruction.md) to measure delayed work in the
same World, distinguish physical edits from presentation notifications, and
check whether support and publication queues actually converge after firing.
