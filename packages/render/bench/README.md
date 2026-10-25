# State projection cost measurements

## Filtered contribution preparation

`filtered-contributions.ts` exercises the production `BatchTopology`, prepared
rows and `FilteredPlanContributionOwner` with 2,300 distinct batches backed by
one RHI Null mesh. It checks the full projection result before timing stable,
one-row, sixteen-row, all-row and equal-shadow-publication updates. It is a
synthetic CPU workload, not a captured game scene or a GPU/FPS benchmark.
Prepared inputs, claim construction and assertions stay outside timing;
the owner still checks current bindings and claims. No spies are installed.

Build this carrier from both source revisions into separate output directories,
then pass their entries to the paired runner. The runner alternates arm order,
records every sample and hashes both compiled entries. Use an unused report path.

```sh
node node_modules/tsup/dist/cli-default.js \
  packages/render/bench/filtered-contributions.ts --format esm \
  --out-dir artifacts/filtered-contributions/candidate
node packages/render/bench/filtered-contributions.mjs \
  artifacts/filtered-contributions/baseline/filtered-contributions.js \
  artifacts/filtered-contributions/candidate/filtered-contributions.js \
  artifacts/filtered-contributions/comparison.json
```

`production-prepare-bindings.ts` uses the same paired runner for the complete
`GpuDrivenProduction.prepare` call and resource commit over a retained
RenderScene/GPU Scene with 2,300 distinct batches. Its cases cover stable empty
and populated binding Maps, one changed binding, and all changed bindings.
Input mutation, fixture construction, and correctness assertions are outside
timing. RHI Null supplies real engine resources without GPU execution; these
CPU measurements do not establish a game frame rate or GPU improvement.
Build this carrier at each revision using the command above with its filename,
then pass the two `production-prepare-bindings.js` entries to the same runner.

## Feature signature admission

`render-feature-signature.bench.ts` measures the native feature host's
`recordPlanSignature` followed by the graph's
`renderFeaturePlanSignatureEvidenceMatches`. Its synthetic fixture has 18 named
emitters, each declaring a 64 KiB WGSL program, three buffers, one binding set and
one dispatch. Descriptor validation and the initial canonical signature run
before timing. Each benchmark alternates two prebuilt plan objects; equal
uploads must retain the signature, while capacity/dispatch or shader changes
must advance it on every iteration. Graph evidence must match after every step.

The same fixture ran before and after immutable-string token reuse, on Linux
x86_64 / Node 24.19.0 / Vitest 4.1.11, with 200 ms warm-up and 1,000 ms sampling
per case. Baseline source is `148ef3f2ff4954584ecc44d5f8027a1a33951e62`.
[Recorded statistics](feature-signature-results.json) preserve each sample count
and relative margin of error.

| Timed host + graph check | Before mean (ms) | After mean (ms) | Before p99 (ms) | After p99 (ms) |
|:--|--:|--:|--:|--:|
| Buffer uploads only | 3.161 | 0.108 | 4.108 | 0.192 |
| One buffer capacity and dispatch change | 3.193 | 0.129 | 3.826 | 0.231 |
| One shader source change | 3.433 | 0.358 | 4.779 | 0.612 |

These are signature CPU measurements, not full-frame FPS or GPU timings. The
fixture does not compile or execute the synthetic shader. Plan construction,
GPU resource preparation, graph recompilation and resource retirement are
outside the measured interval and retain their existing behavior.

```sh
node node_modules/vitest/vitest.mjs bench --run \
  --config packages/render/vitest.config.ts \
  packages/render/bench/render-feature-signature.bench.ts \
  --maxWorkers=1 --outputJson /tmp/feature-signature-result.json
```

## State projection

Render Bundle submission has a [stress carrier](render-bundle-stress.ts) for
CPU command-submission measurements; it is not a full-frame FPS benchmark.
Generated reports and captures belong under the ignored root
`artifacts/render-bundle/` directory and must be regenerated for the current
source revision.

The comparison runs identical workloads against two source revisions. Production
changes use one current-state projection; the sequential extractor exists only
as a lower-bound measurement and does not include persistent topology or GPU work.

| Carrier | Workload contract | Records |
|:--|:--|:--|
| Node | 60 warm-up + 180 measured frames; 64 / 2,048 entities | Simulation, projection and total CPU median/p95, scanned rows, process heap peak |
| Chromium WebGPU | 30 warm-up + 90 measured frames; 32 / 512 entities | Simulation, draw CPU, submit CPU, submission-completion latency, buffer-write calls/bytes and raw samples |

Both carriers cover small, static, contiguous sparse, scattered, dense,
fragmented-table, historical-empty-table, parent-transform and shared-material
workloads. The Node carrier additionally runs the sequential extractor.
Material changes use the old shared-ref protocol only when measuring a revision
that predates managed content. Node asserts equivalent material output.

```sh
node scripts/bench/run-state-projection.mjs /path/to/baseline /tmp/projection-baseline
node scripts/bench/run-state-projection.mjs . /tmp/projection-candidate
node scripts/bench/run-state-projection-browser.mjs /path/to/baseline /tmp/browser-baseline
node scripts/bench/run-state-projection-browser.mjs . /tmp/browser-candidate
```

