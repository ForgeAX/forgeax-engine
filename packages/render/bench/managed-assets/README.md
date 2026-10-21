# Managed asset macro benchmark

This carrier measures design §10.3 against two immutable browser artifacts on a
physical WebGPU adapter. It keeps ordinary `createApp` policies in `default` mode;
`worker` mode requests Engine and Render Workers and leaves Kernel Workers on
`auto`. The recorded execution report is the authority for actual placement.

The backpressure cases use the native Renderer/RenderPublisher carrier because
their producer and consumers need independent cadences. They cover local and
Worker consumers with one or two Renderers. They supplement the App cases.

The current acceptance scope is a 30-60 minute core run, as requested on
2026-10-19. Use `--profile=core` for the existing `static-10000`, `shared-10000`,
and `mesh-1000000-changed-64` cases in default and Worker mode. Three A/A pairs
followed immediately by three alternating A/B pairs for each case and mode
produce 72 windows. Each retains
60 warmup frames, 300 measured frames, the original author writes, budgets,
pixel checks and teardown. Core uses completion-only `measure-lean`: original `FrameReceipt.completed` and matched Host completion intervals, without GPU timing, GPU counters, World-update or message timing wrappers. A real warmup receipt must report `gpu-timing-not-enabled` before measurement. Bounded receipt sampling and progress messages remain observation overhead; this fixture is not whole-game FPS acceptance. Heap allocation and Native GC use separately named fresh windows.

## Source-change qualification

`transform-1000` and `transform-10000` change one actual World Transform per
source update; `transform-fragmented-10000` uses 128 observed MeshFilter query
tables; `transform-dense-1000` changes every root. They use the current adapter
in both comparison arms, share the ordinary App/Worker and completion carrier,
and retain the original visual oracle and quality settings. They are separate
qualification cases and do not expand the 72-window core profile.

The source checks actual changed identities, observed table/row populations,
authored write order/count and final source acknowledgment. For these cases,
the legacy `assetCpuMs` field measures the World Transform author call; it does
not measure a Registry edit. Allocation, natural GC and final ordinary throughput
still require their separate capture windows. `measure-lean` does not collect GC.

```sh
node --test packages/render/bench/managed-assets/__tests__/transform-workload.test.mjs
FORGEAX_LOCAL_GPU_LEASE=1 node scripts/ci/local-gpu-lease.mjs --timeout-ms 300000 -- \
  node packages/render/bench/managed-assets/run-case.mjs /private/artifact transform-1000 worker /private/window.json measure-lean
```

Carrier builds freeze source and carrier inventories before compilation and
reject input drift afterwards. A failed drift check supplies no valid build
identity; preserve the rejected build and rebuild from frozen inputs.

## Build and run

Build from this carrier, passing each version's own isolated checkout. The
baseline checkout must have its own dependencies and native artifacts. Workers
and the benchmark bootstrap share one Rollup build so component identity remains
consistent inside each realm.

Use the same main commit beneath both arms so unrelated rendering changes do
not become asset-performance gains. The workload explicitly keeps four
directional shadow cascades and split lambda 0.75, preserving its original
rendering load even when Engine defaults change. Record the common source base,
both artifact identities and the carrier hashes before timing. Changing the
baseline or these authored values requires a new report and complete A/A;
earlier raw windows remain historical evidence, not the new noise calibration.

```sh
node packages/render/bench/managed-assets/build.mjs /path/to/baseline /tmp/macro/baseline baseline
node packages/render/bench/managed-assets/build.mjs /path/to/current /tmp/macro/current current
```

The optional fifth build argument is `completion` (default) or `gpu-timing`.
Each identity records this choice. Before and after each browser window, the
runner checks the inventory digest and every artifact file's size and SHA-256.
Series admission requires matching A/B carrier hashes, completion identities,
the real preflight, complete artifact authentication and no GPU diagnostic
samples. Summaries retain these qualifications. GPU timing, CPU draw timing,
upload/transfer counts and explicit GPU resource sizes are available only in
the separately built diagnostic carrier.

Transfer both artifact directories and the carrier's `.mjs` files to the measuring
machine. Run the series with its local Node, Playwright, and sandboxed Chrome:

```sh
FORGEAX_BENCH_PLAYWRIGHT=/path/to/playwright-core/index.mjs \
  node run-series.mjs paired baseline current report --profile=core
```

