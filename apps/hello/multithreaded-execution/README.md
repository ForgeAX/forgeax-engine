# Multithreaded execution reference

Production browser reference for composable Worker policies. The default enables Engine and Render Workers alongside eligible shared numeric `QuerySpan` kernels.

## Run

```bash
pnpm --filter @forgeax/hello-multithreaded-execution dev
pnpm --filter @forgeax/hello-multithreaded-execution smoke:browser
pnpm --filter @forgeax/hello-multithreaded-execution gauntlet
pnpm --filter @forgeax/hello-multithreaded-execution bench:production
pnpm --filter @forgeax/hello-multithreaded-execution m0
```

The Vite server and preview send `COOP: same-origin` and `COEP: require-corp`. The page defaults to auto. `?tier=` names fixed test scenarios, not an Engine API. Open `/?tier=render-worker` (render isolation), `/?tier=shared` (co-located Renderer plus kernels), `/?tier=auto` (both), or `/?tier=auto&fault=1`. The fault route performs one possible partial write, stops simulation, exposes `shared-kernel-failed`, and allows explicit rebuild to a fresh World identity.

`gauntlet` is the independent Engine Gauntlet scenario. It drives the public App/ECS surfaces through all five fixed worker scenarios, captures Host input/update/frame-credit/render evidence, forces the shared partial-write poison path, rebuilds through `app.execution.rebuild()`, and records cleanup order plus the second-stop `app-not-started` no-op. It also runs the explicit unavailable-worker path and requires a structured refusal naming the worker and missing capabilities.

The gauntlet-only Mesh/Camera/Light witnesses are created when telemetry is requested; the default smoke and production benchmark retain the lightweight particle workload while the gauntlet keeps its real rendering evidence.

## Evidence gates

| Command | Proves | Threshold |
|:--|:--|--:|
| `m0` | Real response headers, Worker capability matrix, and raw SAB Kernel speedup | Shared p50 speedup >= 1.5x |
| `smoke:browser` | Real production bundle, independent and combined Worker policies, shared dispatch, poison freeze, falsification, and rebuild | All structural assertions pass |
| `gauntlet` | Independent semantic/live/GPU/behavioral/recovery evidence, including capability truth and idempotent cleanup | Prints `M12_EXECUTION_POISON_REBUILD_PASS` |
| `bench:production` | Same Engine Worker and workload with forced-inline versus shared raw Host-frame samples, measured in two alternating treatment-order rounds | A qualified runner and a 95% confidence interval lower bound for p95 improvement >= 15% |

The benchmark uses 65,536 rows, 96 iterations per row, 20 warmup frames, and 240 retained samples per tier per round. It alternates the forced-inline and shared treatments in both orders to keep the p95 comparison inside the same scheduler/thermal epochs. It reads end-to-end `host-frame` durations from the App-owned bounded Profiler capture, retains presentation cadence as secondary evidence, and writes raw samples, distribution summaries, order metadata, pause evidence, and a deterministic 95% bootstrap interval to the active closed-loop evidence directory. Before accepting the verdict it compares the browser's `hardwareConcurrency` with the Node cgroup capacity; a material mismatch is recorded as `runner-unqualified` and fails closed. An isolated host pause (at least 250 ms and 10x the tier p95) is recorded as runner-instability evidence and gets one bounded fresh-process retry; sustained slow frames still fail the product verdict.

Ordinary CI runs the capability matrix, raw-kernel speedup and production smoke.
`bench:production` remains an explicit diagnostic with its original 15% threshold
and raw samples. Shared runner CPU capacity and affinity do not establish stable
end-to-end timing, so the frame-p95 verdict is outside the ordinary CI and generic
metrics gates. A passing raw-kernel result does not prove end-to-end improvement.

## Module boundaries

The demo explicitly allows 30 seconds for startup. Its production build carries
the complete 137 MiB shader manifest in both source and render realms; a local
Chrome Beta 155 / SwiftShader diagnostic reached ready in 19.2 seconds, with
manifest response-to-validation intervals of 4.73 and 4.68 seconds. The earlier
15-second deadline expired during child initialization. The browser readiness
limit remains 30 seconds, and frame, dispatch, poison and rebuild checks retain
their existing limits. This startup measurement is not a frame or transport
latency measurement.

| File | Owner |
|:--|:--|
| `src/shared-bootstrap.ts` | Realm-local World population and system registration |
| `src/shared-kernel.ts` | Inline reference function and independently loadable shared Kernel |
| `src/fault-kernel.ts` | Deliberate partial-write fault used only by the fault route |
| `scripts/smoke-browser.mjs` | Browser contract and falsification gate |
| `package.json#forgeax.gauntletScenario` | Independent route declaration and evidence-leg metadata for the Engine Gauntlet |
| `scripts/smoke-browser.mjs --gauntlet` | Repository front door that runs the declared scenario and preserves artifacts |
| `scripts/bench-browser.mjs` | Production raw-sample product benchmark |
| `m0/scripts/*` | Capability and raw-Kernel admission evidence |

The public architecture entry is [`@forgeax/engine-app`](../../../packages/app#worker-execution); shared storage and Kernel eligibility belong to [`@forgeax/engine-ecs`](../../../packages/ecs#shared-numeric-kernels).
