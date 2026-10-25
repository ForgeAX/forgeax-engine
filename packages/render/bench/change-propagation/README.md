# Change propagation stress case

> [!IMPORTANT]
> This is a falsifier for the complete CPU change path. Passing a publication-size or cache-hit check does not qualify downstream locality or final performance. Keep a failed scale, native limit, out-of-memory exit, or contended timing visible.

```mermaid
flowchart LR
    A["Mixed World writes and shared asset edits"] --> B["World update and source publication"]
    B --> C["Native Worker message with transferred buffers"]
    C --> D["Actual Renderer receive, prepare and encode"]
    D --> E["Renderer completion receipt"]
    E --> F["Transferred buffer return and publisher recycle"]
```

The World includes rigid meshes, Skin, Morph, four-instance carriers, transparent and unlit materials, a hierarchy, eight local lights, and two shadow cascades. Sparse mutations rotate through logical indexes. Pose, binding and retirement edits affect disjoint groups. A shared material and mesh have independently controlled consumer count K. Every mixed frame changes both resources, moves objects and one parent, changes bindings, and replaces middle members without growing the population. `dense` moves every render entity; it is a control rather than a promised asymptotic win.

| Independent variable | Default pressure sweep | Purpose |
|:--|:--|:--|
| Total entities N | 1,000 / 10,000 / 100,000 / 1,000,000 | Expose global work at fixed changes |
| Authored changes D | 8 per operation group | Pose, binding and churn each receive D; hierarchy also changes its actual descendants |
| Shared consumers K | 128 | Shared-resource propagation must not become a consumer fanout |
| Completed frames | 60, after 16 settled warmup frames | Equal completed work, with explicit pending/failure rejection |
| Isolated phase | idle / camera / pose / binding / material / mesh / hierarchy / churn | Separate causes revealed by the mixed case |
| Transparent rows T (`--transparent T`) | off | Turns the first T rows after the shared consumers into blended Unlit rows, exposing the sorted transparent phase and its CPU-recorded draws |

Run from a normally built checkout. `--settle-ms` (default 60000) bounds startup preparation; raise it on a contended host instead of shrinking the scale. Node must expose `process.threadCpuUsage`; allocation-byte columns additionally need V8's `total_allocated_bytes` (verified on Node 26.4). Missing counters remain unavailable.

```bash
pnpm build:engine
node --test packages/render/bench/change-propagation/__tests__/*.test.mjs
node packages/render/bench/change-propagation/pressure.mjs /tmp/new-pressure-output
node packages/render/bench/change-propagation/run.mjs \
  --out /tmp/new-one-case --backend stub --count 100000 --dirty 8 --users 128 \
  --phase mixed --frames 60 --warmup 16 --objects 1
node packages/render/bench/change-propagation/table.mjs /tmp/new-table.md \
  /tmp/new-pressure-output/1000/report.json \
  /tmp/new-pressure-output/10000/report.json \
  /tmp/new-pressure-output/100000/report.json
```

`pressure.mjs` runs one child at a time with an 8 GiB V8 heap limit per isolate and stops on the first rejected scale. The process record retains exit status, signal and stderr even when a native out-of-memory abort prevents a report. The million-entity case is an attempted pressure point, never silently substituted with a smaller one.

| Metric | Meaning and expected growth |
|:--|:--|
| Source / Render thread CPU | Actual disjoint thread CPU over the selected path. Their sum is CPU work, not latency. Includes GC and the small common measurement/transport harness. |
| End-to-end time | Request through successful completion and recycle acknowledgment, using one in-flight credit. Includes scheduling and GPU wait. It is not App/compositor FPS. |
| Allocated V8 heap bytes/frame | Difference of the runtime's cumulative allocation counter over 60 frames, divided by completed frames. Includes reclaimed objects; excludes external ArrayBuffer payload allocation. Fixed D should not require N-proportional maintenance allocation. Query/record allocations need owner attribution. |
| Live object / array / closure counts | Exact node census of a V8 heap snapshot after timing. Snapshot GC makes this a live-population count, not allocation churn. Native payloads and other heap node types remain separately recorded. |
| Source / Render heap peaks | Sampled per-isolate heap high-water marks. These can miss intra-phase peaks. O(N) retained scene storage is expected. |
| RSS | Process-wide and reported once, because both Workers share one process. The OS maximum includes startup; sampled window maximum and external bytes are also retained. |
| GC | Counts and duration of entries starting inside each realm's timing window; not an exact per-frame tax or a universal proportionality rule. |
| Changed columns / transferred capacity | Logical numeric-column bytes and transferred backing-buffer capacity are distinct. Ownership transfer is not a memcpy of the whole capacity; resources and JS metadata are not counted as numeric columns. |

