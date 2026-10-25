# Reusable WeChat tools

Choose a tool for the current question; these scripts are a toolbox, not a sequence to run in full. Run `--help` for the actual arguments. Python entrypoints use the standard library; bundlers/browser runners additionally need the explicitly selected Engine/Node/browser dependencies. Use new private output directories and retain source identities.

Tool preparation, correctness probes, intrusive profiling and final throughput are different workloads. A script succeeding qualifies its stated boundary; see [acceptance](verification.md).

For local execution versus native Workers, read [Worker execution](worker-execution.md)
before choosing a performance probe. It distinguishes current App assembly,
classic/V2 documentation and target admission from capabilities actually tested.

## Machine and target control

| Script | Behavior |
| --- | --- |
| [download_info.py](../scripts/download_info.py) | Select a current official channel/OS/architecture from Tencent's live version metadata; read-only, with offline replay support |
| [wechatide.py](../scripts/wechatide.py) | Invoke the official CLI locally or through SSH; extract inline images, retain nested structured errors, and poll login/auth with a bound |
| [android_device.py](../scripts/android_device.py) | Read ADB authorization, Android and WeChat versions locally or through the existing SSH machine config; saves private device identities without opening apps or changing settings |
| [android_game_capture.py](../scripts/android_game_capture.py) | Capture one explicitly selected Mini Game foreground, its PNG extent/hash and optional current-process logs; refuses other activities and links the selected publication manifest |
| [scrcpy_handshake.py](../scripts/scrcpy_handshake.py) | On the ADB machine, verify the pinned official server, qualify a control-only connection without sending input, and check owned process/forward/JAR cleanup |
| [wait_game.py](../scripts/wait_game.py) | Observe the ordinary Host until 60 scene-ready Renderer completions, failure or a deadline, then copy the official screenshot; no input, reload or project mutation |
| [android_game_input.py](../scripts/android_game_input.py) | One guarded tap, swipe or editing key event using a current `android_game_capture.py --for-input` receipt; checks selected device, foreground, lock and display identity. Sparse interaction only, not a continuous performance driver. |
| [android_game_multitouch.py](../scripts/android_game_multitouch.py) | Replay the shared timed contact snapshots through the pinned scrcpy control protocol, with foreground monitoring and owned contact cleanup; see [continuous Android input](android-continuous-input.md) for qualification limits. |

## Publication and UI workloads

| Script | Behavior |
| --- | --- |
| [build_blitz_probe.py](../scripts/build_blitz_probe.py) | Verify exact clean Blitz source and tools, build the locked native/WASM pixel fixture, and emit a simulator project plus byte identities |
| [build_ui_dom_fixture.mjs](../scripts/build_ui_dom_fixture.mjs) | Bundle the actual public UI/WeChat entries, matched WASM and an explicitly supplied font; `--scene settings` reuses the complete capability-lab controls and controller |
| [measure_wasm.mjs](../scripts/measure_wasm.mjs) | Measure supplied WASM files as raw, gzip-9 and Brotli-11 bytes, retaining exact SHA-256 identities |
| [build_ui_gpu_benchmark.mjs](../scripts/build_ui_gpu_benchmark.mjs) | Bundle the 2532x1170 / DPR3 benchmark or `--scene gallery` / `--scene settings` with actual display/DPR and native input through the production GPU UI compositor; reuse Engine outputs and freeze WASM/font with `--reference` |
| [run_ui_gpu_benchmark.mjs](../scripts/run_ui_gpu_benchmark.mjs) | Run three pixel comparisons and cleanup by default; `--performance` enables 60-frame acceptance phases, while separate `--cpu-profile` collects V8 CPU attribution |

## Native failures and memory

