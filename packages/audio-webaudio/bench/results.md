# Audio control acceptance results

> [!NOTE]
> Fixed evidence archive contains original PNGs, five native
> rendered WAVs, source hashes, canonical tape digests, readbacks and SHA256SUMS.
> Source implementation: `76fffd8834749a59325d612b941671607882e6e2`.

## Native result

| Check | Measured result |
|:--|:--|
| Speed | 440 Hz at 1x; 880 Hz at 2x |
| Lowpass 1 kHz + gain 0.5 | 440 Hz: -6.180 dB; 8 kHz: -43.818 dB |
| Pause/resume | Silent paused interval; decoded position frozen; resumes retained offset after multiple rates |
| Delay tail + paused volume | Pause RMS 0 after 10 ms transition; resume RMS 0.088388 at volume 0.25; position frozen at 0.250667 s |
| Native FFT | 1 kHz peak within one 4096-point FFT bin; paused output is silent |
| Real Worker / pending decode | Ordered POD controls applied on Host; latest rate/pause retained; stop fences decode/resume |
| Lifecycle | No new source nodes during steady control/FFT sampling; zero active and retained sources after stop |

Eight native browser tests passed. The initial speed test failed before the fix;
red and green logs are retained in the archive. A separate native delay-tail
reproducer measured paused RMS 0.224434 before the source-gain correction. Existing audio/package tests plus
shared audio error type checks passed: 684 tests across 79 files. Full repository
typecheck, changed-source Biome, metric declarations and test-layout checks passed.

## Host cost

Apple M4 Pro / macOS arm64 / Chrome Beta 149 / 48 kHz. Each voice has an ordered
lowpass + gain chain, a 2048-point analyser and reused output array. After 20 warmups,
120 batches update all rates, read all spectra and sample state; 20 pause/resume
batches are measured separately. This was not a dedicated benchmark host.

| Sources | Control + FFT p50 ms | p95 ms | p99 ms | Pause/resume p95 ms |
|:--|--:|--:|--:|--:|
| 1 | 0.005 | 0.005 | 0.010 | 0.020 |
| 32 | 0.080 | 0.630 | 0.680 | 0.190 |
| 128 | 0.320 | 2.485 | 2.590 | 0.950 |
| 256 | 5.125 | 5.265 | 5.280 | 1.805 |

Native output waveforms and measured cost

These are CPU wall-time batches, not audio-thread deadline, device latency or FPS
measurements. The JSON also records native offline rendering of one second of DSP
for 1/32/128 voices, dry and filtered, five repeats. No cross-engine performance
ranking is claimed. Native output WAVs are available in the archive's `data/` folder.

## RHI Debug

Four states each contain 26 indexed draws plus one composition. Work 2's actual
pipeline/bindings are inspected; all 24 mesh transforms are read from its bound GPU
uniform buffer with effective 256-byte dynamic slots. Captured depth/output clears
explain the two unseeded targets. All matrices are finite, and paused bar height is
0.02. Fresh Dawn Metal replay versus raw canvas is p99=0 and max=1/255 for every
state, with no GPU validation, JavaScript or network errors.

Dry
Lowpass
Paused
Resumed at 2x

The GPU tape proves the spectrum-driven ECS/render path. Native signal tests prove
audio behavior; RHI Debug does not contain or verify audio samples. Gzip storage
preserves each uncompressed v7 tape's SHA-256 identity.

## Reproduce and gate boundary

See [probe commands and pinned source references](README.md). Full browser, Dawn
and complete hello/learn-render 60-frame smoke results belong to the final PR's
exact-head CI checks. Local full gates failed on this Metal host: water GPU
timestamps in Dawn; two CanvasTexture offscreen pixel comparisons in browser;
Bloom GPU timing completeness in the 93-gate smoke run (92 passed). These render
fixture sources are unchanged by the audio patch. Baseline reproduction did not
establish that the failures predate it; terminal logs and smoke receipts are
retained. The audio probes above passed on the real native paths.
