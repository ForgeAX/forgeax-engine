# Start with the failing boundary

The workflows below come from the ordinary cross-platform game, composed UI
fixtures, official simulator and Android phone work. Use the current Engine
contracts and installed Tencent skill; [Sources](sources.md) binds historical
observations to their dates and tested publications.

## From a fresh session to useful evidence

1. Discover the existing machine, installed official AI CLI, login and target.
   [Setup](setup.md) and [Tooling](tooling.md) distinguish SSH, client approval and
   account login. A connected phone can be a different model/account from the last
   session. Reuse authorization, but rediscover the device.
2. Select the ordinary project's current source and publication. Keep the matched
   native closure and inventory; [Build](build.md) covers Brotli, subpackages,
   syntax lowering, source admission and IDE metadata. Reuse valid Cook/build
   outputs when their authorities are unchanged.
3. Choose an environment that reproduces the question. [Simulator](simulator.md)
   identifies the real game realm; [Android](android-device.md) covers official
   preview and original device failures. A browser adaptation with explicit Host
   seams is browser evidence, even when its assets came from a Mini Game ZIP.
4. Exercise the visible ordinary game and collect completed scene receipts,
   source identities and the relevant input/resource facts. Start with the
   smallest useful reproduction; increase duration or instrumentation only when
   the unresolved failure needs it.

## Symptom to measurement

| Symptom | Useful next evidence and route |
| --- | --- |
| CLI succeeds but the game is absent, stale or still loading | Check the nested result, remote project path, actual game realm and current bundle identity. Query startup phase/first cause, not just the driver global. [Simulator](simulator.md#select-the-actual-game-realm), [startup report](android-device.md#retrieve-structured-startup-errors). |
| Compilation succeeds; startup fails before the first scene | Check the generated module closure, native factory and syntax pass. WeChat lacks some browser/Node globals; do not patch globals indiscriminately. [Build](build.md), [native restrictions](engine-integration.md#native-runtime-import-restrictions). |
| Canvas clears or frame counts increase but the scene is missing | Distinguish loading/UI frames from scene-presented frames and inspect root activation/first App failure. [Scene admission](engine-integration.md#separate-graphics-readiness-from-scene-admission). |
| Vase missing after generation | Compare original/accepted parameters, GUID/entity, content generation, mesh bounds and material residency. If these are valid, inspect the real failing draw/resource. [Parameter receipts](android-device.md#parameter-interaction-receipts), [RHI capture](rhi-capture.md). |
| Missing glyph, square plus X, wrong checkbox/radio/range or dialog layout | Use the same authored HTML/CSS and actual font bytes; exercise composed settings, gallery and forms. Distinguish control state from facade expandos and normal browser decoration from missing behavior. [Blitz](blitz.md), [appearance criteria](verification.md#browser-appearance-and-backend-parity). |
| GPU UI loses layers, opacity or clipping | Pair native Canvas readback with a UI positive control; inspect the first divergent resource/work item across backends. Replaying UI in isolation can miss composition failures. [Canvas readback](canvas-readback.md), [GPU UI capture](performance.md#gpu-ui-capture-and-replay). |
| Phone keyboard is blank, deletes a default, or rejects decimals/signs | Inspect the actual native editor and physical key sequence. HTML unlimited length is not a native `-1`; a visible decimal key does not prove that native number input accepts it. [Keyboard round trip](simulator.md#native-keyboard-round-trip), [phone input](android-device.md#resume-the-phone-journey). |
| Input bar obscures the game | Separate WeChat's editor bar from the IME/floating keyboard. Check the documented API before promising placement control; preserve character-entry and layout results separately. [Phone keyboard limits](android-device.md#resume-the-phone-journey). |
| Movement looks like skipped animation frames | Measure native clock units, elapsed/fixed-step behavior, player transforms and presentation timing. A still screenshot cannot distinguish simulation jitter, callback cadence and GPU backlog. [Clock](engine-integration.md#clock-and-display), [mobile controls](mobile-game.md), [performance](performance.md). |
| Mac is slow even before the test | Measure CPU, paging, thermals and per-client GPU deltas. Old process age or an open simulator alone does not identify the load. Preserve active shared work; re-admit after authorized cleanup. [Host capacity](performance.md#host-capacity-first). |
| Scene/UI stays near 30 FPS or slows during input | Fix a workload, resolution, backend and asset identity. Use completed frames; separate uninstrumented throughput from CPU samples, GPU queries and RHI capture. Compare hardware WebGL if the simulator itself is the bottleneck. [Performance](performance.md), [tool selection](toolbox.md#performance-attribution). |
| DFG/PBR cost dominates | Isolate the actual draw/pass, inspect the emitted shader, and compare the default numerical fit with explicitly enabled texture mode using equivalent rendering. Do not benchmark a constant replacement as a correct fix. [DFG verification](performance.md#dfg-fit-and-opt-in-texture-verification). |
| Native `unreachable`, `pending_writes` or a parking panic | Keep the first native GL exception, Rust panic and WASM export failure; later traps can be secondary. Use bounded collectors and source-bound transfer. [Native error collection](android-device.md#retrieve-the-original-rust-panic). |
| Memory still rises after a fence fix | Distinguish host sync progress, actual native queue retirement and binding-owned references/descriptors. Compare equal reuse windows and preserve already-created resource consumers. [Memory diagnosis](memory-diagnosis.md). |
| Rotation stretches the scene without a resize callback | Record orientation event, native window/safe area, Canvas dimensions and current image. Successful orientation API return is not layout success. [Orientation](simulator.md#native-orientation-and-current-image-coordinates). |
| Remote assets, disk cache or audio fail only natively | Follow the existing PackageFetcher/Audio/Net owner and retain original native permission/status/callback evidence. A Node callback-shaped test is not phone qualification. [Native services](native-services.md). |

## Make tools reusable without freezing a workaround

Put repeatedly rewritten transport, bounded observation and offline analysis in
[scripts](toolbox.md). Keep paths, device/account identifiers, output destinations
and source identities as explicit inputs. Keep each tool's admission checks,
failure receipt and owned cleanup in its implementation and regression tests.
An analysis should preserve unavailable fields and sampling loss instead of
manufacturing zeros or claiming a complete trace.

Code that changes game behavior belongs to the Engine, asset producer or template
owner. A temporary probe may observe or perturb one stated hypothesis; retain its
identity and restore the ordinary publication afterward. Do not adopt a global
`URL`/`WebAssembly` shim, placeholder texture, hand-driven frame loop or test-only
material as the game's permanent native implementation.

Publish enough evidence to reproduce the decision: exact source/native identities,
numeric samples with time origins, acceptance limits and reviewed screenshots.
Keep screenshots on a durable revision with verified accessible links. Refer to
[verification](verification.md) for the boundary each artifact actually proves.