The baseline needs installed dependencies and the usual checked WASM payloads.
The browser carrier uses this checkout's browser fixture/compiler preparation and
aliases runtime packages to the requested revision's source. Run the normal
browser shader preparation first. Its temporary test uses a separate Vite cache
and is excluded from the normal browser roster by filename.
Raw browser results are written through a Vitest Browser command into
`result.json`; console forwarding is not the artifact transport. A successful
test process without that file remains a failed measurement.

> [!IMPORTANT]
> Compare matching workloads on the same device. The fixed diagnostic budgets
> are baseline p95 × 1.20 + 0.2 ms for Node total CPU, and baseline p95 × 1.20 +
> 2 ms for browser draw CPU / completion latency. Preserve failed and contended
> runs. Passing one pair on a loaded machine does not establish an improvement.

Submission completion is a fence observation, not a GPU timestamp or a browser
presentation timestamp. These carriers do not measure DOM input latency, a
separate Render Worker, or SAB transport. Heap peak is not allocated bytes or GC
pause time; use a CPU/heap profile to investigate those costs. The browser
functional gate separately checks two consumers, material and mesh changes,
input-array isolation, rebind, removal, and visible restoration.

## Scene/material scaling

These diagnostics run the real Renderer on native Dawn. Serialize physical GPU
measurements against other workloads on the host. On a shared machine, pass
one case id after the scaling output or after the workload suite (for example
`visibility hzb-10000-high`) and release the EX lock between cases; the shadow
carrier accepts `shadow-stable` after its output path. Build the Engine and shared
shader inputs first; all raw samples, inspections and images stay in `artifacts/`.

```sh
node packages/render/bench/scene-material-scaling.mjs artifacts/scene-material-scaling/scale
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/lod lod
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/visibility visibility
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/decals decals
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/captures capture
pnpm exec tsup --config packages/render/bench/scene-material-shadow.config.ts
node artifacts/scene-material-scaling/shadow-bin/scene-material-shadow.js
```

| Carrier | Control and boundary |
|:--|:--|
| Scaling | Direct / automatic geometry, 1k / 10k rigid and mixed, stable / 1% dirty / full churn; build `hello-custom-shader` first for the real cooked custom program |
| LOD | Hard / crossfade at both sides of the threshold, 1k rigid meshes; direct fallback keeps hard selection |
| Visibility | HZB off / on, high / low occlusion, immediate camera jumps |
| Decals | Zero / active channel opacity, 1 / 16 / 64 volumes, local / near-plane coverage |
| Captures | Planar cadence 4 / 1, cube repeat controls, steady / continuous probes and budget overflow |
| Shadow | Existing pool explicitly invalidated / ordinary reuse; 100% static, 99% static + 1% movable, and 100% movable; Deferred SSAO toggle validates same-extent graph replacement |

Each uses 16 completed warm frames (bounded capture/filter startup extends this), four ABBA
groups, eight measured frames per window and one unmeasured transition frame.
Cold pipeline preparation retries the same World snapshot before sampling. Scene assets use the
runtime owner; custom materials load the built app Catalog and update ordinary owned values.
CPU World/draw and completion wait are separate; GPU time is the measured-pass envelope from the existing
`summarizeGpuPassTimingIntervals` owner, never a sum of overlapping intervals or
a native outer query. Raw ticks and per-view coverage are retained; incomplete
GPU observations block these diagnostic runs. Resource facts cover graph generations and GPU lane allocations;
they do not claim total native/driver residency. Light casting uses the actual
light components; the removed profile shadow flag never disabled these writers.
The shadow control includes explicit invalidation cost and does not expose a
second production cache switch. `FORGEAX_SCALE_PROFILE=1` retains a bounded CPU
profile separately; overflowed captures cannot establish full-run attribution.

## Engine→Render transport

`transport/` measures the whole Worker path per frame: source update + publisher
encode + `postMessage` under App's publication-slot credit (`source.mjs`), then native
deserialize + publication decode/apply (`run.mjs --receiver scene`) or the full stub
Renderer draw and completion (`--receiver renderer`). It reports structured-clone
bytes, record bytes, transfer count, post time, source/receiver CPU and allocation,
GC, credit stalls and tick→applied/completed latency. `codec.mjs` is the only
protocol-specific file; `mechanisms.mjs` compares cloned, transferred and SAB
transport in isolation; `profile-tree.mjs` summarizes `--profile-source` /
`--profile-receiver` sampled heap profiles.

```sh
node packages/render/bench/transport/run.mjs --sweep 100,1000,10000,100000 --changes 0,8,1%,100%
node packages/render/bench/transport/run.mjs --receiver renderer --count 1000 --changes 8
node packages/render/bench/transport/mechanisms.mjs
```

Read allocation from the window counters only; reading `total_allocated_bytes` per
message flushes allocation buffers and distorts the result. Results and the
protocol decision live in `reports/unified-render-ecs-20261024/design.md` §10.
