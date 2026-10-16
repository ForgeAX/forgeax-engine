# Android scheduling and SurfaceView evidence

Use a short system Perfetto trace when native GPU queries are unavailable or when
you need evidence independent of the game's observer. USB debugging is sufficient
for the path below on the qualified Android 16 phone; it needed neither root nor
a debuggable WeChat package. Availability remains device-specific. This is a
diagnostic, separate from the ordinary completed-frame performance benchmark.

## Capture through stdin

First inspect `adb shell perfetto --query` and the actual foreground activity/PID.
For machine parsing use `--query-raw`; the human listing explicitly disclaims a
stable format. The qualified phone registered `linux.ftrace`,
`linux.process_stats` and `android.surfaceflinger.frametimeline`. It did not list
`gpu.renderstages` or `gpu.counters`. `android.gpu.memory` measures allocation, not
GPU execution time or utilization.

Save this as `phone-idle-12s.pbtxt` on the machine running ADB:

```text
buffers { size_kb: 32768 fill_policy: RING_BUFFER }
duration_ms: 12000
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      ftrace_events: "sched/sched_switch"
      ftrace_events: "sched/sched_waking"
      ftrace_events: "sched/sched_process_exit"
      ftrace_events: "power/cpu_frequency"
      ftrace_events: "power/cpu_idle"
      atrace_categories: "gfx"
      atrace_categories: "view"
      atrace_categories: "webview"
      atrace_categories: "wm"
      atrace_apps: "com.tencent.mm"
      atrace_apps: "com.tencent.mm:appbrand1"
      compact_sched { enabled: true }
    }
  }
}
data_sources {
  config {
    name: "linux.process_stats"
    process_stats_config { scan_all_processes_on_start: true }
  }
}
data_sources { config { name: "android.surfaceflinger.frametimeline" } }
```

With the authorized serial and ADB executable already selected, capture while the
same complete game stays foreground. Use a unique output filename:

```sh
"$PHONE_ADB" -s "$PHONE_SERIAL" shell dumpsys activity activities > activity-before.txt
"$PHONE_ADB" -s "$PHONE_SERIAL" shell perfetto --txt -c - \
  -o /data/misc/perfetto-traces/forgeax-idle-12s.perfetto-trace \
  < phone-idle-12s.pbtxt > capture-stdout.txt 2> capture-stderr.txt
"$PHONE_ADB" -s "$PHONE_SERIAL" pull \
  /data/misc/perfetto-traces/forgeax-idle-12s.perfetto-trace trace.perfetto-trace
"$PHONE_ADB" -s "$PHONE_SERIAL" shell dumpsys activity activities > activity-after.txt
```

The tested `perfetto -c /data/local/tmp/config.pbtxt` failed with **errno 13** even
though ADB could write that file. Passing `-c -` through stdin succeeded with the
same config. Do not fix this by requesting root or changing file permissions.
The no-PTY warning is not a failed capture: this command has a bounded 12-second
TTL. Keep the stderr result and verify a nonempty pulled trace.

Keep config, trace SHA, publication identity, workload and before/after foreground
binding together. System traces and activity dumps contain other applications'
metadata; retain the raw trace privately. A stationary scene trace is not a
walking/running/jumping measurement. This capture does not drive phone input.

## Inspect actual threads and layer events

