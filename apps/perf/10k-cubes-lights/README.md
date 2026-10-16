# 10k cubes + punctual lights admission

This is one parameterized `engine-performance` pressure consumer. Its no-argument run is the canonical admission point.

| Fact | Fixed contract |
|:--|:--|
| Cubes | `10,000` individually queryable entities, each with `Transform`, `MeshFilter`, and `MeshRenderer` |
| Shared assets | Built-in `HANDLE_CUBE` and one shared standard `MaterialAsset` handle |
| Distribution | Uniform PRNG samples in `[-24,24] x [-16,16] x [-24,24]` |
| Seed | `0x010c0b35` (`PERF_WORKLOAD_SEED`, version `1`) |
| Camera | Transform at the exact volume center `[0,0,0]`, rotating continuously in place |
| ECS work | Named `perf-10k-cubes-rotate` Update system writes every cube quaternion every measured frame |
| Lights | Defaults `16 PointLight + 16 SpotLight`; total is fail-fast bounded to the HDRP `256` light contract |

Scale parameters are query-string values (`cubes`, `pointLights`, `spotLights`) and are included in the workload fingerprint. They change counts only; seed, volume, mesh, material, camera law, pipeline, viewport, and rotation laws remain fixed.

```text
http://127.0.0.1:5207/?cubes=1000&pointLights=8&spotLights=8
```

`smoke` drives the same built app contract through Dawn-node and records the post-spawn query oracle, frame progress, processed-cube count, renderer errors, raw frame samples, and a complete CPU `ProfileCapture`. `smoke:browser` drives the Vite dev-server front door and records screenshot/readback plus browser errors. Neither smoke is an optimization claim.

## Physical benchmark entry and manifest

The physical performance gate is the existing workload's native-runner
carrier, not a second renderer or a software fallback:

```bash
pnpm --filter @forgeax/perf-10k-cubes-lights benchmark:physical
```

[`physical-benchmark-manifest.json`](physical-benchmark-manifest.json) freezes
the seed, camera path, 1080p resolution, warmup, sample floor, and the
1k/10k/100k PBR, 1/16/256 resource-class, shadow, 32/64-joint skin, mixed,
and 1k direct-draw comparison workloads. A native physical runner supplies a
JSON input through `--input <path>` or
`FORGEAX_PHYSICAL_BENCHMARK_INPUT`. The carrier checks the input against the
current checkout revision, adapter identity, `physical=true`,
`isFallbackAdapter=false`, timestamp-query support, runner provenance, raw
CPU/GPU/frame samples, and memory high-water facts before calculating nearest-
rank p50/p95 values and the declared budgets.

When no qualified physical adapter is available, the command writes
`status=not-run`, `acceptance=fail-closed`, and exits `2`. It never relabels
Dawn, RhiNull, software, browser, or historical samples as physical evidence.
An input that fails identity or adapter validation is also `not-run`; a
validated physical run that misses a budget is `failed` and exits `1`.

### Native physical input contract

The input is produced outside this repository by a native runner. The Engine
command is deliberately only the validator/carrier: it never creates an
adapter, substitutes a software device, or invents timing samples. Validate a
runner-produced file with:

```bash
node scripts/benchmark-physical.mjs \
  --input /path/to/native-physical-input.json \
  --output /path/to/physical-benchmark.json
```

The file must use schema version
`forgeax-physical-benchmark-input/1` and contain these top-level fields:

| Field | Required facts |
|:--|:--|
| `testedRevision` | Exact checkout SHA that produced every sample; it must equal the validator checkout `HEAD`. |
| `status` | Must be `complete`. |
| `adapter` | `api: "webgpu"`, `physical: true`, `isFallbackAdapter: false`, `timestampQuery: true`, and non-empty `vendor`, `device`, `driver`. |
| `runner` | `kind: "native-physical"` plus non-empty `name`, `class`, `environment`, `os`, `arch`, and `queue`. Browser, Chromium, gputrace, depot_tools, SwiftShader, lavapipe, and software identities are rejected. |
| `capture` | Manifest-matching `seed`, `cameraPath`, `resolution`, at least `warmupFrames` and `sampleCount`, and positive `memoryHighWaterBytes`. |
| `workloads` | Exactly the workload IDs in [`physical-benchmark-manifest.json`](physical-benchmark-manifest.json). Each workload supplies finite non-negative `cpuMs`, `gpuMs`, and `frameMs` arrays with at least 30 samples plus the manifest-specific `observed` facts; numeric and mixed workloads also supply their direct-draw `baselineFrameMs`. |

The authoritative field checks and budget calculation live in the
[`benchmark-physical.mjs`](scripts/benchmark-physical.mjs) validator; the
manifest remains the single source of truth for workload IDs, scales, camera,
seed, and thresholds. This repository does not ship a native physical runner,
so the normal no-input result is `status=not-run`, `acceptance=fail-closed`,
exit `2` until an eligible hardware runner supplies the file.

## Three.js object-path comparison

Build the consumer and run the explicit local comparison:

```bash
pnpm --filter @forgeax/perf-10k-cubes-lights compare:browser
```

The command serves the production Vite bundle and runs Three.js `0.184.0`
(`WebGPURenderer`) beside the ForgeaX page in fresh Chrome contexts. Both pages
use the same seed, bounds, camera law, `BoxGeometry`/`HANDLE_CUBE` dimensions,
standard-PBR material parameters, `32` clustered punctual lights, viewport,
warm-up, and measured frame count. The default distribution is `16 PointLight
+ 16 SpotLight` only to preserve light-kind parity with Three.js; ForgeaX
routes both kinds through the same Cluster light-data, binning, and shading
path. The comparison deliberately uses 10,000 independent objects; it does
not compare Three.js `InstancedMesh` to ForgeaX entities.

Frame intervals are measured from browser
`requestAnimationFrame` (therefore a Three.js result near 60 FPS can be a
display-vsync ceiling, not proof of unused headroom), while render samples are
the Three.js CPU command-encoding interval and do not wait for GPU completion.

The JSON report is written to `artifacts/three-forgeax-comparison.json` (or
`PERF_COMPARE_OUTPUT`). It contains every run, validation errors, frame-time
percentiles, FPS lower-tail (`p05`), cube-update timing, and the exact Engine
commit / Three.js revision. This is an explicitly invoked experiment, not a CI
performance budget. Use `PERF_RUNS`, `PERF_WARMUP_FRAMES`,
`PERF_MEASURE_FRAMES`, `PERF_CUBES`, `PERF_POINT_LIGHTS`, and
`PERF_SPOT_LIGHTS` to scale it; keep both implementations on the same values
when comparing results.