The default `--backend stub` uses the existing WebGPU stub and its captured Apple M4 Pro profile: ordinary `rhi-webgpu`, capability selection and CPU preparation, without GPU execution/validation, native browser IPC, readback contents or back-pressure. The exact profile and selected device caps/limits are recorded. `--backend null` is a structural correctness target with different caps/branches; never use it as the WebGPU performance proxy.

`--objects 1` performs intrusive heap censuses **after** ordinary timing. No per-frame `inspect`, Profiler or GPU readback runs inside the measured window. The final audit verifies the retained entity population. For `--backend dawn`, it also saves the receipt-bound final display bytes outside timing. Acquire the host's existing physical GPU lease before selecting Dawn. A held lease stays held; stub/Null cannot replace a blocked Dawn acceptance.

Source head, tracked diff digest, every built package module digest, shader manifest digest, fixture digests, deterministic tape digest, configuration, adapter and host samples remain in each report. Use the same upstream and dependency closure for A/B, changing only the selected optimization. First calibrate A/A, then alternate at least three A/B pairs; retain each pair's direction. Compare identical frame tapes and image output before admitting a gain.

The tables report raw values and adjacent growth multipliers. At fixed change complexity, the complete CPU chain must not scale with unrelated scene size N. Queries, drawing preparation and camera changes are not exemptions for full CPU traversal. Include visits before cache returns; retaining cache hits while checking every entity still fails. Actual owner visits are not yet completely measured by this standalone harness, so existing counters cannot qualify whole-chain locality. Retained base scene storage may scale with N and is accounted separately from per-frame allocation.

Every report also keeps the first two startup frames in `startupFrames` (source/render thread CPU, GC, allocated V8 bytes): the first frame is cold start, the same bulk admission as recovery and level load. `--profile-startup cpu|1` records CPU (and sampled allocation) profiles of only that first frame on both threads (`startup-cpu-profile.json`, `source-startup-cpu-profile.json`, and the matching `*-allocation-profile.json`); raise `--settle-ms` for large N.

`--profile 1` adds a separately named intrusive CPU/allocation attribution window and saves Inspector CPU and sampled-allocation profiles for both threads (`cpu-profile.json`/`allocation-profile.json` for the render thread, `source-cpu-profile.json`/`source-allocation-profile.json` for the source Worker). `--profile cpu` records only the two CPU profiles at a 100-microsecond sampling interval. `--objects 1` censuses also name the most numerous constructors and the property shapes of the top object constructors. Never merge that window with ordinary timings. The existing [managed-asset browser carrier](../managed-assets/README.md) remains the App/Browser acceptance route; this Node stress carrier supplies CPU work, allocation and object-population falsifiers, including a million-entity pressure point rather than only a million-vertex asset.

## Frontline workload

`--workload frontline` adds a Game-shaped render-input case beside the generic mixed case. It loads a **normal cooked voxel-game publication** and runs the real Game's `authoredSurfaceMesh`, `loadGunshotAssets` and `createGunshotFx` producers against the tested Engine module identities. It never borrows the Game checkout's unrelated local Engine pin. Renderer caps **and limits** cross to the publisher, as in App's Worker assembly; omitting limits can publish a different material context from the receiver's selected context.

| Owner / event | Actual coverage | Fixed while unrelated N grows |
|:--|:--|:--|
| Terrain | 16 authored Dust2 parts, family materials and the Game's palette/UV projection; repeated background tiles | Same asset roster, tile prefix, camera near/far and four 256px cascades; this is not the entire original map |
| Character | Two cooked role-001 Scenes, including their actual Skin/joint hierarchy | Two root poses change every simulation step |
| Debris | 32 render fragments; 16 move every step, other slots retire/recreate after the 8s age window | Guarded source events are supplied; Game physics/support eligibility is excluded |
| Gunfire | Two AR-shaped schedules: finite 30-round magazines, 0.1s cooldown, 1.65s reload, post-reload cooldown; at most one shot per shooter per update | Controlled admission, not the complete `fireGun`/damage/AI owner |
| Muzzle / hit FX | Real cooked effects, real Game player pooling, finite lifetimes and local flash lights | Real VFX feature publication, completed submission feedback and producer tick retirement |
| Tracer | Real Game two-layer mesh and single `Instances` owner | Finite active range, hide/retire behavior |
| Chunk edit | One editable mesh per admitted shot, 8 editable slots | Default `replace` matches Game's current chunk capacity `off`; `ranges` is an explicitly separate comparison |
| Time | Default 600 steps at 1/60s, after preparation-only warmup | Includes shooting, reload and fragment/effect retirement; no claim of real-time FPS |

