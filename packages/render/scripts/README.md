# Focused rendering performance experiments

These contributor tools diagnose one rendering owner. They do not Cook a game,
change production quality settings, or turn an instrumented sample into an FPS
acceptance result. Qualify CPU and GPU headroom on the executing machine first;
keep the resource monitor aligned with the recorded UTC windows.

## Direct DFG on native WebGPU

```sh
node packages/render/scripts/build-direct-dfg-webgpu.mjs \
  --out /tmp/dfg-webgpu --width 1280 --height 720
```

Serve that directory over localhost HTTP, open `index.html` in the target browser,
and run `await globalThis.runDfg()` after the module has loaded. The button runs
the same function. Save its returned JSON. Playwright must use
`chromiumSandbox: true`; a 75-second outer timeout covers the tool's 60-second
budget. Close only the browser/page/server owned by that experiment afterward.

The builder composes the actual production BRDF with Naga. `private-array` uses
the pinned historical Engine commit `ee236692cf34891f8f76f6f72cd696dd29990465`;
`fit` and `texture` use the checkout's current `brdf.wgsl`. `inputs.json` retains
source, generated shader and 1-KiB RG16F table hashes. Building requires a
contributor Git checkout and existing Naga/Shader outputs; it is not a player
runtime dependency.

Each fragment sums four direct multiscattering evaluations, with roughness,
view cosine and light cosine varying over the same grid. A correctness-only
reference retains the historical compensation function, substitutes native
linear sampling, and uploads the original table bytes extracted independently
from the historical WGSL. The builder requires byte equality with the production
table. Production texture and this native reference must agree within `<2e-6`
on a 128-by-64 RGBA32F readback before timing. Non-finite output always fails.

Native RG16F filtering can round differently from high-precision manual
interpolation. The private-array/texture comparison retains its original `1e-5`
criterion and pass/fail result separately; that former equivalence assumption
does not gate the performance experiment and is never presented as parity.
Fit error is also reported separately: this is an approximation change, not a
pixel-equivalent optimization. Those pixels contain only the accumulated
multiscattering term with F0 `[0.04, 0.3, 0.9]`, not a game's final lighting.

Timing uses RGBA16F at the requested extent, three repeated orders, and four
warm-up plus twelve measured submissions per phase. Every submission completes.
Native pass timestamps and submit-to-completion wall times remain separate;
query resolve/map work is outside the timed passes. Missing timestamp-query
support is explicit. These kernel times do not establish whole-game FPS,
simulator performance, UI cost, or phone performance.

The Mac hardware result and its measurement limits
record actual GPU timestamps, numerical differences, phase order and shared-host
monitor coverage. Preserve the original strict-comparison failure alongside the
native-reference result; the latter does not erase the former.

## Live WebGL segments

Serialize `installLiveWebglProbe` from `probe-live-webgl.mjs` and evaluate it in
the real game with `{ root, canvas, readReceipt }`. `root` provides that realm's
clock and timers; `readReceipt` returns the existing synchronous Renderer
inspection. There are two seconds of receipt-only control, three seconds of GL
observation, then two seconds of restored control. No GL query, draw omission,
new frame, readback or `finish()` is issued.

Read `root.__forgeaxLiveWebglProbe.report()` after completion. Its small summary
normally suffices; fetch only relevant raw pages using
`read('frames' | 'segments' | 'receipts', offset, 64)` and follow `nextOffset`.
The API reduces pages below its compact and CLI-envelope budgets. Do not combine
multiple pages into a larger CLI response. Save evidence before `release()`.

Raw segments end at native fences. Multiple fences can belong to one observed
Renderer frame ID; the tool groups that identity instead of treating fences as
frames. Wall spans can include scheduling, UI or other main-thread work. A long
span with few fast GL calls identifies a gap, not its CPU stack or GPU cost.
Compare control windows and preserve outliers before attributing a slowdown to
instrumentation. Check `methodsRestored`, cleanup conflicts, identity stability,
extent and terminal status. The 20-second deadline and storage limits abort
explicitly. Validate changes with:

```sh
node --test packages/render/scripts/__tests__/probe-live-webgl.test.mjs
```
