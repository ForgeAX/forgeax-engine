# G18 spatial source acceptance

Source pose now follows Scene's propagated world matrix through play/update POD
intents into Host-owned native panners. Parented motion is consumed in the same
Update, before playback starts or resumes. Directional cones make emitter
orientation observable; stationary and 2D sources publish no pose updates.

> [!IMPORTANT]
> Signal and allocation falsifiers passed. CPU measurements below were made on
> a heavily contended host and do **not** establish stable frame-budget compliance,
> audio-thread CPU, device latency, deadline misses or parity with another engine.
> Full repository Browser, Dawn and 60-frame fleet gates are recorded separately
> from this package's native audio acceptance.

## Reference implementation decisions

| Reference | Fixed primary source | Applied result |
|:--|:--|:--|
| Three.js r184 | [PositionalAudio.js](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/src/audio/PositionalAudio.js) | World pose, panner position/orientation and cone gain; Forge uses Scene's local -Z convention rather than Three's emitter +Z |
| Godot 4.7.2 | [audio_stream_player_3d.cpp](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/scene/3d/audio_stream_player_3d.cpp) | Propagated source/listener positions, distance attenuation and emission direction; room routing and Doppler are separate capabilities |
| UE 5.8.1 | AudioComponent.cpp | Source transform handed to the audio owner; Forge transports six POD scalars across its existing Worker/Host seam |

These sources were read from the knowledge-base reference checkouts, including
`git show` at the Godot audit pin. No upstream engine code was copied. RHI Debug
is not applicable to this audio change; the decisive output is native PCM, with
real Worker transport and lifecycle tests. No renderer or shader was changed.

## Native signal results

Chromium 149.0.7827.3, 48 kHz stereo OfflineAudioContext, mono 440 Hz sine at
amplitude 0.5. RMS excludes transition windows.

| Case | Left RMS | Right RMS | Falsifier |
|:--|--:|--:|:--|
| Source at +X, distance 1 | 0.000000 | 0.353553 | Left < 1e-5, right > 0.35 |
| Source at -X, distance 1 | 0.353553 | 0.000000 | Channels exchange |
| Source at +X, distance 4 | 0.000000 | 0.088388 | Far/near = 0.25 +/- 1e-4 |
| Narrow cone facing listener | 0.250000 | 0.250000 | Toward signal retained |
| Cone facing away, outer gain 0.1 | 0.025000 | 0.025000 | Away/toward = 0.10 +/- 1e-4 |
| 2D source at distance 100 | 0.353553 | 0.353553 | No spatial attenuation or channel bias |

Native inverse-distance gain uses $g(d)=1/\max(1,d)$ for reference distance and
rolloff 1. The one-second stereo WAV captures left, right, paused silence and
left after a move during pause. The plotted envelope uses 20 ms RMS windows.

| Runtime path | Evidence |
|:--|:--|
| Parent transform + nonuniform scale | Same Update play pose x=12, then changed pose x=-8 with unit -Z |
| Pending native decode | Latest moved pose wins before node start; initial options are snapshotted |
| Real Worker | Scene plugin + audio plugin produce play at -X, then parent movement updates native output to +X; despawn stops the source |
| Pause/resume | Retained panner moves while paused and resumes in the new channel |
| Invalid source pose | `control-failed`, valid native panner remains unchanged |
| Source transform removal | Pose resets to origin/-Z; no stale coordinates remain |
| Native lifecycle | No new panner or buffer source during any pose-update workload; all sources stop on disposal |

The original source-pose unit reproducer fails against the baseline tick and
passes with the owning producer/consumer fix. Package tests: 117 unit cases and
25 native browser cases pass. The old short-clip recovery test also failed with
the unmodified baseline WebAudioEngine: a 100 ms one-shot can end before timer
polling observes admission. Its probe now records actual active-source count
synchronously after native admission, retaining the original duration, real
decode, natural completion and no-unhandled-rejection assertions.

## CPU and allocation measurements