Every measured step still changes the camera, actor roots and moving fragments, including reload periods. Increasing N never widens the camera range or moves the existing tile prefix. The generic mixed case retains independently controlled D/K and its broader Skin/Morph/material/binding/churn coverage; `users` (K) is unused in Frontline, and `dirty` names its editable chunk-slot count rather than total changed entities. Its two-shooter event schedule and pose roster define actual change complexity.

```bash
node packages/render/bench/change-propagation/pressure.mjs \
  /tmp/new-frontline-pressure mixed 1000,10000,100000,1000000 \
  --workload frontline --game-root /absolute/voxel-game \
  --game-dist /absolute/frozen-normal-build
```

Validation rejects missing muzzle/tracer/hit events, dropped effects, unacknowledged VFX ticks, missing long-window reload/fragment retirement, lost render entities or cleanup failures. The 600-step schedule also checks that its final reload has allowed all finite effects to retire. Source revisions, imported Game source hashes, cooked catalog/publication hashes and fetched artifact hashes accompany the raw events. This is a controlled CPU render-input workload, excluding the complete Game AI, physics, voxel mesher and App/browser/compositor pacing. It cannot qualify whole-match FPS or GPU output.

> [!CAUTION]
> Historical measurements made before the lazy message-type check are invalid for Engine timing/allocation attribution: a successful receive also evaluated `JSON.stringify(message)` for the assertion's error text. Real Game assets exposed the eager full-packet walk with `Invalid string length`. The corrected collector checks only the message kind; retain old reports as rejected evidence and rerun both sides with the same collector.

## Scenario matrix

One harness, named workloads. `workload.mjs` `scenarios` defines each workload (hooks over the single population builder) and `cells` binds a scenario to a D rule and parameters; `run.mjs --cell ID --count N` runs one cell, `matrix.mjs` runs a subset of cells x sizes (one fresh process and output directory per cell and size) and writes `matrix.json` plus `matrix.md` (CPU p50/p95/max, allocation per frame, GC, heap, live-object census, transfer bytes, startup, stub command counts and upload bytes, `uptime` load, worst cells). `matrix-report.mjs` merges several `matrix.json` files into one table; `matrix-summary.mjs` is the pure projection from reports to rows and Markdown (unit-tested in `__tests__/scenarios.test.mjs`). A noisy cell (total CPU p95 above 2.5x p50) is rerun once and flagged.

| Cell | Workload |
|:--|:--|
| `static`, `move-d8`, `move-1pct`, `move-10pct`, `move-100pct` | D Transform writes per frame |
| `churn-d8`, `churn-1pct` | despawn D rows and spawn D fresh rows |
| `material-swap`, `mesh-swap`, `visibility-toggle` | D rows rebind a pooled material/mesh, or toggle Visibility |
| `cameras-1/2/4`, `split-screen`, `rt-camera` | CameraView quadrants, side-by-side halves, auxiliary RenderTarget camera |
| `shadow-lights-8/32`, `shadow-lights-32-moving` | directional (4 cascades) plus shadowed point/spot lights, optionally moving |
| `skinned`, `morph`, `transparent`, `alpha-mask`, `lod`, `instancing` | content kinds (`instancing`: N is the instance count) |
| `materials-many`, `materials-few` | N unique materials versus four shared |
| `hot-texture`, `hot-material`, `hot-mesh` | shared asset revision every frame |
| `recovery` | one injected device loss and `Renderer.recover()` at frame 30 (stub backend; recovery frames leave `raw`, cost in `report.recovery`) |
| `frontline` | the game workload, through `matrix.mjs --frontline-game-root P --frontline-game-dist P` |

```bash
node packages/render/bench/change-propagation/matrix.mjs --out /tmp/new-matrix \
  --cells static,move-d8,churn-d8 --sizes 10,100,1000,10000,100000 --frames 60
```

Worker versus local execution is not a mode: the harness always crosses a real Worker transfer, so no local-transport comparison exists.
