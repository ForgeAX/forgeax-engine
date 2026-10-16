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

## Explain the dominant duration

| Observed pattern | Next discriminating measurement |
| --- | --- |
| Sampled hotspot explains only a few ms of a very long interval | Get real task wall/thread clocks and transport events before optimizing that hotspot |
| Task wall greatly exceeds valid thread CPU | Inspect preemption, task gaps, async waits and concurrent host load; do not label the residual GPU time |
| Task wall and thread CPU are both high | Attribute functions inside that exact task; check repeated preparation, allocation and submitted work counts |
| Submitted-to-completed wait overlaps a following Render task | Measure that task and notification delivery separately from actual GPU execution |
| A long picture interval contains many short simulation tasks | Keep task boundaries; it is not one large Engine update or one large physics step |
| Four physics steps repeatedly follow Render backpressure | Measure simulation admission gaps, steps/update and new dropped time; inspect scheduling before changing physics delta |

Validate clock rows before accounting: reject negative durations or a thread
duration greater than its wall duration for the claimed exact scope. Retain
the rejected rows and use valid owners' evidence. CPU sample weights remain
approximate attribution, including when their sum looks precise.

Cross-thread overlap is not a serial frame budget. Sum only compatible scopes
with a stated purpose; keep inclusive parent/child timers separate. CPU task
duration, completion-notification latency and GPU pass duration are distinct
observations. Report the unexplained interval when evidence cannot assign it.

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

Observe sustained destruction and a long stopped-input window in the same World.
Record pending/completed publications, support seeds/plans, fragments, active
shapes and retained proxies alongside frame/task costs. Distinguish a genuine
physical terrain cut from fragment-only or decorative updates before reseeding
static support; visual bounds cannot stand in for changed bearing geometry.
Preserve wake, navigation and presentation consumers that still need the event.

A slice budget does not bound an unyielded whole-queue snapshot at job startup.
Use the existing queue's insertion/replacement lifetime to read only encountered
entries while preserving older retry fairness and newer edit causes across
yields. Test a large unrelated backlog, replacement before/after a yield and
actual Native publication. Keep the original failed candidate; fewer sampled
hotspots do not prove that accumulating work or late low FPS has recovered.
