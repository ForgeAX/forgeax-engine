# Performance toolbox

Run these analysis helpers from any working directory with explicit file paths.
They use Node built-ins and do not require Engine installation, native WASM,
Chromium, device access or network. Arguments are JSON Pointers, not inferred
field names; `~1` escapes `/` and `~0` escapes `~` in a key.

## CPU profile attribution

```sh
node skills/forgeax-engine-performance/scripts/analyze_cpu_profile.mjs \
  capture.cpuprofile --top 30 --output cpu-summary.json

node skills/forgeax-engine-performance/scripts/analyze_cpu_profile.mjs \
  cpu-profiles.json --profile-pointer /profiles/0/profile --output host-cpu.json
```

The default profile pointer is the document root. `--top` accepts 1..1000.
Run once per Host/Engine/Render Worker profile. The result retains the input hash,
profile duration, sampled/unobserved time, leaf self time, inclusive symbol time
and sample-delta statistics. Same-location recursive ancestors count once per
sample. Locations are zero-based CDP values; source maps are not resolved.

Malformed trees, unknown sample nodes, nonfinite/negative deltas and inconsistent
sample/time arrays exit 1. The analyzer does not classify a missing ancestor or
an opaque symbol as a particular Engine subsystem. Resolve the loaded script
and mapping before making a source-level ownership claim.

## Same-capture LIVE and completed-frame CPU windows

```sh
node skills/forgeax-engine-performance/scripts/analyze_cpu_windows.mjs \
  cpu-profiles.json --report report.json --frames sampled-frames.json \
  --maps cpu-node-maps.json --top 30 --output cpu-windows.json
```

This offline adapter reads the existing Frontline ordinary CPU collector's
records from explicit paths. It needs no Game checkout or Engine runtime.
Use the whole-profile analyzer above for other wrappers; do not rename loading
bounds to LIVE to satisfy this adapter.

| Input | Required producer facts |
| --- | --- |
| CPU profiles | `{profiles: [{target, profile, scriptDigests}], failures: []}`; original CDP target objects and microsecond clocks |
| Report | `cpu.commonWindow`, empty CPU failures, `coldFirelineCpu.anchorsBefore/anchorsAfter`, and `windows.sampled.submissionGaps.worstCompletedGaps` |
| Sampled frames | Explicit `firstLiveAt`, `end`, `timeOrigin` and `frames[]` receipts; `at` is the page-millisecond completion observation |
| Optional symbols | `rawSha256`, complete target mappings, matching source/build/common-window identity and captured script digests; supplied map bytes are hashed, not re-authenticated from source files |

Every before/after anchor must describe the same page time origin; their offset
intervals must intersect. The midpoint converts page milliseconds to CDP
microseconds. Output preserves the full offset interval and uncertainty, each
original target object, input SHA256, requested/covered bounds and source
coverage. Gap endpoints must match actual supplied frame receipts. Empty gap
arrays are valid; missing LIVE/anchors, foreign frames, incomplete targets and
stale symbol maps exit 1. Partial midpoint-window coverage exits 2 and retains
the covered fraction. No realm sum or performance-comparison verdict is made.

The ending-sample path reconstructs timestamp/sample pairs before stable sorting
when raw deltas are negative. It validates every endpoint, including data outside
LIVE, and reports reordered count/time as attribution sensitivity. It excludes
the first-sample startup interval and unobserved tail; it never rescales samples.
Self/inclusive rankings keep zero-based generated locations. Inclusive node
stacks overlap; different realms run concurrently. A sampled stack can include
scheduling delay. An unprofiled long frame from another capture has no attribution
in this output. These rules apply to this clipped path; the legacy whole-profile
analyzer retains its strict nonnegative-delta contract.

## Worker heap and native GC attribution

Use [GC and allocation ownership](gc.md) to select the capture and interpret its
scope. Analyze each captured realm separately; the profile pointer selects the
original producer record rather than guessing names from filenames.

```sh
node skills/forgeax-engine-performance/scripts/symbolize_heap_profile.mjs \
  cpu-profiles.json --profile-pointer /profiles/1/heap \
  --digests-pointer /profiles/1/scriptDigests --build frozen-build.json \
  --base-url https://example.test/game/ --output engine-symbols.json

node skills/forgeax-engine-performance/scripts/analyze_heap_profile.mjs \
  cpu-profiles.json --profile-pointer /profiles/1/heap \
  --symbols engine-symbols.json --output engine-allocation.json

node skills/forgeax-engine-performance/scripts/summarize_native_gc.mjs \
  native-trace.json --markers owned-markers.json \
  --start-us 1000000 --end-us 16000000 --output natural-gc.json
```