Apple M4 Pro, macOS arm64, 12 logical CPUs. Load averages changed from
81.82/73.72/54.42 to 88.05/75.47/55.38 during this run. Each workload uses
64 warmup ticks and 240 measured ticks. The clock brackets the production
`audioTickSystem` scan, changed-pose intent emission and native Host setters.
Authored transform writes, propagation, initial decode, Worker transport, native
mixing and device output are outside this CPU interval. Timings are milliseconds.

| Sources | Mode | P50 | P95 | P99 | Pose intents incl. warmup |
|--:|:--|--:|--:|--:|--:|
| 1 | 2D | 0.010 | 0.060 | 0.140 | 0 |
| 1 | static | 0.005 | 0.010 | 0.030 | 0 |
| 1 | moving | 0.010 | 0.025 | 0.060 | 304 |
| 32 | 2D | 0.050 | 0.220 | 0.960 | 0 |
| 32 | static | 0.035 | 0.310 | 6.320 | 0 |
| 32 | moving | 0.125 | 0.265 | 0.500 | 9728 |
| 128 | 2D | 0.105 | 1.010 | 10.445 | 0 |
| 128 | static | 0.115 | 0.295 | 10.900 | 0 |
| 128 | moving | 0.655 | 4.605 | 40.585 | 38912 |

Static and 2D workloads emit zero poses. Moving workloads emit one six-scalar
pose per source per tick, with no clip bytes and no new native nodes. The
128-source moving run admits 128 panners and 128 source nodes, reusing them for
38,912 updates. Stationary sources still incur the source scan and temporary
CPU pose projection; zero intents is not a zero-allocation claim.

> [!WARNING]
> The preliminary run measured 128 moving sources at P50 0.430 ms / P95 0.830 ms /
> P99 1.095 ms. The final contended run reached P95 4.605 ms / P99 40.585 ms. Both
> raw sample sets are retained. The latter tail is negative evidence; no threshold
> was relaxed and no observer or scheduler overhead was subtracted. A quiet-host
> run is required before using these numbers as a stable performance budget.

## Reproduce and inspect

```bash
pnpm build:engine
pnpm exec vitest run --project=@forgeax/engine-audio --project=@forgeax/engine-audio-webaudio
pnpm --filter @forgeax/engine-audio-webaudio test:browser
node packages/audio-webaudio/bench/run.mjs --spatial
```

The focused browser entry executes every existing audio browser test without
requiring renderer/Pack asset preparation; all remain in the root Browser
roster as well. The benchmark starts its own Vite server on port 5295 and closes
all owned contexts, browser and server. Set `FORGEAX_AUDIO_EVIDENCE` to select
an output directory.

Default output: `artifacts/g18-spatial-audio/`. `performance.json` contains
checks, all 240 timing samples for each row, source SHA-256 hashes, host load
and browser version. `signal-and-performance.png` was opened and visually
inspected. `moving-source.wav` is the native stereo output. Preliminary
measurements are preserved alongside them.

Live panner parameters use native AudioParam value writes, not accumulated
automation events. Routing and cone settings are sampled at play; pose, pause,
rate and volume remain live. This capability does not implement obstruction,
room acoustics, HRTF selection, Doppler or interpolation policy.

## Repository gate boundary

| Gate | Current evidence |
|:--|:--|
| Source build | `pnpm build:engine` passed; declaration inventory and package runtime closure verified |
| Package unit/type/browser | 117 unit + 25 browser cases pass; package TypeScript build passes |
| Lint, grep, test layout, English guidance | Passed; existing whole-repository lint warnings remain |
| Duplication | Full gate failed with 349 surviving pairs; none involves a changed file; no allowlist or threshold changed |
| Full Browser | Initial entity-visibility case passed; full roster continues through its shader producer |
| Full Dawn | Initial pre-GPU preparation was preserved and stopped to correct the outer lock; canonical full gate resumed with drain-aware per-owner leases |
| Full 60-frame fleet | Preparation failed when the concurrent shared-input producer rebuilt the manifest; valid source/app build outputs and failure logs retained for serial recovery |

Broad pending/failed gates are not a repository-wide PASS and do not disappear
because the native audio cases pass. Local logs remain in the evidence directory.
