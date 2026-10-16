# GPU-process CPU investigation

The 2026-10-13 hardware investigation
retains the source-bound traces, calibration, actual Mac RHI frame and screenshots.
The later candidate comparison
adds bounded physical pages, lower decoder service cost and a sequential gameplay
improvement. Neither stage qualifies stable 60 FPS or isolated hardware performance.

Use this when hardware WebGL gameplay has long submission-to-completion latency
but the page's rAF, timers and V8 work do not explain it. A Chrome process named
"GPU" also executes CPU command decoding, validation and ANGLE translation.
Machine-wide CPU idle can coexist with a saturated serial GPU-service thread.

Keep the [gameplay workload](gameplay-performance.md) and qualified
[host capacity](performance.md#host-capacity-first) fixed. Choose the cheapest
hardware WebGL environment that reproduces the symptom; use the simulator or
phone again when validating a host-specific fix. These are separate diagnostic
runs, not a replacement for uninstrumented acceptance on the requested target.

## Narrow the owner before changing rendering

| Evidence | Next useful action |
| --- | --- |
| Late App receipt, prompt rAF/timers | Trace the GPU process as well as the Renderer process; V8 idle is not GPU execution time. |
| Long GPU-main `CommandBufferService:PutChanged` with similar thread CPU time | Inspect command-level decoder scopes, then the native CPU path. |
| Short service tasks but delayed visible fences | Follow [completion timing](completion-timing.md); distinguish status visibility, native ticket readiness and App delivery. |
| Prompt receipts but slow frame supply | Measure [Host request/callback timing](completion-timing.md#host-request-timing-when-receipts-are-prompt) before changing receipt credit or rendering. |
| One GL draw family dominates | Capture the real frame with [RHI Debug](rhi-capture.md), including resources and generated shaders. A draw also performs deferred state preparation. |
| A specific conversion/allocation is suspected | Vary one resource/layout fact in a small pixel-checked experiment, then test the owning Engine change in the ordinary game. |

Do not raise the App in-flight limit to conceal receipt latency. It explains how
latency throttles new work, not why completion is late. Use the existing
[GPU-query guide](browser-gameplay-gpu.md) for timer interpretation: correlated
submit/present query scalars are not additive GPU busy time, and ANGLE query
boundaries are intrusive. Repeating query measurements cannot reveal an
unmeasured GPU-process CPU hotspot.

## Capture CPU service work

Use the owned browser's existing CDP connection and the same ordinary gameplay
runner. A bounded four-second trace is sufficient for a repeated per-frame cost.
Retain `Tracing.tracingComplete`, read its stream through `IO.read` to EOF, then
close the stream. Preserve a successfully written trace even if runner cleanup
is delayed; wait for the actual terminal result before declaring cleanup failure.

Start with these categories:

```text
toplevel,gpu,disabled-by-default-gpu.service,devtools.timeline,blink.user_timing,renderer.scheduler
```

Use process/thread metadata to identify `CrGpuMain`, `VizCompositorThread` and
`CrRendererMain`; do not reuse another run's PIDs. Inspect outer
`ThreadControllerImpl::RunTask`, `CommandBufferService:PutChanged` and
`CommandBufferStub::PerformWork` scopes. Their durations are nested, so summing
all rows double-counts work. Compare `dur` (wall time) with `tdur` (thread CPU
clock) where present. For a clipped window, report thread CPU from fully contained
scopes or a justified bound; do not prorate boundary CPU time. Small differences
between the two trace clocks are not exact blocking durations.

When PutChanged is dominant but opaque, add `disabled-by-default-gpu.decoder` in
a separate short run. This selects the decoder's DebugImpl path and emits one
service scope per command; it adds recording work. The texture verification
helper contains DCHECK-only checks that may disappear in release builds.
Keep `disabled-by-default-gpu.device` disabled: the inspected GPUTracer creates
hardware timers only for that category, whereas GPU service tracing records CPU
scopes. Check the actual retained categories rather than assuming the request
was honored.

If command names still do not identify the CPU function, sample only the owned
GPU process with macOS `sample <pid> 7 1 -file <output>`, independently of tracing.
Use the live browser's `SystemInfo.getProcessInfo` and process ancestry to select
it. Samples are statistical observations over that entire capture, not exact
milliseconds or a four-second gameplay window. Stripped `ChromeMain + offset`
stacks do not name ANGLE functions. A symbol lookup needs the exact Framework
UUID; avoid an open-ended symbol download when a command-level trace can answer
the question sooner.

## Reusable offline decoder parser

[analyze_chromium_gpu_decoder.mjs](../scripts/analyze_chromium_gpu_decoder.mjs)
reads an ordinary Chrome JSON trace and writes a compact command ranking. It
launches no browser, performs no network request and changes no device state.

```sh
node skills/forgeax-engine-wechat/scripts/analyze_chromium_gpu_decoder.mjs \
  --trace /tmp/chromium-trace.json --output /tmp/decoder-analysis.json
```

The decoder's begin events still use category
`disabled-by-default-gpu.service`; `args.gl_category` identifies
`disabled-by-default-gpu.decoder`. Ends may omit args. The parser pairs reused
and nested IDs with per-process/thread/name/ID stacks, keeps different threads
separate, reports truncated/malformed coverage and preserves valid zero-duration
spans. Missing decoder evidence returns `unavailable`, not zero cost. An unclosed
tail returns `partial` while retaining completed scopes.

To compare marked calibration cases, use unique `performance.mark` names:

```sh
node skills/forgeax-engine-wechat/scripts/analyze_chromium_gpu_decoder.mjs \
  --trace /tmp/chromium-trace.json --output /tmp/case-analysis.json \
  --begin-mark case-begin --end-mark case-end
```

Alternatively use `--start-us` and `--end-us` in the trace's microsecond clock.
For the gameplay runner, translate its `performance.now` window with the actual
`forgeax-gameplay-arm` mark and `clockAlignment.traceMarkMs`:

```text
traceStartUs = mark.ts + 1000 * (report.clockAlignment.startMs - report.clockAlignment.traceMarkMs)
traceEndUs   = mark.ts + 1000 * (report.clockAlignment.endMs   - report.clockAlignment.traceMarkMs)
```

Retain the reported alignment uncertainty. Do not include the recorder's lead-in
or infer a missing report window from nominal duration. Command sums clip wall
time at window boundaries; percentiles use fully contained spans only. Output
includes the input byte count and SHA-256. It has no FPS field or exclusive CPU
claim; potentially nested scopes remain inclusive.

## Uniform backing size can dominate tiny bindings

Keep these three facts separate when inspecting an RHI capture:

| Fact | Meaning |
| --- | --- |
| Backing buffer size | Total allocated bytes behind the GPU buffer |
| Bound window and effective offset | Bytes exposed by the binding after dynamic offsets |
| Shader stdSize | The reflected std140 size of the actual active uniform block |

Neither backing size nor bound-window size determines stdSize. Shader variants
can prune/reorder members. Capture the real pipeline's shader along with the
buffer descriptor, bind group, dynamic offsets and preceding writes.

On the pinned ANGLE Metal implementation, a std140-to-Metal layout mismatch can
invoke CPU uniform conversion inside a draw. `ConvertUniformBufferData` converts
all bytes from the cached initial offset to the backing buffer's end, not just
the bound window. Small writes invalidate cached conversions. Cache reuse depends
on program, block and offset; sharing across offsets requires their difference
to be divisible by the actual stdSize.

A compact falsifier uses a mat2 uniform (std140 column stride 16 versus Metal 8)
and a vec4-padded control that computes the same result. Bind the same actual
48-byte range, vary only total backing size, and compare four-byte dirty writes
against unchanged data. Warm each case, check identical pixels and GL errors,
and measure the marked indexed-draw service scopes. An asynchronous fence drain
keeps previous work from leaking into the next case. Such drains and tracing
belong to the calibration, not normal gameplay acceptance.

Verified on 2026-10-13, Apple M4 Pro / ANGLE Metal, 12 draws per case:

| Backing size | mat2 + 4 B write/frame, service p50 | Same backing, vec4 control | Same backing, unchanged mat2 |
| --- | ---: | ---: | ---: |
| 64 KiB | 0.2015 ms | 0.0710 ms | 0.0915 ms |
| 1 MiB | 0.7505 ms | 0.0660 ms | 0.0645 ms |
| 4 MiB | 3.8355 ms | 0.0560 ms | 0.0625 ms |

All 16 cases, including the 48-byte baseline, had the same checked pixel,
48-byte binding and zero GL errors. The experiment reproduced the conversion
mechanism; its ratios are not game FPS gains. The ordinary game trace separately
showed about 2.78 seconds of indexed-draw service work in four seconds. The
actual Mac baseline RHI capture
found a 1,310,720-byte material buffer, an 1184-byte binding window and writes
spanning only the active slots. The earlier Linux SwiftShader run checked capture
integration separately; it is not the hardware evidence. **1184 is not proof of
stdSize.**

The evidence supports bounding backing allocation/conversion work at its owner,
while preserving dynamic-offset alignment, shader minimum binding sizes,
residency, cache identity and retirement. Verify the implementation with the same
scene, UI, effects and input schedule. A smaller microbenchmark or a changed view
cannot establish the game's improvement.

## Close the loop without merging evidence types

The sandboxed candidate Mac capture
replaced the large arenas with actual 15,360-byte material pages and 16,384-byte
mesh pages while retaining the binding windows. Main works 75/79 used the second
material page; shadow works 13/35/57 used the second mesh page. The 21 main indexed
draws and 19,200-byte material write volume survived. Inspect actual cross-page
bindings, offsets and writes, not only a configured page-size constant. Successful
60-frame startup, artifact export/release and Host disposal establish this
structural path; seed=0 replay pixels remain unqualified.

Two captures may differ because one refreshes the UI and another reuses its
cached texture. Here `ui-clear-target-0` and `ui-raster-strip-0` explain the extra
two passes and one draw; both frames retain the final UI composite and the same
79 indexed scene draws. Match pass/resource evidence before interpreting fewer
work items as missing rendering or a performance optimization. Every fresh
Playwright Chromium launch must explicitly set `chromiumSandbox: true`; a wrapper
that omits it needs a corrected capture, even when the image is complete.

The separate candidate decoder trace
recorded 19,160 indexed commands / 292.028 ms of inclusive CPU-service wall time,
versus baseline 7,439 / 2,776.527 ms. Complete PutChanged batches containing indexed
work fell from 33.969 to 2.189 ms median. Command counts differ; batches need not
map one-to-one to frames. Retain clipped boundary totals separately from contained
percentiles and disclose the baseline's unclosed trace tail. These observations
support lower service cost but do not identify each native conversion call or
per-shader cache hit. Do not add nested batch/command scopes or GPU-query scalars.

The ordinary corrected 40-second workload then measured 24.150 FPS baseline and
58.875 FPS candidate, an observed 2.437888x ratio. Both runs retained identical
input timelines, 2,401/2,401 acknowledged snapshots, neutral grounded final state
and drained receipts. Candidate ran first and baseline later on the same Mac;
this was one sequence with other machine work present. The candidate's minimum
rolling second was 56, p99 35.700 ms and maximum 51.950 ms, so it did not pass
stable 60 FPS. A screenshot's displayed 60.0 is not that acceptance gate.

Align headroom using `performance.timeOrigin + clockAlignment.startMs/endMs`,
retain clock uncertainty, and exclude startup, idle tails and partly overlapping
CPU intervals. The measured total-device GPU utilization includes the tested
game: 83% candidate versus 63% baseline medians are not background-only load.
Whole-machine CPU idle also cannot rule out a busy serial driver thread. Require
independent attribution before calling such samples isolated hardware capacity.
For an uncommitted candidate, record the base plus exact source-file hashes and
publication identity; never relabel those results with a later committed HEAD.

## Pinned source and scope

Chrome reported `155.0.8059.40`; its public DEPS selects ANGLE
`170484eea03a4255a388072add4232e1fadfbee4`. This maps the reported version to
public source, not independently verified binary provenance. Recheck source and
controls on another browser/backend version.

- [Chromium PutChanged](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/gpu/command_buffer/service/command_buffer_service.cc#250) encloses BeginDecoding/DoCommands/EndDecoding.
- [Decoder tracing](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/gpu/command_buffer/service/gles2_cmd_decoder_passthrough.cc#921) and [category selection](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/gpu/command_buffer/service/gles2_cmd_decoder_passthrough.cc#1716) explain command-level overhead.
- [GPUTracer timer creation](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/gpu/command_buffer/service/gpu_tracer.cc#124) distinguishes service tracing from GPU-device timers.
- [Uniform CPU conversion](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/ProgramExecutableMtl.mm#143) and [its full-span input](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/ProgramExecutableMtl.mm#1277).
- [Conversion cache reuse](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/BufferMtl.mm#419) and [write invalidation](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/BufferMtl.mm#445).
