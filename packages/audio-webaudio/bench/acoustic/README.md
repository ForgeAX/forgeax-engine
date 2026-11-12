# ROI22 acoustic regions delivery evidence

Current delivery status, exact-head gate receipts, and the merge boundary are tracked in [Engine PR #3702](https://github.com/ForgeAX/forgeax-engine/pull/3702). The preparation tables below retain the results and open gates at their recorded epochs; they are historical evidence, not a live status projection.

> [!IMPORTANT]
> This file freezes preparation evidence before the regional feature commit.
> Its historical passes do not qualify the full Engine, SDK, performance, final CI
> or merge. Read the published evidence snapshot for historical measurements; the preparation-time open gates are recorded below. Evidence PR640 merged as `e9f3cffc33a664fd343575c50a9230630ed8368c`, verified reachable from fetched Harness origin/main. Its scanner failure is retained under the user-authorized ignore exception, without a scanner PASS claim. Clean performance requires actual owner
> coordination and CPU/device admission.

The region system projects ordinary SceneAsset fields and propagated Scene
transforms into bounded source bus weights and the first listener's wet/send
environment. The Host uses its existing AudioContext, bus graph, and native
AudioParam ramps. Explicit source bus and manual wet/send edits remain the base;
leaving a region restores their latest values. Music transport remains owned by
ROI23 and shares the Context without borrowing regional gain authority.

```mermaid
flowchart LR
  Saved[Saved SceneAsset in ordinary Pack] --> Catalog[GUID Catalog / JSON transport]
  Catalog --> Scene[Scene instantiate / propagated transforms]
  Scene --> Regions[Highest-priority group / normalized weights]
  Regions --> Intents[Changed bounded POD intents]
  Intents --> Host[Existing Host bus / send / shared effects]
  Host --> Native[Native PCM / lifecycle evidence]
```

## Frozen contract and source identity

| Item | Identity or boundary |
|:--|:--|
| Initial implementation baseline | `938e64d59b4f27c0ca2fb85977a47afbfcdc3b97` |
| Current committed preparation epoch | `2a92a1f70e698fea4ad42e0e75400e63d502d0c9`, incorporating merged main `c02945839` and exact ROI23 consumer dependency `53ac6794c`; actual emitted input SHA-256 receipts retained |
| Final tested commit | Pending |
| Main inclusion / merge | Pending |
| Contract | `packages/audio-webaudio/bench/acoustic-contract.md`, frozen before implementation |
| Performance workload | 32/256 sources, 1/32/128 regions, overlap 1/8/all, 0/50/100% moving, 64 warmup + 240 measured frames, three interleaved on/off rounds |
| Geometry oracle | Independent double-precision Gauss-Jordan inverse and local shape reference, seed 2207, error <= 2e-5 |
| DSP oracle | Both channels of real 48 kHz native PCM against independent analytic 10 ms ramps and delayed impulse response; max error <= 2e-4, relative RMS <= 1% |
| Negative controls | Regions off, wet zero, send off; each must lose the enabled wet tail by >20 dB |
| Cost budgets | Audio p95 <=8 ms; full App/World Update p95 <=16.67 ms; cold preparation <=250 ms; changed batch <=256 KiB |
| Resource limits | 128 regions, 256 playing regional sources, 64 buses, 32 sends/bus; <=17000 retained nodes; no warm movement node allocation; source/graph connections released |

## Current receipts

| Gate | Current evidence | Acceptance boundary |
|:--|:--|:--|
| Audio selection unit | 17 Audio/WebAudio unit files /129 assertions pass, including seeded affine geometry and atomic capacity refusal | Focused owner pass; final repeat pending |
| Native Web Audio regression | Combined nine assertions pass: six acoustic cases plus three exact ROI23 control-ordering cases; invalid send PCM and two combined lifecycle failures retained | Real maintained Host route, original 300-second guard; complete Browser pending |
| Ordinary Pack root recovery | Original trailing-separator absolute-root failure retained; three same-path integration cases and epoch8 ordinary GUID Scene reload pass | Installed SDK and final source repeat pending |
| Public facade physics baseline | Original unchanged 5-second failures retained; four focused tests pass using fresh native ESM facade fixtures with unchanged child/outer deadlines | Test execution owner correction, no physics behavior change; complete unit pending |
| Public bench strict TypeScript and Vite multientry | Pass; actual JS bootstrap/kernel entries, no raw TypeScript data URL in built assets | Source consumer only; no installed SDK claim |
| Maintained Host routing | 69/69 pass, roster uniqueness and acoustic membership without fixed length | Complete native Browser pending |
| Full build/typecheck/lint | Epoch13 complete build: 13 rebuilt, 56 verified cache, 68 runtime closures; complete packages/scripts/236-project typecheck pass. Both current profiles pass: base source-generated, point verified reuse. Epoch12 complete lint/lint:grep pass | Final exact-head qualification remains separate; original lint ENOSPC and old profile mismatches are retained |
| Complete unit | Epoch13 groups1–3 pass; group4 DevKit naturally RED: 18 files /47 assertions failed, 84 files /440 assertions passed, three skipped; remaining19 groups not run | Original epoch10/13 failures retained. Four path-related files pass23/23 with canonical TMPDIR spelling at the same physical location, original assertions/deadlines unchanged. Full unit remains RED |
| Native App/Worker/shared + three PCM rounds | Historical epoch8 full PASS retained. Epoch13 round8 naturally RED on shared/rebuilt two-channel RMS; main60, twelve PCM cases, selection, serial Worker and real RHI replay pass | RMS threshold remains1%; rebuilt capture contains5568 trailing zero samples. Actual command/capture timing was not recorded; next epoch adds diagnostic receipts only. No pressure cause or full native pass claim |
| RHI capture / fresh-device replay | Epoch8 Apple/Metal-3: one output-transform draw, 23 resources, fresh generation1/workIndex0, 16384-byte BGRA readback | Actual standard output-path diagnostic; no audio or rendering quality/performance claim. Subsequent capture-enabled runs reject missing work, bindings, readback or fresh replay |
| Clean performance | Not started; historical epoch8 READY preserved, now BUSY for necessary integration and acceptance | No quiet window is reserved; actual committed-input owner coordination and OS admission still required |
| Full Browser / Dawn / Smoke | Pending | Full roster, native backends, 60 completed frames, original pixels/falsifiers/deadlines |
| Public installed SDK | Pending | Workspace facade linkage is insufficient |
| Final required CI / admin merge | Pending | Exact final head green before merge |

## Epoch15 qualification and retained failures

| Gate | Actual result | Remaining boundary |
|:--|:--|:--|
| Complete build / types / profiles | Commit2a92:1 rebuilt,68 verified,68 runtime closures; complete236-project typecheck and both shader profiles PASS, shader compile0 | New benchmark observers need separate strict/source qualification |
| Complete unit | Groups1–2 PASS:213/1375 and38/269. Group3 naturally RED:1 DDC pending-heartbeat test exceeds its unchanged5s limit;25/149 pass, groups4–23 unexecuted | Unchanged focused DDC file9/9 PASS in2.41s; no pressure/expiry cause or complete-unit PASS claim |
| Full native round9 | Naturally RED2:shared rebuilt RMS; all12 PCM cases, selection, serial lifecycle and fresh RHI replay PASS. Queue58111ms/execution343510ms, normal lease release | Generation2 seek was posted without a Host-consumed seek before capture, and Context clock stopped near1.829s. Existing receipt lacks final fault/dispose cause; add error/disposal/terminal-state receipts and a running-owner assertion, retaining the original clip,24blocks,1% RMS and all deadlines |
| CI / SDK | First e4e3 CI root-docs failure fixed by package-owned evidence relocation;2a92 ci-core/shared-inputs PASS, remaining CI/SDK active | Original npm View diagnostic90s timeout retains44ready/48completed frames, PNG and55work/224resource tape. All four final-head SDK consumers and full required CI remain mandatory |

The diagnostic observer adds no Context, lifecycle observer, cleanup routine or music authority. The original failed gates, source snapshots, PCM and exact timing data remain unchanged. Native timings under observed load are environment diagnostics only; no clean performance claim follows.

## Exact consumer integration

The branch includes ROI23's exact independent consumer correction
`53ac6794c6be1cb85ce0052eee00867ce18c046a`. Its generic cache publication,
closed-state consumer disposal and three native assertions remain unchanged.
The combined native run first passed six regional cases but failed both close
assertions: engine observation called public `destroy()` before the consumer's
existing `dispose()` called it again. Resource disposal was idempotent, but the
preserved once-only lifecycle oracle correctly failed. Both engine entry points
now delegate to one private retirement body; combined nine assertions pass with
the original 300-second Host guard.

A separate real native test rejected the earlier assumption that null itself
changed PCM: that preliminary six-case run passed and remains retained. Boolean
`true` did change the accepted send from 0.2 to 1, giving PCM 0.200000003 instead
of 0.12. Admission now checks `Number.isFinite(gain)` before any manual-state
mutation or float conversion. The unchanged precision-five PCM oracle passes;
red logs, source copies and failure PNGs remain under the evidence inventory.

## Preserved failures

| Failure | What it establishes | Subsequent action |
|:--|:--|:--|
| Pre-feature missing component | Baseline lacks the intended public component route | Same-path component/query implementation |
| 65 derived listener bus projections | Partial publication before derived batch admission was a real defect | Validate the complete derived batch before committing cache or emitting controls; same-path regression passes |
| Native caller closes Context | Existing active source accounting retained one source after native close | Retire sources and graph on observation of the terminal Context; real native regression passes |
| Absolute Pack root with trailing separator | Existing producer doubled the project prefix | Resolve root against cwd with the path owner; ordinary integration cases pass |
| Public facade activation under Vitest | Cold transformed import path exceeded the unchanged activation test budget; native built API starts separately | Preserve actual facade/resource identity assertions in fresh native ESM children; no timeout increase or mock replacement |
| First public App probe | Invalid tag query stopped before frames; missing requested lease flag means hardware/performance acceptance is invalid | Keep log and PNG; correct tag membership and require both requested and entry-provided held flags before launching |
| Epoch2 room PCM | Enabled max error 0.0030117 and zero-wet 0.0047083 exceeded the unchanged 2e-4 threshold; all three rounds retained | Native minimal hold-only ramp reproducer failed at 0.0480818; explicit current-time ramp-start event passes the same threshold. Epoch8 later passed the full room matrix; final-source qualification remains required |
| Epoch2 public App | 60 completed frames and ordinary saved GUID scene passed through real WebGPU, but 59 RendererOperationError names lacked sufficient cause details | Not a render pass. Bounded structured errors now retain code/detail/cause; diagnose the actual next failure before selecting an owner, RHI Debug for unexplained rendering |
| Epoch2 Worker bootstrap | Built generic bootstrap URL became raw TypeScript data URL, causing app-execution-bootstrap-failed | Use the existing App multientry JS publication contract, verify exports in the real built files, then rerun native Worker/shared |
| Native send range | Finite JS value 1e100 threw a native non-finite-float TypeError | Validate native f32 range before changing manual/environment state; real native refusal/unchanged-PCM regression passes |
| Stale dependency verification | First six-case rerun used stale built Audio validation and failed environment refusal | Preserve the failure and source/built hashes; rebuild Audio before WebAudio/native verification; six-case rerun passes |
| Epoch4 public App | Structured errors identify `render-system-no-camera`; real capture contains clear-only passes and zero work | Author an ordinary Camera in the saved SceneAsset; no renderer correction. Epoch8 later passed the full functional native gate |
| Epoch4 Worker shader publication | Standard shader manifest was absent from the built site; Worker reports `manifest-malformed` | Use the maintained shader plugin and its generated bundler adapter. Epoch8 later passed actual Worker/shared rendering and audio |
| Epoch5 Worker timeout | Native admission wait exceeded the unchanged15 seconds; the old report cannot identify which wait | Original failure/site/source/PCM/RHI retained; each subsequent wait has a stage and structured failure checkpoint |
| Epoch6 Worker resume | Initial60 frames/source1 passed, but regional controls reported missing propagated Transform, then pose control crashed with ComponentNotPresentError for Transform | Custom Vite host omitted the documented executionWorkerEntries plugin. Use that maintained public shared-module graph and assert imported component identity; unchanged full native rerun required |
| Epoch7 region removal | Public component identity and initial regional controls pass. Borrowed Query row facades retained by spread/map repeat the final region ID, causing duplicate removal and terminal Worker crash | Built public API independently reproduces [0,1] becoming [1,1]; snapshot IDs during iteration, preserve all removals and rerun full native. Existing row lifetime is clarified in ECS README |

## Evidence retained locally

| Entry | Contents and classification |
|:--|:--|
| [Prepared epoch3](../../../../artifacts/roi22-acoustics/preparation-epoch3/receipt.json) | Source snapshots, SHA-256, package/public builds, strict types, native6, unit129, facade4, routing69 and lint receipts. Focused preparation, not final acceptance |
| [Prepared epoch4](../../../../artifacts/roi22-acoustics/preparation-epoch4/receipt.json) | Wet-record SSOT collapse, native6, unit129, owner/public types, builds and WASM provenance; exact source copies and digests |
| [Failed epoch4](../../../../artifacts/roi22-acoustics/native-2c5b1752-rounds-3/metadata.json) | Twelve passing PCM checkpoints, actual/oracle WAVs, measured waveforms, structured App/Worker failures, original built site, raw RHI tape and fresh-device diagnostic |
| [Prepared epoch6](../../../../artifacts/roi22-acoustics/preparation-epoch6/receipt.json) | Strict consumer types, actual site, source snapshots, native input inventory and matching WASM provenance |
| [Failed epoch6 Worker](../../../../artifacts/roi22-acoustics/native-2c5b1752-rounds-5/app-worker-serial-failure.json) | Actual resume stage, first60-frame report, regional refusal, worker-crashed cause, Host/Context state and owned cleanup |
| [Failed epoch7 Worker](../../../../artifacts/roi22-acoustics/native-2c5b1752-rounds-6/app-worker-serial-failure.json) | Passing initial regional admission,210 completed frames, duplicate AcousticRegion removal, terminal crash and refused rebuild |
| [Borrowed row reproducer](../../../../artifacts/roi22-acoustics/failures/retained-query-row/reproducer.json) | Actual public World query and removeComponent, original failure and distinct IDs collected during iteration |
| [Prepared epoch8](../../../../artifacts/roi22-acoustics/preparation-epoch8/receipt.json) | Latest main4ae7abc66,41 source snapshots,55 input digests, strict types,12.01s actual site build and current WASM provenance |
| [Passing native epoch8](../../../../artifacts/roi22-acoustics/native-4ae7abc66-rounds-7/raw.json.gz) | Losslessly archived full source consumer functional pass, three PCM rounds, serial/shared/rebuild audio, RHI capture/readback/replay, raw numerical data and original WAVs |
| [Passing signal image](../../../../artifacts/roi22-acoustics/native-4ae7abc66-rounds-7/signal-and-performance.png) | Actual measured waveforms and tail spectrum; performance panel explicitly unmeasured. Repeated text overdraw retained and corrected for subsequent images |
| [Failed epoch2](../../../../artifacts/roi22-acoustics/native-2c5b1752-rounds-2/metadata.json) | Frozen input/bundle identity, public-app.json, twelve signal checkpoints, 24 actual/oracle stereo WAVs, failure PNG/text and preview log |
| [Ramp red](../../../../artifacts/roi22-acoustics/failures/send-ramp-gap/receipt.json) | Original production ramp, minimal real native regression, raw failure log and screenshot |
| [Native range red](../../../../artifacts/roi22-acoustics/failures/send-native-range/failure.log) | Original sources, native TypeError, regression/screenshot; stale built-dependency attempt retained separately |

Epoch2's failure PNG predates incremental signal drawing and contains blank
preparing plots; it is a failure receipt, not effect imagery. The next probe draws
each completed native signal checkpoint before Worker execution so later failures
retain already measured waveforms. Images/audio/raw data remain to be published
at durable accessible URLs before PR acceptance.

After epoch3, duplicate storage of manual wet was collapsed into the existing
effect record. Epoch4 rebuilt WebAudio and passed six real Host regressions,
17 owner unit files /129 assertions, owner types and strict public bench types.
The public multientry RHI diagnostic build also passed. The subsequent native
probe acquired its maintained lease after 517462 ms and ran for 132339 ms before
failing naturally. Its browser/preview cleanup completed and released the lease.
All twelve PCM cases passed: the enabled maximum sample error was 2.98e-8;
regions-off was exact, and wet-zero/send-off maxima were 1.49e-8. Every case
reported zero connections after stop. These results do not close App/Worker or
clean performance acceptance.

The captured frame tape is 122875 bytes with SHA-256
`de9fd20c05dc351a9eca38158ed189bcb3739e53cec243bb6b51ac977384932e`.
It contains 11 resources and zero work items. A fresh device replayed its clear
passes and retained a no-work result; it does not establish visible rendering.

Historical failed-App evidence
preserves the four actual PCM controls, original failure image, raw data and
no-work RHI tape. GitHub payload reads were checked against the original bytes;
access requires repository authorization. The earlier App/Worker failure and
unmeasured performance remain explicit. Listening review is still pending;
the available agent tools cannot listen to audio.

Complete functional native evidence
contains the epoch8 passing round's actual stereo controls, original signal
image and raw RHI evidence. All eight selected WAVs and both failure/passing
PNGs across these two archives were downloaded through GitHub and verified
byte-for-byte against the originals. Neither archive supplies a human
listening conclusion or clean performance acceptance.

Epoch5 preparation passes strict consumer types including the supplementary
overlap/priority/removal PCM oracle. The maintained shared shader producer
finished naturally in 846795 ms, and the actual multientry site built in 16.60 s
with its complete standard shader manifest. Current WASM source provenance
matches. The subsequent native owner acquired its lease after 685098 ms and
failed naturally after 159382 ms. The normal main App completed 60 frames with
zero errors. All twelve room PCM cases passed again; the nine-stage independent
overlap/priority/removal/fast-reentry oracle passed with maximum sample error
1.43e-8 and zero remaining native connections. A Worker admission wait timed
out at the original15 seconds; that round lacks the stage checkpoint added in
epoch6, so it does not establish failure of the initial wait.

Epoch6 reused the shader profile, passed strict types and built the site in
20.77 s. Its native queue waited338065 ms and ran140716 ms before natural
failure and lease release. The structured checkpoint shows the Worker completed
60 initial frames with one native source. Regional selection had already
refused its propagated transform, and subsequent source/listener pose mutation
crashed because the imported Transform did not match the installed component.
The custom host omitted the public executionWorkerEntries plugin documented
in DevKit's custom Vite contract. That maintained plugin keeps runtime Worker
entries and URL-loaded bootstrap modules in one ESM graph. The next epoch adds
it and a component identity assertion; no registry or component workaround is
introduced. This diagnosis follows actual errors, not shared-machine load.

Epoch7 passed strict consumer types, built in14.15 s and verified current WASM.
Its unchanged full native owner waited333246 ms and ran126191 ms before natural
failure/cleanup/lease release. The public Worker identity assertion and initial
regional controls now pass. Region removal then retained borrowed Query row
facades beyond iteration, repeating the final ID; the second removal throws
component-not-present outside an Update system and crashes the Worker. Rebuild
correctly refuses that terminal runtime fault. A built public API reproducer
retains the original [1,1] removal sequence and demonstrates [0,1] when IDs are
read during iteration. The next epoch preserves the intended complete removal
and intentional World-poison/rebuild falsifier, and also checkpoints intermediate
Worker PCM before any later failure. No query allocation policy is changed.

Epoch8's full native probe exited0 with no assertion failures or page errors.
It waited34596 ms for the maintained lease, executed279273 ms, and released
after its browser and preview cleaned up; ownedPID87531 and port5296 were then
absent. Twelve PCM cases again remain within2.98e-8 maximum sample error;
negative controls and zero remaining connections pass. Serial and shared each
complete60 initial and60 rebuilt frames with a second Host Context generation.
Their independent stereo RMS maximum relative errors are0.03168% and0.03115%,
both within the unchanged1% budget; the shared receipt reports actual dispatch.
The original failures above remain retained.

The final raw JSON is426384900 bytes. Summed owner/descendant RSS peaks at
8277377024 bytes, including browser, retained raw arrays and transport/JSON
serialization. Shared pages may be counted more than once. This is functional
probe residency, not isolated audio DSP memory or a clean performance result;
the cost matrix separately measures cache bytes, native nodes and observer
release. No platform memory recovery guarantee is inferred from process exit.
Actual human A/B audition is still pending. The unmeasured cost fixture now
covers the same shared convolver and listener wet/send in both on/off graphs,
and records completed-receipt latency separately from CPU admission time.

The next functional report references the already awaited per-round checkpoint
files instead of returning duplicate raw arrays and encoded clips through the
browser transport. All12 original float/oracle datasets, intents,24 PCM/oracle
WAVs, selection and Worker PCM remain in those checkpoints; the original426 MB
passing report remains preserved. This changes evidence export only. Thresholds,
oracle computations, roster, frames and source behavior are unchanged. The
export's residency difference must be measured before claiming an improvement,
and cannot be claimed as an Engine or GPU performance gain.

The earlier main-based Engine build passed with 20 packages built, 49 verified
cache hits and one actual shared shader producer (697408 ms). After the numeric
admission guards below, the complete build passed again: nine packages rebuilt,
60 verified cache hits, all 68 runtime dependency closures and declarations,
and one actual shared shader producer (556257.2 ms). Both logs and build summaries
remain in [epoch9 preparation](../../../../artifacts/roi22-acoustics/preparation-epoch9/).
These timings describe preparation under the observed shared-host load; they
are not a clean performance comparison or complete Engine gate acceptance.

Native bus volume `1e100` threw after mutating the manual base. Lazy graph
configuration also accepted an unrepresentable f32 bus declaration, and the
region cache accepted a finite affine matrix whose inverse overflowed f32.
All three original regressions and sources remain under `failures/`. Validation
now precedes native state/cache adoption. The six real native contracts and six
region unit cases pass without changing their PCM, geometry, recovery or timing
criteria. The updated public bench strict TypeScript check passes; installed SDK
mode has only syntax/preparation coverage until its actual consumer executes.

During a naturally cleaned boundary, 81 completed native JSON datasets were
losslessly archived from 2489813286 bytes to 425329451 bytes. Every file's
decompressed SHA-256 was checked before removing its duplicate uncompressed
representation; tracked-file and open-handle checks preceded each operation.
[The conservation index](../../../../artifacts/roi22-acoustics/lossless-json-archives.json)
maps every original name, size and digest to its gzip file. WAVs, PNGs, tapes,
source epochs and failures remain unchanged. This is evidence storage work,
not an Engine, DSP or GPU performance result. Restore an individual dataset with
`gzip -dc dataset.json.gz > dataset.json`, then check the index's original digest.

The new RHI tape is 179438 bytes, SHA-256
`5860b4106596ac3c6417ed904032369841e4239b0e601d1c2801078f571daf7d`.
Its one draw uses the standard output-transform pipeline and 23 recorded
resources. Fresh-device replay inspected pipeline/bindings/outputs at workIndex0
and retained a 64x64 BGRA8 attachment (16384 bytes), generation1. The native
adapter reports Apple/Metal-3. This is standard output-path evidence; it does
not establish audio quality or clean performance. Original epoch4 no-work
failure evidence remains intact.

The earlier caller-provided Context close regression covered engine nodes.
The subsequently integrated exact ROI23 consumer commit `53ac6794c` adds generic
decode-cache/disposal fencing. Its three native control-ordering assertions and
the six acoustic assertions pass together after the once-only engine retirement
correction described above. Complete Engine and installed SDK qualification
remain separate gates.
The abandoned ROI22 native source download cache was removed only after fresh
open-handle and nested-Git checks. Heads, refs, worktree/config/status inventories,
binary diffs and modified Dawn source remain under
`artifacts/roi22-acoustics/failures/incomplete-native-cache`.

## Reference mechanisms

| Fixed revision | Read mechanism | Adopted boundary |
|:--|:--|:--|
| Three.js `d3b629c0c2097cec664ad16369bb6eae3b10e335` | Audio/PositionalAudio native chain and currentTime automation | Host-owned nodes and Scene-derived pose; panning alone is not region routing parity |
| Godot `ed1daf0bf001b61586d9930840f2f1394092c079` | Area3D author parameters, bounded spatial area selection, playback bus volume maps and AudioServer consumption | Bounded deterministic weights without requiring physics triggers; bad references explicitly refuse |
| UE `71fe36aac5a8df5ccd66c763ffc902b29b6a9c43` | AudioVolume priority, proxy registration, transform updates and unregister invalidation | Reuse World lifecycle and ordered POD publication; no second region/audio clock authority; licensed source is not copied |

## Reproduction

CPU preparation runs outside the lease with package build, shader compilation,
and Cargo budgets set to one while other owners rebuild. Fetch matching released
WASM first and verify current sourceKey/provenance before any source fallback.
Prepare current bytes serially before native admission:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export FORGEAX_PACKAGE_BUILD_CONCURRENCY=1
export FORGEAX_SHADER_COMPILE_WORKERS=1
export CARGO_BUILD_JOBS=1
export FORGEAX_TYPECHECK_CONCURRENCY=1
node packages/wgpu-wasm/scripts/verify-current.mjs
pnpm build:engine
node scripts/forgeax/prepare-shader-release-inputs.mjs --build --shared-input-manifest shared-build-inputs/manifest.json
pnpm typecheck
node scripts/ci/run-vitest-unit.mjs --max-workers=1 --group-concurrency=1
pnpm lint
pnpm lint:grep
node packages/audio-webaudio/bench/acoustic/prepare.mjs
FORGEAX_SHARED_APP_INPUTS_MANIFEST=shared-build-inputs/manifest.json \
FORGEAX_AUDIO_RHI_CAPTURE=1 \
node node_modules/vite/bin/vite.js build --config packages/audio-webaudio/bench/acoustic/vite.config.mjs
```

Run the prepared functional owner with the maintained entry. Its default output
path includes a timestamp so retained rounds are not overwritten:

```bash
FORGEAX_LOCAL_GPU_LEASE=1 \
FORGEAX_AUDIO_PHASE=native \
FORGEAX_PACKAGE_BUILD_CONCURRENCY=1 \
FORGEAX_SHADER_COMPILE_WORKERS=1 \
CARGO_BUILD_JOBS=1 \
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
node scripts/ci/local-gpu-lease.mjs --timeout-ms 2700000 -- \
  node packages/audio-webaudio/bench/acoustic/run.mjs
```

The maintained entry supplies the held marker. Do not set it manually. Both
functional and complete 324-row performance owners use the existing Browser
45-minute envelope (2,700,000 ms) as a process cleanup backstop, starting only
after lease admission. This newly explicit outer bound preserves the original
60-second preview startup, 15-second native admission waits, 60 completed-frame
checks, 305-frame cost rows, PCM thresholds and falsifiers. Installed SDK runs
use the same maintained entry and bound; CPU build/install stays outside it.
Missing budget or missing entry-provided lease admission refuses before native
startup. Original queue durations and executions remain separate. The lease
owner ends only after its browser and owned preview descendants have cleaned up;
queued wait time is separate from execution. Performance uses the separately
prepared `perf` phase only after real quiet-window coordination and live CPU,
memory, and device checks.

## Remaining acceptance

Final-commit native repeat including the retained shared-rebuild RMS RED, actual A/B audition, clean cost matrix,
scaled resource high-water/return, final full Engine gates, installed SDK, final required
CI, admin merge, and remote-main inclusion were open when this preparation record
was frozen. The final accessible report will record their eventual result. Audio does not change
Render/Skin; mandatory Engine rendering smokes remain part of delivery. If a
rendering correction becomes necessary, add real RHI Debug capture, work/resource
inspection, readback and fresh-device replay before accepting that path.

## Latest main preparation and retained round10 diagnosis

> [!IMPORTANT]
> Engine delivery remains incomplete. The evidence snapshot PR642 merged as
> `a32b74905bd48943a2ab08177c85592f64555a59`; its required scanner passed.
> This does not qualify Engine PR3702 or turn any retained native/unit/CI failure green.

| Boundary | Observed result / next proof |
|:--|:--|
| Round10 original native gate | Naturally terminal FAIL; per-owner lease normally released after 4,993,118ms queue /350,227ms execution. All original inputs retained |
| Shared rebuilt owner | Actual `worker-crashed` fault: required `world` service accessed in inactive Context immediately after generation2 seek; existing consumer disposed and Context closed at1.456s |
| Bootstrap cleanup owner | Shared counters were despawned before unlinking the borrowed session-port listener. A poisoned World refuses mutation, so cleanup could abort while the old listener remained. Retire that listener first; retain the injected World and respect its terminal integrity state |
| Serial pause | Exactly128 nonzero samples in the original final4096-frame window after the original300ms wait; shared pause remains zero. Original WAV and all block/control receipts remain retained |
| Input-frame recorder correction | Real AudioWorklet input frames replace ScriptProcessor output scheduling timestamps. Stereo input passes through unchanged;1024-frame blocks/24-block captures/300ms wait/1e-5 silence/1% RMS thresholds unchanged. Native pass-through/frame-index regression and the full native repeat are required; no green result inferred |
| Main integration | Main321edc592 integrated into own worktree as a7b3e3c85; preserves acoustic and exact ROI23 consumer changes. Published WASM key53076cab/provenance verified; new profiles/site/input receipts required |
| Shared seams | No new consumer, music, Context, clock or gain ownership. ROI23 owns generic consumer close/cache fences; ROI22 retains engine retirement and regional route/wet/send |

The AudioWorklet module load stays within the existing initial recording wait.
It adds no unbounded startup await. Closing the measured consumer closes only
its observer MessagePort and invokes the same existing consumer disposer.
All actual sample frames and generation receipts remain available; no cropping
or oracle threshold relaxation is used to suppress the earlier failure.

The [Web Audio draft of 22 September 2026](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/#AudioProcessingEvent) defines `playbackTime` for scheduled playback, while [AudioWorklet `currentFrame`](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/#AudioWorkletGlobalScope) identifies the input block being processed in the same Context. These are distinct measurement facts. The retained 128-sample pause failure is consistent with a queued ScriptProcessor input window, but the original report has no input frame index, so this is an inference pending the real App rerun. The new native test passes all 12 indexed stereo blocks against independent input and rendered output, max error<=2e-7, under the unchanged 300-second Host group guard.

Epoch17 preparation completed the full engine build, full typecheck, strict benchmark types, owning 17-file/129-assertion units, full lint (0 errors/10 baseline warnings), and lint:grep. The final test-only guard correction also passed owning composite types and the maintained native Host repeat (2 files/10 assertions, original 300-second guard). These results do not close the full-unit, complete Browser/Dawn/Smoke, installed acoustic SDK, App/native, audition, clean performance, or final CI gates.

## Main adoption and epoch18 boundary

| Evidence | Actual result | Remaining boundary |
|:--|:--|:--|
| Exact `3356787f` source native | Round11 PASS, all twelve PCM controls, serial/shared initial and rebuilt 60-frame owners, native capture/readback/fresh-device replay | Historical after latest-main integration |
| Exact installed `3356787f` SDK | PASS, 82 prepared identities unchanged, real installed public modules, ordinary GUID and serial/shared rebuild | New final-head archive and consumer remain required |
| Main `4037b2029` | Integrated in `a5dba9b4`; #3701 maintained bounded standalone entry adopted here | Actual source/provenance/profile regeneration pending |
| Performance | No clean 324-row measurement yet | Real coordinated CPU/device admission, unchanged frozen budgets |
| Delivery | Engine PR3702 remains draft and unmerged | Full local gates, final complete CI/SDK, audit and origin/main merge proof |

Source round11 and earlier failures are published in
merged Harness644.
The installed SDK native raw evidence is retained locally for the next evidence
snapshot; neither historical functional run supplies clean performance results.