| Script | Behavior |
| --- | --- |
| [diagnose_phone_startup.py](../scripts/diagnose_phone_startup.py) | Verify and clone a publication with the [native startup probe](../scripts/phone_startup_prefix.js); `--observe-startup --minimum-scene-frames 60` checks new scene completions and exports structured errors; optional `--inspection-read ID` retains existing game projections; `--observe-wasm-lifetime` adds bounded 1-second memory/native call/free samples and passive GL fence counts inside/outside synchronous submit (diagnostic only, no FPS/performance qualification). `--observe-frames` records a timed receipt window; `--observe-gl-link` records original pipeline status/GLSL; `--report-url` sends one completed report through explicit ADB reverse |
| [receive_phone_gl_report.py](../scripts/receive_phone_gl_report.py) | Receive an explicitly selected startup/GL report on loopback; startup saves bounded run/source-bound checkpoints while waiting for the terminal report. Verifies full-body and available GLSL hashes, keeps checkpoint-only expiry incomplete and exits within a deadline; [startup usage](android-device.md#retrieve-structured-startup-errors), [GL usage](android-device.md#retrieve-a-gl-report-when-vconsole-is-unreadable) |
| [android_reverse.py](../scripts/android_reverse.py) | Maintain one explicitly owned reverse port across a bounded preview launch; verify restoration after USB transport loss and reject conflicting mappings. Caller owns exact-port cleanup. |
| [build_worker_probe.mjs](../scripts/build_worker_probe.mjs) | Bundle a separate main/Worker capability probe with exact entry hashes, a strict V2 admission guard and bounded cleanup; [Worker usage and qualification limits](worker-execution.md#build-and-retrieve-a-bounded-capability-probe). |
| [receive_worker_report.mjs](../scripts/receive_worker_report.mjs) | Receive one source/run-bound Worker report at an explicit loopback endpoint; enforce 64 KiB/hash/deadline limits and save original bytes plus a storage receipt. |
| [analyze_phone_lifetime.py](../scripts/analyze_phone_lifetime.py) | Offline analysis of bounded native lifetime reports: separate WASM instances, capacity windows, native throws, collector notes and fence call balances. See [memory diagnosis](memory-diagnosis.md). |

Startup mode automatically includes static module-closure evidence, a fresh run
ID, actual native Fiber states, bounded package I/O and asset traces. Its
`phone_native_package_io.js`, serializer and checkpoint transport are implementation
modules of `diagnose_phone_startup.py`, not separate probes to assemble by hand.
Use the [single startup workflow](android-device.md#retrieve-structured-startup-errors)
before adding another collector. Explicit progress/result UI remains optional.

## Rendering evidence

| Script | Behavior |
| --- | --- |
| [capture_rhi.py](../scripts/capture_rhi.py) | Export one debug-enabled frame in 16 KiB chunks or automatically copy/verify/ACK native windows of at most 1 MiB with `--native-root`; verify the whole tape and release temporary state |
| [build_digest_probe.mjs](../scripts/build_digest_probe.mjs) | Bundle the actual RHI Debug digest owner into a zero-graphics Mini Game; compare native selection and forced JS fallback on 64 B and 1 MiB inputs |
| [sample_canvas.py](../scripts/sample_canvas.py) | Pair one bounded actual Canvas region and an inspected UI positive control with the official simulator image; preserves GL read/pack state and current receipts |

## Performance attribution

| Script | Behavior |
| --- | --- |
| [build_gameplay_benchmark.mjs](../scripts/build_gameplay_benchmark.mjs) | Derive a manifest-bound native observer or Browser Host from the complete ordinary publication, preserving its scene, UI and matched payloads; [gameplay workflow](gameplay-performance.md). |
| [run_gameplay_benchmark.mjs](../scripts/run_gameplay_benchmark.mjs) | Qualify real Browser multi-touch, replay four gameplay phases and drain actual App completions; records bounded dispatch and landing evidence separately from FPS acceptance. `--help` lists the CLI; `--cpu-profile` or `--trace completion\|input\|gpu` select separate diagnostic runs. |
| [browser_completion_timing.mjs](../scripts/browser_completion_timing.mjs) | Bounded passive observation of existing GL fences/polls/flushes, timers and rAF; preserves original calls and restores owned hooks. [Coverage and limits](completion-timing.md). |
| [phone_completion_timing.mjs](../scripts/phone_completion_timing.mjs) / [gameplay_frame_timing.mjs](../scripts/gameplay_frame_timing.mjs) | Opt-in bounded native driver/timer/Platform observation; preserves original Promise and existing work. Builder flag `--completion-timing`; [coverage and limits](completion-timing.md#native-phone-or-simulator-completion-diagnosis). |
| [analyze_phone_completion.mjs](../scripts/analyze_phone_completion.mjs) | Validate native timing, CPU/drain/clock coverage and optional explicit-cap credit joins; preserve outside-callback submissions without guessing cause. New sanitized output only; never GPU-time or FPS acceptance. |
| [build_completion_timing_fixture.mjs](../scripts/build_completion_timing_fixture.mjs) | Build the actual native driver plus shared late-timer/false-poll/FIFO scenarios for a paused official game realm; no Node dependencies or game timer replacement. |
| [browser_gameplay_input.mjs](../scripts/browser_gameplay_input.mjs) | Observe actual DOM pointer endpoints and player-control MessagePort calls without injecting game messages; [input conservation diagnosis](browser-gameplay-input.md). |
| [browser_gameplay_gpu.mjs](../scripts/browser_gameplay_gpu.mjs) | Opt-in native WASM export projection for separate submit/present GPU query intervals; bounded recording, collection after App drain and unchanged default Host path. [GPU timing limits](browser-gameplay-gpu.md). |
| [analyze_chromium_gpu_decoder.mjs](../scripts/analyze_chromium_gpu_decoder.mjs) | Offline Chrome GPU-service command ranking with reused-ID pairing, explicit time/mark windows, input hashes and incomplete coverage; [GPU-process CPU and UBO diagnosis](gpu-process-cpu.md). |
| [run_simulator_gameplay_benchmark.mjs](../scripts/run_simulator_gameplay_benchmark.mjs) | Use the exact existing simulator game target, qualify public native touch delivery, verify frozen bytes and run the shared workload without reopening or resizing the project. Optional `--native-release-witness` separates public native release from a missing ACK in a diagnostic run; [interpretation](gameplay-performance.md#diagnose-a-missing-terminal-ack). |
| [run_phone_gameplay_benchmark.py](../scripts/run_phone_gameplay_benchmark.py) | Source-bound finite phone capture over an explicitly configured ADB reverse; gameplay uses reviewed native input and the shared scrcpy timeline. An explicit [stationary CPU/completion mode](gameplay-performance.md#stationary-cpucompletion-diagnosis) waits for a new after-ready arm marker without creating contacts. Both retain the original clock, debug, drain and report-hash checks. [Phone workflow](gameplay-performance.md#run-on-an-android-phone). |
| [phone_gameplay_transport.mjs](../scripts/phone_gameplay_transport.mjs) | Retain the first native request/readiness error and retry one immutable final payload; explicit transport diagnosis permits one pre-arm native error modal and an input-free receiver. [Missing-report diagnosis](gameplay-performance.md#diagnose-a-missing-phone-report). |
| [phone_report_recovery.mjs](../scripts/phone_report_recovery.mjs) | Separate root entry reads one to four explicit owned native report paths, checks original bytes/SHA and optionally exports unchanged bytes after independently prepared debug-enabled re-entry. Loads no Engine and never toggles debug; black background with native summary is expected. [Real-phone recovery and capability limits](gameplay-performance.md#observed-debug-recovery-and-native-report-retrieval). |
| [phone_gameplay_socket.mjs](../scripts/phone_gameplay_socket.mjs) / [phone_gameplay_ws_host.mjs](../scripts/phone_gameplay_ws_host.mjs) | Shared socket boundary and fixed `ws` carrier into the Python input/clock owner. Gameplay never toggles debug and records its actual state; the separate transport probe alone exercises the native debug API. All current phone runs are diagnostic, never a clean FPS pass. |
| [phone_gameplay_transport_probe.mjs](../scripts/phone_gameplay_transport_probe.mjs) / [run_phone_transport_probe.mjs](../scripts/run_phone_transport_probe.mjs) | Separate fixed WebSocket probe with retained debug callbacks and immutable report export; uses `ws`, never arms, pauses or inputs. Short transport success did not establish continued lifetime: a later isolated debug-disable call ended the tested game. Keep toggles out of gameplay. [Evidence](gameplay-performance.md#diagnose-a-missing-phone-report); [regression](../scripts/__tests__/phone-transport-probe.test.mjs). |
| [phone_gameplay_qualification.mjs](../scripts/phone_gameplay_qualification.mjs) | Separate sparse player-state diagnosis with observed walk/run speed, rising jumps, camera rotation and sampling costs; never clean FPS evidence. |
| [analyze_gameplay_performance.mjs](../scripts/analyze_gameplay_performance.mjs) | Analyze completed-frame intervals, phase throughput, tails, gaps and input validity offline; retains incomplete and failed runs rather than averaging them into a pass. |
| [mac_headroom.py](../scripts/mac_headroom.py) | Record bounded CPU/GPU, memory, paging and thermal intervals; `--gpu-owners` attributes GPU counter increments to processes without changing running applications |
| [native_scheduler_fixture.js](../scripts/native_scheduler_fixture.js) | Reversible owned-project bootstrap for 600 native rAF timestamps and explicit preferred FPS; isolates host callback cadence without Engine frames or per-frame drawing. [Usage](performance.md#isolate-native-callback-pacing) |
| [profile_game_cpu.mjs](../scripts/profile_game_cpu.mjs) | Sample the exact owned game target through an existing authorized CDP endpoint for 10-20 seconds on the DevTools machine; verify local publication bytes, emit a start signal and retain a private V8 profile plus cleanup result |
| [measure_game_throughput.py](../scripts/measure_game_throughput.py) | Qualify Mac headroom, verify all ordinary publication files, own a new simulator window, and measure idle or actual game-3d touch operations with concurrent monitoring and owned cleanup; [usage](performance.md#ordinary-simulator-throughput) |
| [analyze_ui_cpu_profile.py](../scripts/analyze_ui_cpu_profile.py) | Attribute the retained UI CPU profile through real paint ancestry, preserving native-source identity and separating strip/glyph/ABI costs |
| [run_game_scene_profile.mjs](../scripts/run_game_scene_profile.mjs) | Run a source-bound complete scene through ordinary App controls, CPU sampling, separate native GPU queries, or bounded submission/completion observations; hardware admission remains caller-owned |
| [analyze_game_scene_profile.mjs](../scripts/analyze_game_scene_profile.mjs) | Attribute retained CPU profiles through a manifest-bound source map and report native GPU intervals without treating idle time as GPU work |
| [analyze_frame_receipts.mjs](../scripts/analyze_frame_receipts.mjs) | Match submission/completion identities and App credit counters, separating callback delay, throttled ticks and drained work from GPU timing |
| [measure_webgl_submission.mjs](../scripts/measure_webgl_submission.mjs) | Collect bounded native GPU elapsed queries around synchronous submission without wrapping GL methods; invalid/disjoint results remain failures |

For an empty phone receiver, establish the executing root entry before blaming
App pause, timers or receipt drain. Official preview success, a fresh Android
Activity and a restored tile do not prove a new JS realm. See the
[entry-marker and official lifecycle boundaries](gameplay-performance.md#establish-which-phone-entry-executed).
For native input, also review overlays: Blitz rectangles do not include the
vConsole floating button, which was observed covering the runner's Jump center.
Move it through native UI and recapture before qualification, keeping debug
unchanged. The recovered stationary CPU report and unavailable GPU timer remain
separate from native action and clean FPS acceptance.

## Tool qualification

The checked-in `test_*.py`, `test_*.mjs` and `__tests__/` files exercise tooling contracts. Run the affected suite when changing a helper. Browser qualification scripts create real contexts and need their declared environment; do not use software-driver timing as hardware acceptance.

| Script | Behavior |
| --- | --- |
| [test_scrcpy_handshake.py](../scripts/test_scrcpy_handshake.py) | Offline checks for server integrity, zero-input handshake, failure cleanup and isolation from other sessions |
| [test_android_game_multitouch.py](../scripts/test_android_game_multitouch.py) | Offline shared-timeline/protocol checks, bounded scheduling, foreground changes and partial-socket cleanup; no physical input claim. |
| [test_phone_gameplay.py](../scripts/test_phone_gameplay.py), [test_phone_gameplay_observer.mjs](../scripts/test_phone_gameplay_observer.mjs) | Real loopback/source/hash/barrier tests plus unchanged-debug, pre-arm retry and shared-observer drain contracts; offline tool qualification only. |
| [phone-gameplay-build.test.mjs](../scripts/__tests__/phone-gameplay-build.test.mjs), [phone-gameplay-ws-host.test.mjs](../scripts/__tests__/phone-gameplay-ws-host.test.mjs) | Actual Chrome 70 diagnostic bundles and `ws` forwarding into the Python clock/identity/report owner, including hashed POST and CLI symlink startup. |
| [phone-gameplay-transport.test.mjs](../scripts/__tests__/phone-gameplay-transport.test.mjs), [phone-gameplay-qualification.test.mjs](../scripts/__tests__/phone-gameplay-qualification.test.mjs) | First native failure, immutable retry and bounded modal contracts; sparse player evidence with failed-input and incomplete-sampling rejection. |
| [gameplay-benchmark.test.mjs](../scripts/__tests__/gameplay-benchmark.test.mjs) | Shared timeline, completion observation, input backpressure, landing and strict interval-analysis regressions. |
| [gameplay-cdp.test.mjs](../scripts/__tests__/gameplay-cdp.test.mjs) | Optional real Chromium touch lifecycle qualification on a plain DOM page; requires an explicit Playwright module and does not measure rendering. |
| [simulator-gameplay-benchmark.test.mjs](../scripts/__tests__/simulator-gameplay-benchmark.test.mjs) | Simulator target, native contact bridge, coordinate conversion and frozen-publication checks; real IDE qualification remains separate. |
| [native-release-witness.test.mjs](../scripts/__tests__/native-release-witness.test.mjs) | Public wx Start/End/Cancel lifecycle, bounded history, native IDs, invalid/replaced evidence and owned listener removal; no ACK synthesis or native-device claim. |
| [worker-probe.test.mjs](../scripts/__tests__/worker-probe.test.mjs) | Offline generated-entry, admission/transfer, error/termination and primitive readback checks, plus actual loopback hash/source/size/deadline behavior; no physical Worker or FPS qualification. |
| [verify_phone_native_gl_errors_webgl.mjs](../scripts/verify_phone_native_gl_errors_webgl.mjs) | Exercise the actual startup collector and canonical WASM in sandboxed Chromium WebGL; inject one upload exception, verify its retained first cause before the later Rust panic, and check owned method restoration |
| [verify_phone_gl_link_browser.mjs](../scripts/verify_phone_gl_link_browser.mjs) | Qualify real sandboxed desktop WebGL2 success/failure observation, source hashes, hook restoration and exact report transfer to the loopback receiver; no native WeChat or Engine rendering claim |
| [test_android_game_capture.py](../scripts/test_android_game_capture.py) | Offline checks for foreground rejection, landscape dimensions, process-scoped logs and discarding a capture when the foreground changes |
| [test_android_reverse.py](../scripts/test_android_reverse.py) | Existing, absent, conflicting and malformed reverse inventories; selected-port mutation and post-install verification |
| [test_diagnose_phone_startup.py](../scripts/test_diagnose_phone_startup.py), [test_phone_startup_report.mjs](../scripts/test_phone_startup_report.mjs), [test_receive_phone_gl_report.py](../scripts/test_receive_phone_gl_report.py), [test_phone_native_package_io.mjs](../scripts/test_phone_native_package_io.mjs) | Published-byte/module closure checks; native package errors and callback preservation; actual bundled collector/loopback transfer; checkpoint bounds, duplicate/hash/run rejection, missing terminal and real scene-completion acceptance. Offline qualification, not phone FPS evidence. |
| [verify_canvas_reader_browser.mjs](../scripts/verify_canvas_reader_browser.mjs) | Qualify the Canvas collector against exact native WebGL2 pixels, read/pack restoration and a forced read failure; collector-only evidence |
| [test_scripts.py](../scripts/test_scripts.py) | Regression checks for quoting, nested failures, image extraction, artifact isolation, and download selection |
| [test_wait_game.py](../scripts/test_wait_game.py) | Offline checks for evaluation envelopes, scene counters, deadlines, pending failures and required local screenshots |
| [test_measure_game_throughput.py](../scripts/test_measure_game_throughput.py) | Offline checks for stale/busy headroom, publication drift, ordinary counter identity, failed-touch release, and preservation of existing windows |
| [verify_ui_benchmark_pair.mjs](../scripts/verify_ui_benchmark_pair.mjs) | Verify paired workload/module/payload identities and native bootstrap/cleanup without browser globals; offline only, no GPU or performance claim |

Some helpers are implementation modules loaded by a documented entrypoint (for example `phone_*_prefix.js`, `phone_native_*_errors.js`, `shader_sources.mjs` and `read_canvas.js`). Keep their lifecycle and tests with that caller instead of invoking them as unrelated probes.

Machine configuration, login QR, tokens, AppIDs, device serials and raw logs stay private. Deployment helpers do not infer permission to release/upload a game. Examples with sample paths are parameters to replace, not paths to historical machines.