The core `paired` phase freezes each case/mode's A/A noise before its A/B work,
so an expensive baseline cannot consume the whole time budget before any
comparison. Its index lists all six entries, including pending or failed ones;
partial results do not establish a complete core profile.
`core` is the default and only series profile. The former full series mixed incompatible observation requirements and is rejected before starting a browser. Run individual heap/GC cases with explicit `run-case` phases; backpressure requires a separately built `gpu-timing` artifact and remains diagnostic. No full-matrix acceptance is implied.
The profile and its complete selected roster are frozen into the report; a
regex filter only resumes a subset and cannot waive missing calibration cases.
Use a new report for a different profile. Preserve incomplete results at the
time limit instead of reducing frames or weakening checks. Core runs do not
wait for other users' tasks; report measured noise and any inconclusive metrics.

`FORGEAX_BENCH_CHROME` overrides the default macOS Chrome executable. Every launch
sets `headless: true` and `chromiumSandbox: true`, creates its own browser, and never attaches to a user CDP session. Series children explicitly receive `CI=1`, `FORGEAX_BROWSER_HEADLESS=1` and `HEADLESS=1`. The frozen contract and each window record the headless mode; use a fresh series and fresh A/A controls instead of combining historical headed windows. A physical-adapter report must retain adapter and
browser identity; software GPU runs do not supply physical performance evidence.

`cases.mjs` fixes resolution, seed, scales, 60 warmup frames, 60 initial writes for
mutating cases, three pairs and 300 completed frames per window. Correctness
oracles run before timing. Calibration runs A/A, A/A, A/A. Comparison runs A/B,
B/A, A/B. There is no candidate A/A phase.

`contract.json` freezes cases, budgets, probe hash and baseline artifact before
calibration. `noise.json` freezes the maximum absolute paired A/A difference for
each metric after calibration. A changed contract requires a new report
directory. A case with missing or failed calibration cannot start candidate timing.
Valid completed windows can be resumed without rerunning them.

## Evidence and interpretation

Each window retains raw samples, source asset identity/version, native source
acknowledgments, actual execution placement, GPU timestamps, initial and final
Renderer inspection, pixel oracles and final pixels. The full diagnostic profile
also retains heap profiles and GC events; missing core heap/GC values are not zero.
Heap evidence format 3 keeps raw trace events as `.trace.ndjson`, allocation
tree nodes as `.realmN.nodes.ndjson`, and allocation samples as
`.realmN.samples.ndjson`. The compact report preserves authenticated targets,
loaded-script SHA256 receipts, complete trace status, owned-thread summaries,
endpoint memory observations and the diagnostic boundary. Hidden maps are
included in new artifacts. Every invocation records its current CLI runner
inventory separately from the immutable browser artifact identity.

Use `measure-allocation` and `measure-native-gc` in separate ordinary App windows.
Allocation samples include objects collected by Minor and Major GC. Setup and
retrieval use the same CDP frontend through Chromium's existing debugging pipe;
its temporary byte decoder preserves profiles beyond V8's single-string limit
and restores the pinned Playwright decoder after each retrieval. Unsupported
transports fail explicitly. Profile retrieval starts only after native tracing
ends and App source/render credits drain. Allocation bytes still include bounded
pre-window frames and post-window report/retrieval work: retain that limitation
and attribute actual owners rather than presenting these totals as an exact
300-frame allocation count.

Natural-GC capture does not enable HeapProfiler. The ordinary fixture marks its
start before source writes and its end after the admitted Host completions,
before asking for the large Renderer report. Owned thread markers bind Host,
Engine Worker and Render Worker events to actual targets. Only complete native
events inside that common interval enter the primary GC summary; missing
promotion/allocation boundary counters remain unavailable. Endpoint heap values
are not a peak, and background-thread GC remains a separate population.

The strict diagnostic target/boundary adapter currently qualifies the ordinary
App carrier. The independent-cadence backpressure carrier needs its own target
roster and completed-cycle markers before its profiled windows can qualify;
its lean path remains separate. Earlier formats and windows remain historical
raw evidence and cannot supply this collector's calibration.

A `.timing.json` sidecar preserves completed timing when later diagnostics fail;
it is not an accepted diagnostic window without the required evidence, pixel
checks and teardown. Raw per-realm CDP responses and command/byte receipts survive
later failures. Those post-window transport receipts never qualify natural GC.
The series gives neither stdout nor stderr ownership of their shared
log and waits for its final flush before advancing to the next window.
When only this post-window serialization changes, a new report may reuse
completed windows with byte-equivalence proof for workload/setup/oracles and
sampler, original frozen probe hash verification, and per-window SHA-256
provenance. Original raw files remain immutable.

The series writes a per-window summary and an index with paired deltas. The
median of three A/B deltas is compared with the frozen A/A noise radius; no
percentage regression allowance is applied.

