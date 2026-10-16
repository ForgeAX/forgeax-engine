# Audio control validation

> [!IMPORTANT]
> These probes execute ForgeaX's native Web Audio graph. CPU timings describe
> this host and workload; they do not rank ForgeaX against Three.js or UE and
> do not measure device latency or audio-thread deadline misses.

## Source baselines

| Reference | Pinned implementation | Applied result |
|:--|:--|:--|
| Three.js r184 `d3b629c0c2097cec664ad16369bb6eae3b10e335` | [`Audio.js`](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/src/audio/Audio.js) `play`, `pause`, `setPlaybackRate`, `setFilters` | One-shot sources, retained decoded progress, ordered native filters; ForgeaX additionally integrates each old-rate interval before changing rate |
| Three.js r184 | [`AudioAnalyser.js`](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/src/audio/AudioAnalyser.js) | Opt-in native analyser and reused output storage |
| UE 5.8.1 `71fe36aac5a8df5ccd66c763ffc902b29b6a9c43` | `AudioComponent.cpp` `SetPitchMultiplier`, `SetPaused`, `SetSourceEffectChain` and active source assembly | Independent speed/pause and source effect ownership |
| UE 5.8.1 | `AudioMixerSource.cpp`, `AudioMixerBlueprintLibrary.cpp` | Sample advance changes pitch; explicit spectrum analysis start and queries |
| W3C | [Web Audio BiquadFilterNode](https://www.w3.org/TR/webaudio-1.0/#BiquadFilterNode) | Lowpass/highpass `Q` is in dB; the Butterworth fixture uses $20\log_{10}(1/\sqrt{2})$ |

The reference checkouts come from
code is copied into the runtime. Speed preserves the comparison's pitch-changing
semantics; it does not claim pitch-preserving time stretching.

## Reproduce

From the repository root after dependency/package setup:

```bash
pnpm build:engine
CI=1 pnpm exec vitest run --config config/vitest.browser.config.ts \
  packages/audio-webaudio/src/__tests__/playback-controls.browser.test.ts
node packages/audio-webaudio/bench/run.mjs
FORGEAX_ENGINE_RHI_DEBUG=1 pnpm --filter @forgeax/hello-audio exec vite --port 5395 --strictPort
# In another terminal:
node apps/hello/audio/scripts/capture-controls.mjs
node apps/hello/audio/scripts/replay-controls.mjs
```

The standalone benchmark owns port 5295 and closes its browser/server. The
interactive fixture uses the tracked asset-submodule SFX through the scoped
Pack catalog and ordinary ECS plugin path. It requires the contributor assets.
Generated evidence defaults to `artifacts/audio-controls/`; set
`FORGEAX_AUDIO_EVIDENCE` to another directory or `FORGEAX_AUDIO_URL` for an
already running recorder-enabled hello-audio server.

## Native acceptance

| Path | Falsifier |
|:--|:--|
| 440 Hz, 1x/2x | Native rendered output must resolve to 440/880 Hz within the finite-window crossing tolerance |
| Multiple rates + pause/resume | Progress matches each context-clock interval; pause is silent and freezes position; resumed samples match the retained offset |
| Delay tail + paused volume edit | Paused output is silent after the 10 ms gain transition; resume restores the latest volume |
| Looping + paused graph edits | Offset wraps at decoded duration; resumed filtered RMS matches the authored gain |
| User lowpass + gain | 440 Hz retains its expected gain; 8 kHz attenuation exceeds 40 dB; removing the chain restores dry magnitude without doubled routing |
| Frequency tap | Native 1 kHz peak within one FFT bin; tap reused; paused reads contain only `-Infinity`; invalid size/context/duplicate nodes fail explicitly |
| Pending decode | Latest rate/pause adopted; stop fences subsequent resume |
| Real Worker | ECS-generated POD controls reach a native Host; position freezes, resumes, stops, and ordered intents match |
| Lifecycle/performance | Stable control/FFT batches create no source nodes; one output array per source; stop leaves zero active and retained sources |

The control benchmark warms 20 batches, measures 120 batches per source count,
and measures 20 pause/resume batches. Each control batch updates every source's
rate, reads every 2048-point analyser and samples state. Configuration allocates
a lowpass + gain chain, one analyser and one output array per source. This is a
CPU batch measurement, not a 60 Hz frame-rate claim. The offline render probe
measures one second of native DSP at 48 kHz, five repeats, with dry and filtered
workloads. Returned source hashes bind the measurements to the implementation.

## RHI evidence boundary

```mermaid
flowchart LR
  Clip["Pack clip"] --> Audio["Host audio graph"] --> FFT["Frequency bins"]
  FFT --> World["24 ordinary ECS mesh transforms"] --> GPU["Captured RHI frame"]
  GPU --> Replay["Fresh Dawn device"] --> Pixels["Live canvas bitmap comparison"]
```

RHI tape contains GPU work and resources, not audio samples. Four states (dry,
lowpass, paused, resumed at 2x) each require 26 indexed cube draws and one
fullscreen composition. The probe inspects the first spectrum draw's pipeline,
bindings and effective dynamic uniform offset, reads all 24 mesh matrices from
the bound GPU buffer, and checks finite values plus the paused minimum height.
It validates the tape digest and compares fresh-device replay against the raw
live canvas bitmap with $p_{99}\le2/255$. Page screenshots independently show
the controls and spectrum. A DOM element screenshot includes overlapping HTML
and CSS background; it cannot serve as a raw framebuffer oracle.

The initial depth/stencil and swapchain targets are unseeded. The captured
scene pass clears depth and the fullscreen composition writes the output;
all bound source buffers are seeded. Retain these diagnostics with the pixel
comparison. The replay probe never substitutes GPU success for native audio
signal tests. Compressed tapes preserve the digest of their decoded canonical
bytes and remain outside the engine's zero-binary source history.

## Measured run

See [acceptance results and original evidence](results.md).

## Spatial source pose (G18)

Run `node packages/audio-webaudio/bench/run.mjs --spatial` for native stereo
signal, inverse-distance/cone falsifiers and production tick/Host CPU samples.
The [spatial acceptance report](./spatial-results.md) separates native output,
Worker evidence, allocation invariants and contended-host performance limits.

## Clip start and seek (G17)

Run `node packages/audio-webaudio/bench/run.mjs --seek`. The probe renders a
48 kHz ramp through start, active seek, pause, paused seek and resume, checks
sample error below $10^{-5}$ outside the existing 10 ms gain transitions, and
exports a WAV plus the plotted native output. It measures ECS edits, tick,
intent transport and Host control together for 1/32/128/256 sources: 20 warmup
and 120 measured batches, with raw samples retained. Active seek must create
exactly one source per request; paused seeks and unchanged ticks create none;
no workload decodes again or rebuilds gains, and despawn releases all sources.
The declared p95 batch budget is $1000/60$ ms. This CPU workload does not measure
audio-thread deadlines or device latency. See [results](./seek-results.md).