| Tool input | Contract |
| --- | --- |
| Heap | CDP SamplingHeapProfile `{head, samples}`, or producer wrapper `{profile, samplingInterval, durationMs, includesCollectedByMinorGC, includesCollectedByMajorGC}` |
| Script digests | Array of `{url, sha256}` captured through Debugger.getScriptSource; use `--digests FILE` when supplied separately |
| Frozen build | `{dist, engineDirectory?, distSourceDirectory?, engineSourceDirectory?}`; original source-coordinate roots preserve chained Engine mapping after cloning |
| Owned markers | Array of `{targetId, realm, name}`; unique user-timing marker per sampled target, emitted before the requested observation interval |
| Observation bounds | Trace-clock microseconds; both `--start-us` and `--end-us`, using common CPU bounds when measuring natural workload GC |

Heap results include complete file partitions, top caller groups, direct/ancestor
coverage, unresolved bytes and both V8 node-self and sample-size totals. Their
values can differ; neither is silently substituted for the other. `--top` only
truncates caller/unresolved rankings, never file accounting. Without symbols,
all source bytes remain unresolved; generated names do not establish ownership.

The symbolizer requires same-origin script bytes to match captured SHA256, then
chains the application map through matching embedded Engine output when needed.
Missing maps remain unmapped. Digest mismatch, escaped paths or incompatible
maps fail. Its local map hashes identify supplied frozen maps; CDP did not capture
those maps. Analysis refuses symbols from another input hash/profile pointer.
Only generated code and source-map artifacts are read; authored source is not
executed. Paths and identities in output remain private evidence.

Native summaries separate Minor/Major GC, finalization cleanup, cppgc sweeping
and untimed task counts. Counters exclude the first observed boundary and the
unobserved tail. Missing CPU clocks and fewer than two boundaries remain null.
With bounds, primary results contain fully enclosed events; crossing/terminal
events remain in `wholeTrace`. Any malformed owned event still fails whole-trace
validation. Repeated markers, conflicting ownership and invalid clocks exit 1.

## GPU pass timing

The source authority is the [GPU timing contract](../../../packages/render/src/record/gpu-pass-timing/contract.ts).
For an array of public observations, use the default root row/observation pointers:

```sh
node skills/forgeax-engine-performance/scripts/summarize_gpu_timing.mjs \
  gpu-observations.json --output gpu-summary.json
```

For the ordinary browser collector's existing nested capture:

```sh
node skills/forgeax-engine-performance/scripts/summarize_gpu_timing.mjs \
  combat-report.json --rows-pointer /gpu/samples \
  --observation-pointer /observation --context-pointer /worldIdentity \
  --output gpu-summary.json
```

| Output | Interpretation |
| --- | --- |
| `counts` | Complete/partial/unavailable/failed observations, exact duplicates and equal-tick pass executions |
| `groups` | Context hash, backend, device generation and timestamp-period cohorts; graph-generation inventory and timestamp statistics |
| `passes[].durationMs` | Sum of a semantic pass's executions per observed complete frame, with nearest-rank statistics |
| `durationPerExecutionMs`, `executionIndices`, `observedExecutions` | Separate execution population and the changing sequence positions |
| `absentCompleteFrames` | Complete cohort frames without this semantic pass; no synthetic zero sample |
| Repeated coverage / interval union / timestamp envelope | Respectively includes overlaps / merges intervals / includes timeline gaps |

Pass identity includes view, name, kind and measurement source. Graph generation
and execution position can change each frame; the tool inventories them while
aggregating the semantic workload within a device cohort. Review the producer's
pass naming when distinct workloads share a name. Multiple same-name executions
in a frame are summed explicitly rather than mistaken for additional frames.

With no context pointer, the caller selects one Renderer/context. Supply a
stable producer identity when mixing contexts. Identical duplicate frame facts
are counted once; conflicting facts for the same context/device/frame refuse
analysis. Ticks are parsed as BigInt, checked against reported duration and
converted to milliseconds only after interval arithmetic.