| Field | Meaning |
| --- | --- |
| `assetCpuMs` | Source-realm author call, including baseline rebind work where that is the old author path. |
| `worldCpuMs` | Source-realm `World.update` duration. |
| `sourceTaskCpuMs` | Source World start through the native simulation-complete post. |
| `sourcePublicationCpuMs` | World end through that post, including publication and adjacent source work. |
| `cpuDrawMs` | The synchronous native Renderer draw call. |
| `wholeFrameMs` | Host execution dispatch through Host completion of the corresponding ready frame. It excludes input/audio preparation before dispatch. |
| `frameCompletionIntervalMs` | Output cadence between consecutive completed Host frames. |
| `commitToAckMs` | Source-realm commit through the native source acknowledgment; includes return transport/waiting. |
| `submitToObservedWallMs` | Renderer draw start through completion of its timestamp observation. |
| `gpuPassEnvelopeMs` | Real GPU timestamp envelope from the first instrumented graph pass to the last, including gaps. It excludes preceding mip generation and external-image copies; it is not the duration of the entire submission. |
| `oldestPendingAgeMs` | Backpressure age of the first produced state after each consumer's previous acknowledgment; coalesced states remain represented. |

Do not sum phase quantiles or parallel Worker durations into a frame latency.
Separate diagnostic GPU timestamps and source-realm acknowledgments must not be subtracted across uncalibrated clocks. A Renderer source acknowledgment records the
submitted source revision; final pixels independently check the last committed
content. Intermediate coalesced steps are counted instead of being reported as
individually displayed states.

GPU memory counters describe explicit WebGPU resource descriptors, not driver
resident memory. Heap memory adds each realm's maximum V8 used, backing-store and
embedder bytes, giving a conservative upper bound rather than simultaneous
physical residency. Allocation profiles are sampled estimates. Transfer counts
cover transferred ArrayBuffers; ordinary structured-clone message payloads are
not byte-sized by this probe. Keep these measurements separate and do not add
shared storage twice.

`measure-lean` skips the CDP heap/GC probe for a bounded probe-overhead comparison:

```sh
node run-case.mjs baseline shared-1 default lean.json measure-lean
node run-case.mjs baseline shared-1 default profiled.json measure
```

With a completion artifact, that comparison isolates heap collection in the same completion carrier. With an explicitly built `gpu-timing` artifact, both windows remain GPU diagnostics. Legacy artifacts without observation identity are classified as GPU diagnostics. Rebuild both arms and recalibrate after changing observation mode; old diagnostic noise is not completion noise.

## Current collection limitations

The earlier v18 carrier pauses the ordinary App through its native owner and drains
Engine credits and the final Render source frame before exporting heap profiles.
The backpressure carrier stops its producer and awaits every consumer receipt.
Each window records this quiescence and verifies that frames did not advance
during profile export. Earlier ordinary App carriers kept rendering during
serial profile retrieval, contaminating the later realms' allocation and final
heap figures. Their raw timing remains diagnostic evidence; they do not supply
v18 acceptance or noise calibration. V18 starts a fresh complete A/A calibration
and includes the corrected Buffer-copy counter for both arms.

The v16 carrier extends the inter-realm watchdog from four to thirty minutes so
the profiled 50,000-instance baseline can finish all 300 frames. It also puts
Registry teardown behind the version adapter and writes a successful window
only after teardown completes. The old baseline has `clearCatalogSource` and
`invalidateAll`, rather than the current Registry's `dispose` operation.
Earlier complete timing windows can be reused only with recorded equivalence
of Engine source, workload, sampler and oracles. Legacy backpressure windows
had a post-measurement teardown error; their timing evidence does not establish
successful cleanup. Separate default/Worker diagnostic runs verify the repaired
teardown, and the provenance retains that distinction.

The 2026-10-18 v14 carrier's Buffer-copy wrapper only counts the five-argument
native overload. A three-argument call poisons `bufferCopyBytes`, serialized as
`null`. Its other evidence remains valid, but that field is unavailable and must
not be treated as zero. Complete Buffer-copy attribution needs a separate fixed
probe run; do not rewrite a frozen timing artifact in place. The current counter
handles both overloads and the optional source-remainder size. Build attribution
artifacts with that counter separately; a resumed timing series continues using
its original frozen carrier for both arms.

An unavailable GPU timestamp, failed oracle, incomplete window or failed scale
is preserved as missing evidence. Smaller scales do not replace the specified
1 million vertices or 50,000 entities. A performance claim requires the final
report's budgets, noise, raw artifact paths, correct pixels, version evidence,
paired results and explicit unmet items.

Realm memory summaries keep JS used heap, backing storage and embedder heap in separate categories. Their sampled maxima are observations, not resident-memory peaks, and are not added into a synthetic heap total. Missing categories stay unavailable.