Download the official [Trace Processor](https://get.perfetto.dev/trace_processor)
launcher to a file, inspect it, then run it. It selects a platform binary and
checks its release SHA. The tested desktop processor was v58.2; the phone service
was v49. Use the processor locally after pulling the trace; no device operation
is needed for analysis.

Run `trace_processor query -f inspect.sql trace.perfetto-trace`. Start with these
queries, replacing `TARGET_PID` with the foreground game's actual numeric PID:

```sql
SELECT name, idx, severity, value FROM stats
WHERE value > 0 AND (severity <> 'info' OR name GLOB '*lost*' OR name GLOB '*drop*');
SELECT string_value FROM args WHERE flat_key = 'message';
SELECT * FROM trace_bounds;

SELECT t.tid, t.name, s.state, COUNT(*) AS intervals,
       SUM(s.dur) / 1e6 AS milliseconds, MAX(s.dur) / 1e6 AS max_ms
FROM thread_state s JOIN thread t USING (utid) JOIN process p USING (upid)
WHERE p.pid = TARGET_PID AND s.dur > 0
GROUP BY t.utid, s.state ORDER BY milliseconds DESC;

SELECT t.tid, t.name AS thread_name, s.ts, s.dur, s.name AS operation
FROM slice s JOIN thread_track tr ON s.track_id = tr.id
JOIN thread t USING (utid) JOIN process p USING (upid)
WHERE p.pid = TARGET_PID AND
      (s.name = 'eglSwapBuffers' OR s.name = 'waitForever' OR
       s.name GLOB 'waiting for GPU completion *')
ORDER BY s.ts;

SELECT p.pid, a.layer_name, a.present_type, a.jank_type, COUNT(*) AS frames
FROM actual_frame_timeline_slice a LEFT JOIN process p USING (upid)
GROUP BY a.upid, a.layer_name, a.present_type, a.jank_type;
SELECT COUNT(*) AS gpu_slices FROM gpu_slice;
```

Interpretation:

- `Running` is observed CPU execution. `R`/`R+` is runnable scheduling delay;
  sleeping and uninterruptible states require their actual wait/waker evidence.
  Do not infer GPU work from low CPU utilization. CPU time summed across threads
  can exceed wall time. Keep system-wide scheduling context and filter the target
  during analysis so the waking thread and SurfaceFlinger remain visible.
- Confirm `eglSwapBuffers` belongs to the game's current SurfaceView by its
  adjacent `queueBuffer`, `dequeueBuffer` and `onFrameAvailable` events. Swap start
  intervals describe the native buffer-production rhythm, not App completion or
  scanout FPS. Swap duration includes blocking; it is not CPU execution time.
- A `GPU completion` thread's fence-wait duration includes when the CPU began
  observing the fence, queueing and rescheduling. It is **not GPU duration**.
  Nested `waitForever` slices must not be summed again with their parent.
- Perfetto's current [FrameTimeline documentation](https://perfetto.dev/docs/data-sources/frametimeline)
  notes the SurfaceView coverage gap. The qualified phone produced no game PID
  FrameTimeline rows, despite hundreds of its SurfaceView swaps. SystemUI rows
  and SurfaceFlinger display rows are not substitutes for missing game rows.
  An app Actual Timeline ends at `max(GPU completion, buffer post)`; that end is
  not the physical presentation timestamp.
- `VSYNC-app` and hardware-vsync counters can be sparse or enabled only when
  requested. Their gaps do not establish the game's rAF interval. Similarly,
  SurfaceFlinger's `PrevGpuFrameMissed = 0` does not prove the game's GPU is idle.
- `V8 DefaultWorker` is a runtime-internal thread name, **not Engine Worker or
  Render Worker**. Without V8/GC/WASM events or a qualified owner profile, its CPU
  load does not distinguish garbage collection, compilation or other V8 work.

If exact-layer presentation timestamps are needed, first resolve the current layer
with `dumpsys SurfaceFlinger --list`, then query `--latency` for that exact name
through the existing ADB argument-quoting helper. AOSP's
[FrameTracker](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/services/surfaceflinger/FrameTracker.cpp)
outputs desired-present, actual-present and frame-ready timestamps, in that order.
Filter zero/pending `INT64_MAX` values and duplicate records. This is a small
retained ring, not an entire long run; an empty result is unavailable evidence.
Do not clear another session's counters or equate frame-ready latency with GPU
execution time. This optional path still needs qualification on the target phone.

## Qualified observation, 2026-10-13

One 11.972-second system trace of the complete foreground game, stationary,
contained 327 `eglSwapBuffers` calls. Its 326 start intervals averaged 36.373 ms,
p95 70.032 ms, p99 76.293 ms; first-to-last rate was 27.493 swaps/s. The active
`JSRuntimeLooper` ran for 6.594 CPU seconds and waited runnable for 0.554 seconds.
Seven V8 background threads consumed 11.385 CPU seconds in total. Scheduling delay
alone therefore did not explain the full observed gap; the CPU owner profile and
the native completion path were the useful next investigations.

The 327 GPU-completion fence-wait parents averaged 19.713 ms, with p95 34.631 ms.
These were CPU-observed waits, not hardware GPU timings. `gpu_slice` and the game's
FrameTimeline were empty. The trace retained 36 unsupported/failed vendor display
event setup notices from `gfx`; the requested scheduling and swap events were
present. Raw `stats` and setup messages must accompany any coverage claim.

This establishes a useful diagnostic path on that phone, not stable 60 FPS, a
clean-capacity benchmark, a GPU-saturation result or a moving-game acceptance.
See official [CPU scheduling](https://perfetto.dev/docs/data-sources/cpu-scheduling)
and [GPU sources](https://perfetto.dev/docs/data-sources/gpu) for the underlying
event contracts.