Partial observations remain counted and stay out of complete-frame statistics.
Dropped or unmeasured entries make a frame partial even if the producer labels
it complete. Counts, timestamp consistency and entry identities are checked.
Equal ticks remain quantized observations. This is not a new capability check,
frame-latency calculation or benchmark acceptance authority.

## Matched raw sample comparison

```sh
node skills/forgeax-engine-performance/scripts/compare_samples.mjs \
  baseline.json candidate.json --identity-pointer /workload \
  --samples-pointer /samples --unit ms --direction lower \
  --output comparison.json
```

Both pointers are applied to each producer document. The selected samples must
be nonempty finite nonnegative numbers; the identity must be a nonempty object.
Use `higher` for higher-is-better counts/rates. Units are declared by the caller
and must match the producer data. A minimal adapter can use:

```json
{
  "workload": {
    "scene": "fixed-combat",
    "actors": 10,
    "resolution": [1920, 1080],
    "backend": "webgpu",
    "shadow": { "cascades": 3, "size": 1024, "filter": "pcf5" },
    "instrumentation": "same-bounded-stage-timer"
  },
  "samples": [7.1, 7.5, 7.2]
}
```

This example is an analysis adapter, not a required capture schema. Preserve
the producer's raw file/hash, source/build identity and completeness alongside
any extracted samples. The tool compares every field of the selected identity;
it does not validate omitted configuration, hardware, contention or correctness.
A matching identity is not a performance verdict. Mismatches produce paths and
null improvement/change ratios. A zero baseline also produces null ratios.

## Exit status and outputs

| Exit | Meaning |
| --- | --- |
| 0 | Valid CPU, heap/source or native-GC analysis; or selected comparison identity matches; or GPU input contains complete frames with no partial/failed/unavailable rows |
| 1 | Invalid input, arguments, output path or incompatible facts; structured stderr reason |
| 2 | Comparison identity differs; or GPU summary is incomplete/has no complete frames; or CPU window coverage is partial; structured report is still emitted |

No code means a live correctness/performance gate passed. Output defaults to
stdout; `--output` writes only that chosen file and refuses overwriting any raw
input, including through an existing symlink. Create its parent directory first.
Keep outputs private and sanitize paths/device identities before external publication.

## Reuse live producers

| Need | Existing authority/tool |
| --- | --- |
| Ordinary gameplay, input and Renderer completions | [WeChat gameplay benchmark](../../forgeax-engine-wechat/references/gameplay-performance.md), including browser collectors |
| Browser GPU query capture | [browser_gameplay_gpu.mjs](../../forgeax-engine-wechat/scripts/browser_gameplay_gpu.mjs); read its `--help` and owning reference |
| Frontline fresh defaults and automatic cold shot/wall warnings | Game combat driver, render configuration and cold timeline; inspect the current entrypoint before use |
| Frontline first smoke-zone appearance and surrounding completion gaps | Existing completed-frame observer; HUD appearance is not a visibility or cost attribution probe |
| Voxel Frontline extreme-frame trace and opt-in native/contact probe | Game-owned perf-extreme-frames.mjs; inspect its current entrypoint before use; [scoped capture and limits](cases/firefight-physics-scheduling.md) |
| Host callback versus native completion | [Completion timing](../../forgeax-engine-wechat/references/completion-timing.md) |
| Native host/device contention and capacity | [WeChat performance](../../forgeax-engine-wechat/references/performance.md) and its existing capacity collector |
| Platform/UI-specific CPU categories | [analyze_ui_cpu_profile.py](../../forgeax-engine-wechat/scripts/analyze_ui_cpu_profile.py); its runner/result format is intentional |
| Public real-backend GPU-query overhead qualification | [GPU timing benchmark](../../../packages/render/bench/gpu-pass-timing/runner.ts), [entrypoint](../../../scripts/bench/gpu-pass-timing.mjs) and their maintained fixture/acceptance tests |
| Failing rendered work, bindings or resources | [RHI Debug](../../forgeax-engine-rhi-debug/SKILL.md) |

Do not duplicate platform collectors or invent a replacement delivery gate.
Offline analysis only needs its JSON inputs; live tools keep their declared
installation, ownership, capability, sandbox and GPU-scheduling requirements.
