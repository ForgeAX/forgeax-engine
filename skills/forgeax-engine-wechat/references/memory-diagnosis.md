# Native memory and queue lifetime

Use this page for increasing WASM capacity, an old frame that never completes,
accumulating native fences, or a late `unreachable` after initially healthy frames.
For the first GL/WASM throw and its stack, start with the collectors in
[Android device diagnosis](android-device.md#retrieve-the-original-rust-panic).
For low FPS without growth or failure, use [Performance](performance.md).

## Analyze an existing report first

The [offline analyzer](../scripts/analyze_phone_lifetime.py) consumes the raw
startup `report.json`, not the receiver's `result.json`. It uses Python's standard
library, does not contact a device, and never edits the input. From the skill:

```bash
python3 scripts/analyze_phone_lifetime.py \
  --report /private/before/report.json \
  --report /private/after/report.json \
  --out /private/lifetime-comparison
```

It writes `summary.json` and `summary.md` into a new directory; an existing output
is rejected. Repeat `--report` for more runs. Each report, WASM instance and GL
context remains separate. No instance-to-context association is inferred from
matching numeric IDs. Output preserves source/report hashes, numeric facts and
recognized observation codes; raw messages, stacks, device/account data and
filesystem paths are not copied. Build/byte provenance still comes from the
[ordinary publication check](build.md), not from this analysis.

The default includes startup allocations. For an explicitly chosen comparable
steady-state window, select a cumulative native submit-call boundary:

```bash
python3 scripts/analyze_phone_lifetime.py \
  --report /private/before/report.json \
  --report /private/after/report.json \
  --after-submit 1000 --out /private/lifetime-after-1000
```

Choose the boundary from the actual workload; 1,000 is an example, not a required
warmup. Keep the full run too. A short constant suffix does not cancel earlier
expansion. `capacity-growth-observed` describes extent growth within the selected
samples, not a proved leak. `constant-capacity-observed` describes that finite
window, not an indefinite or whole-process leak-free pass. A full healthy run can
correctly report startup growth followed by a long constant suffix.

`null` means missing, unavailable or invalid, never zero. Clock rollback or duplicate
timestamps, counter reset/saturation, unavailable memory and in-instance capacity
decreases prevent a valid capacity delta. A missing submit counter cannot qualify
a selected submit window. The analyzer retains evidence issues rather than sorting,
interpolating or silently removing those records. It does not return an automatic
rendering or performance acceptance result.

## Read the clocks and limits before the curve

The collectors use `Date.now()` on the target. Relative times use that report's
`startedAt`, when present; otherwise each series explicitly uses its first retained
sample. This matters: the repaired phone plateau began 5.437 seconds after its
first memory sample but 8.438 seconds after the startup report began. Do not mix
those origins or infer input latency from a separate host clock.

WASM samples are approximately one second apart, keep at most 600 rows per instance,
and retain cumulative terminal export counters separately. GL keeps at most 120
rows per context. Timers can be delayed. A final cumulative counter may be newer
than the last timer sample. `droppedSamples` identifies history eviction;
`lifetimeSerialization.droppedSamples` reports further envelope trimming and is
already included in the affected series' dropped counts. Do not add it twice.
Missing GL lifetime history in an older report remains unavailable, not a zero
fence balance. `.sampler` and installation/restoration facts show collector health.

The authority is the existing [WASM collector](../scripts/phone_native_wasm_errors.js),
[GL collector](../scripts/phone_native_gl_errors.js) and
[bounded report serializer](../scripts/phone_startup_report_prefix.js). The analyzer
adds no runtime API and does not retain native objects or pointers. Its tests execute
the real collectors against deterministic JS calls to verify this serialization
boundary; that test is not a native graphics test.

## Separate four measurements

| Measurement | What it supports | What it does not support |
| --- | --- | --- |
| `memory.buffer.byteLength` | Linear-memory capacity and reuse at a fixed high-water extent | Live Rust allocations, JS heap, process RSS, GPU residency, or the declared WASM maximum |
| Native `calls`, `throws`, free-argument bins | Entry attempts and captured synchronous throws; explicit versus finalizer wrapper release | `calls - throws` as success, Promise/Result success, create-minus-free as live GPU allocations |
| GL call/return bins | Native fence creation attempts, non-null/null returns, delete attempts, query/wait status | Identity of individual fences, physical live fences, completed work or GPU duration |
| Ordinary Renderer scene counters/receipts | Completed scene work and generation/world/frame identity | rAF count, display scanout or uninstrumented FPS |

A freed Rust allocation generally returns to the WASM allocator without shrinking
linear memory. Test whether the same workload reuses that capacity. Conversely, a
constant extent alone can contain retained unused objects: combine the curve with
creation/release evidence and a relevant lifecycle regression. Do not patch every
static registry because one finite game run once grew.

WASM export counts cover device-side `createTextureView` and texture-side
`createView` when present. Keep native `destroy`, wrapper `free`, consumed command
buffers, ended passes and completion-ticket free distinct. Signed wasm32 pointer
arguments above 2 GiB are valid; the collector classifies them without retaining
their values. `FinalizationRegistry` availability does not prove callbacks ran;
actual `freeArguments.finalizer` counts provide that evidence.

GL `insideSubmit` means inside the intercepted synchronous
`rhiwgpuqueue_submit` call. `outsideSubmit` is not an ownership label: presentation
can submit within native code without that export. `unknownSubmitDepth` remains
unknown. Do not reinterpret `TIMEOUT_EXPIRED` (37147) as completed; only
`ALREADY_SIGNALED` (37146) or `CONDITION_SATISFIED` (37148) reports a satisfied wait.
The analyzer names the subtraction `fenceSyncCallsMinusDeleteSyncCalls`; it is not
an identified live-object count. Check non-null/null/throw bins and missing counters
before interpreting even that difference.

## Coverage notes are not thrown-call records

The collectors place the first captured native exception in `first` and subsequent
ones in `laterThrows`. In contrast, each context/instance's `failures` describes
collector installation or restoration. Read both. The analyzer groups notes as
coverage unavailable, a later owner preserved, restoration failed, or unknown.

The accepted phone runs had four GL notes: `drawingBufferWidth` and
`drawingBufferHeight` were `accessor-unavailable`; `getExtension` and
`getSupportedExtensions` were `owned-method-replaced`. The collector avoids
invoking arbitrary getters and avoids overwriting a later owner's method during
cleanup. Those four entries were identical before and after the repair. Report
“no captured native throws, with four collector coverage/restoration notes,” not
“zero GL failures.” An absent `first` without an explicit usable `laterThrows` is
not a measured zero; unavailable hooks cannot establish complete coverage.

## Choose the demonstrated owner

1. **Host GL status:** inspect the original status, zero-time wait and later state
   before changing a shader. A same-turn UNSIGNALED → TIMEOUT_EXPIRED → UNSIGNALED
   sequence says nothing about a later event-loop turn. The WeChat import owner
   [wasm.ts](../../../packages/platform-wechat/src/wasm.ts) advances pending native
   observation with `clientWaitSync(sync, 0, 0)` and reports completion only on a
   native satisfied result. Timeouts stay unsignaled; arbitrary values are not
   coerced to success. Keep explicit query/wait/query interventions separate from
   passive lifetime collection.
2. **Native retirement:** an outer WebGL fence may signal while wgpu still retains
   its submission resources. Preserve the real wgpu queue callback, same-device
   polling and FIFO queue Promise. A native throw inside a Rust future can strand
   that Promise; the [RHI completion driver](../../../packages/rhi-wgpu/src/internal/native-completion.ts)
   catches synchronous native polling failures, yields with a bound and frees its
   completion ticket. If native abort also prevents release, retain the original
   and cleanup errors; retire that realm rather than claiming cleanup. `mapAsync`
   must retain its native mapping authority and ordering relative to queue completion.
   Do not add a duplicate fence, mark a receipt complete, or increase App credits
   to conceal missing retirement.
3. **Binding ownership:** if native retirement is healthy but capacity still rises,
   correlate actual repeated creates and wrapper frees. A token registry's strong
   clone must retire with its wrapper; descriptor-only arrays, labels and resource
   clones must stay call-local instead of escaping through `Box::leak`. Existing
   bind groups/pipelines keep their own
   native references after source wrappers are freed. Use the
   [binding lifetime contract](../../../packages/wgpu-wasm/README.md#binding-resource-lifetime)
   and its real WebGL regression, including parse/validation failures and pixels
   sampled after source-wrapper release. An amplified large-label test proves its
   specific owner; it is not the game's memory rate.

Native queue submit already performs maintenance. Queue completion and mapping
also poll the device. Pending resources alone do not show that “wgpu never polls.”
Likewise, disabling finalizers is a deliberate intervention, not evidence that a
phone lacks working finalizers.

## A bounded reproduction that preserves meaning

Reuse the exact ordinary App/World/Catalog publication and native/UI WASM bytes.
Record framebuffer extent, driver, input state and any Browser Host adaptation.
An older scene bundle or UI-only fixture cannot qualify the current whole game.
Start with existing reports; rebuild or rerun only for an unresolved question.

For continued growth, use equal completed-frame batches through normal App
resume/pause. Await actual completion receipts, confirm in-flight work drained,
then repeat the same workload. Keep natural finalization, an optional explicit GC
intervention and native maintenance observations separate. A GL fence outside the
Engine's receipt path is not a drain. Do not substitute a manual rAF/step loop.
Sandboxed Linux Chromium WebGL can reproduce ownership even with a software driver;
it cannot establish phone FPS. An unavailable Mac/phone does not justify speculative
production edits or repeated access requests.

## Qualified historical observations

The offline analyzer was replayed on these retained real reports during the
2026-10-13 repair; only hashes and non-sensitive measurements belong in this skill.
These observations identify a debugging sequence, not universal budgets:

| Run | Measured native capacity | Interpretation |
| --- | --- | --- |
| Original failure, report SHA prefix `dab1fc9d9409` | 222 samples reached 4,294,967,296 B; the first captured WASM throw saw 4,294,901,760 B | Severe late expansion and a native failure; the older report has no passive GL lifetime series, so its fence difference is unavailable |
| Queue repaired, `a9d31dd20`, report `5ecb931b5fc2` | From native submit 1,001 to 9,086: 47,579,136 → 71,499,776 B | Smaller persistent expansion remained even though wrapper finalizers ran and the observed fence-call difference was bounded |
| Bindings repaired, `7c90ac2b04c6`, report `8d909dd29e87` | 46,596,096 B (44.4375 MiB) stayed constant for 383.315 s / 10,034 further native submit calls; 10,013 scene frames passed | No sustained capacity growth in that measured idle scene; no claim about all input, device recreation, process/GPU memory or indefinite stability |

The last run's GL terminal counts were 20,158 create calls and 20,154 delete calls;
its retained 120-sample tail had differences 3–4, with 266 earlier samples evicted.
It ended while the game ran, so this is not a zero-after-drain result. Plot the old
4-GiB failure and a separate local scale for the repaired series; otherwise a
material 24-MiB drift can visually disappear beside the original failure.

Run the deterministic analyzer checks with:

```bash
python3 -m unittest discover -s scripts -p test_analyze_phone_lifetime.py -v
```
