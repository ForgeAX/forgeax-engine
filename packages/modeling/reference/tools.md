# Tools: inspection, diagnostics and overlays

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Inspection, diagnostics and overlays

| Surface | Purpose |
|:--|:--|
| `m.checkpoint(name)` | Names an intermediate state. A no-op in ordinary builds; inside a capture it keeps an FXEM snapshot (first 8) |
| `captureModels(body, options?)` | Runs a build and returns every `model()` session it created; single-flight; `{ steps: true }` keeps a snapshot after every operation |
| `m.diagnostics()` | Inspection, validation, final FXEM snapshot, checkpoints, step snapshots, design drawings, contours and export provenance (render vertex -> corner, triangle -> face) |
| `projectOverlay(mesh, kind, bounds?)` | `tags`, `roles`, `elementIds` (vertex-colored triangles with a legend) or `sharp`, `seams`, `normals`, `edges` (line lists; `edges` keeps edges with an end inside `bounds`) |

`@forgeax/engine-modeling/tools` (Node only) contributes the ToolRuntime
operations `model.inspect`, `model.select`, `model.validate`, `model.overlay`,
`model.history`, `model.diff`, `model.pose`, `model.interference`, `model.synthesize` and `model.bake`, which DevKit exposes as `forgeax model <operation>`; DevKit adds
`model.render`, which draws a captured state with the Engine Renderer (orthographic drawing
sheets, section, X-ray and exploded views; `--mode zebra`, `curvature-gaussian` or
`curvature-mean` and `--combs` for the surface-quality views), and `model.replay`, which renders the build step by step. Each call re-runs
the Pack build in a dedicated Worker through an in-process Pack executor, captures its
sessions and returns bounded JSON. Each rebuild of a call has a 60 s budget
(`model-work-budget` beyond it); `--timeout-ms` (1000 to 600000, `CAPTURE_TIMEOUT_ARG`)
raises it for large assemblies on a busy host. The Worker heap defaults to a quarter of
system memory (1024 to 8192 MiB, `defaultCaptureHeapMb()`); `--heap-mb` (256 to 16384,
`CAPTURE_HEAP_ARG`) sets it per call, and running out is `model-work-budget` with
`detail.heapMb`. Captured sessions record the author call site of
every operation and checkpoint (the first stack frame outside the kernel; exact line and
column under Node type stripping); tools report it project-relative.

| Operation | Returns |
|:--|:--|
| `model.inspect` | outputs; per session the `output` (`mesh/<key>` its `finish()` produced, or `scene/<key>` of a rig finished from it), counts, tags, labeled roles, checkpoints (name, operation index, size, source) and the operation count |
| `model.history` | per session every operation in call order: `args` (selectors as expressions), status, roles, resulting size, duration, source, diagnostics; checkpoints |
| `model.select --selector` | the same `sel.*` expression written in code, evaluated on the session or a `--checkpoint`: domain, count, ids, bounds; `--highlight true` adds the selected faces as overlay geometry (`selected.highlight`) |
| `model.validate` | the `forgeax.model.validate/2` report (`MODEL_VALIDATE_REPORT_SCHEMA`): `pass`/`warn`/`fail` overall and per session (`fail`: build failure, poisoned session or error issue; `warn`: a confirmed warning or an operation diagnostic). Each issue carries `certainty` (`confirmed`/`candidate`) and a `location`: face and vertex ids of the session state (the ids `elementIds` overlays draw), the first face's centroid, its creating `label`/`role` and the source of the last operation with that label. Poisoned sessions carry the failing call's source. `--min-thickness <m>` and `--unique-uv true` enable the opt-in `validate()` checks (`thin-wall`, `uv-overlap`); `--edge-flow true` adds `edge-flow` issues and `--surface-quality true` (or a thresholds object) adds `surface-quality` issues located at the worst point and the source of the `surface`/`featureLine` call |
| `model.overlay --overlay` | geometry for `engine.preview.display.set({ overlays })` on a live mesh preview |
| `model.pose --u` / `--pose` | the build's rigs (session, `scene/<key>` output, joints, parts, exported path keys) and one pose: `--u` samples the path the rig's `finish()` exported, `--pose` gives joint values (degrees, meters, `{x,y,z}`); applied values, clamped limits (`--limits reject` fails instead), every joint frame and the interference report at the pose |
| `model.interference` | the path scan of the exported path (`--step`, `--max-travel`, `--refine`, `--tolerance`, `--clearance` for the DMU class `clearance` and each pair's `minDistance`): fixed samples, travel subdivision, per pair first contact, first confirmation and deepest penetration; with `--u` or `--pose` the interference report of that pose. Designed contacts come from the rig |
| `model.diff --against` | the `forgeax.model.diff/1` report of two states: side A from `source`/`values`/`session`/`checkpoint`, side B the same with the `--against` overrides (two parameter sets, two checkpoints, or another `.pack.ts` revision). `diff` (`diffMeshes`) holds count, closedness, volume, area and bounds deltas, faces unchanged/moved/added/removed per provenance (label, role, tags, material), tag and material counts, a vertex-to-surface Hausdorff distance and bounded `{reason, detail, elementA, elementB}` differences on canonical (compacted) face ids; `render` holds the shared `frame` and both `model.render` argument sets of the V-diff pair |
| `model.synthesize --pick` | the `forgeax.model.synthesize/1` report (design 12): human picks on a session state (`faces`: ids as `model.select` reports them; `rays`: the first face each hits; `boxes`: a view rectangle, visible faces unless `visible: false`) become the shortest `sel.*` expression with Jaccard J = 1. Atoms are the picks' tags, `createdBy` labels and roles, materials, `mirrored`, `extreme`/`facing` on the six axes and sharp-bounded smooth regions (`seed.connected('smooth')`, seeded by the cheapest atom inside the region); a beam search combines at most `--max-atoms` (4) with `and`/`or`/`minus`, preferring fewer atoms, then tags over roles over materials over regions over directions. Without an exact combination the result is the positional `near(p, k)` fallback (`fallback: true`, always `unstable`). The stability check rebuilds the Pack at each ranged parameter's minimum and maximum (`--parameters` limits the set) and scores the selector against the picks carried into each build (`transferSelection`: whole provenance groups map to whole groups, congruent face classes such as rotated copies to the closest class, other faces one to one by normalized position); `stability` is `stable` when every rebuild verifies J = 1, `unstable` when a verified rebuild misses (or the result is inexact or the fallback), `unchecked` without ranged parameters, with `--stability false`, or when a rebuild could not be verified (capture error or timeout, kept in its check's `error`) and no verified one missed. Also `alternatives`, per-rebuild `checks`, `parameters` and `highlight` overlay geometry. The View modeling window calls it for clicks and box selects |

Only `model.validate` validates: the exact self-intersection check dominates large
assemblies, so other operations never run it, and `diagnostics().validation` and
`.snapshot` are computed on first read. Every report carries `timing` (milliseconds for
`load`, `build`, `summarize`, `validate`, `target` and `total`); on a 5-stage hard-surface chassis
`model.inspect` went from 40.9 s to 4.9 s (`reports/capture-timing-s5.json`).
`--timing-runs` (`CaptureRequest.timingRuns`, `{ local?: { <parameter>: <value> } }`) adds `cold` (= `buildMs`), `hot` (an identical rebuild in the warm Worker), and with `local` a rebuild with that parameter edit and `final` (original values again), plus `env: { distDigest, kernelSha }`: the digest of the built package's runtime files and `TS_KERNEL_DIGEST`, so a timing names the build that produced it.

Without `--session`, select, overlay and render use the only session, else (when the build succeeded) the
single session that produced an output, and report the index they used; when several sessions
finish, they fail with `tool-invalid-args` and list the sessions. `captureRequest` and
`relativeSources` let composers such as DevKit reuse the argument checks and source
projection; a request with `render: true` returns the target state exported for viewing
(the selection in the `highlight` slot, a box UV stand-in when `uv0` is incomplete) with the
session's design drawings and contours. `step` (select, overlay, render) reads the state right
after one operation; `xray` moves a selection to the `xray` slot; `section` cuts the copy and
returns cap, hatch and outline geometry; `explode` moves its parts apart; `replay` (operation
indices, or `all`: every successful operation that leaves faces, sampled to 64) returns one
render payload per step with the operation, label and source line. `POSE_ARGS` (`--rig`,
`--u`, `--pose`, `--limits`) pose a rig instead: the posed state replaces the rig's
session state for select, overlay and render, and the parts in confirmed or candidate
contact go to the `highlight` slot.

```bash
forgeax model inspect --source assets/helmet.pack.ts --json
forgeax model select --source assets/helmet.pack.ts --selector "sel.createdBy('visor', 'rim')" --json
forgeax model overlay --source assets/helmet.pack.ts --overlay sharp --json
forgeax model history --source assets/helmet.pack.ts --json
forgeax model diff --source assets/helmet.pack.ts --against '{"values":{"depth":0.06}}' --json
forgeax model synthesize --source assets/helmet.pack.ts --pick '{"faces":[12,13,14]}' --json
forgeax model render --source assets/helmet.pack.ts --views '["front","iso"]' --overlays '["sharp"]' --json
forgeax model render --source assets/body.pack.ts --mode zebra --zebra '{"width":3,"orientation":90}' --views '["iso",{"name":"rear","yaw":160,"pitch":20}]' --json
forgeax model render --source assets/body.pack.ts --mode curvature-mean --curvature '{"range":2}' --combs true --json
forgeax model validate --source assets/body.pack.ts --surface-quality '{"continuity":"G2"}' --json
forgeax model render --source assets/helmet.pack.ts --section '{"point":[0,0,0],"normal":[1,0,0]}' --views '["right"]' --json
forgeax model replay --source assets/helmet.pack.ts --view iso --json
forgeax model pose --source assets/limb.pack.ts --u 0.6 --json
forgeax model interference --source assets/limb.pack.ts --json
forgeax model render --source assets/limb.pack.ts --u 0.6 --views '["iso"]' --json
```

## `forgeax model *` commands

Every command takes `--source <pack> --json` and re-runs the build in a capture Worker, so results always match the current source.

| Command (`--source <pack> --json`) | Answers |
|:--|:--|
| `forgeax model inspect` | outputs, sessions (`output` marks the one `finish()` produced, or the source session of a finished rig), tags, labeled roles, checkpoints with sizes and source lines, operation count |
| `forgeax model history` | every operation in call order: args, status, roles, resulting size, duration, **source line**, diagnostics; checkpoints |
| `forgeax model select --selector "sel.tag('shell').and(sel.facing('+y'))" [--checkpoint c]` | domain, count, ids, bounds. Try a selector here before writing it into code |
| `forgeax model validate [--min-thickness 0.004] [--unique-uv true]` | `forgeax.model.validate/2`: `pass/warn/fail` per session; each issue has `certainty` (`confirmed`/`candidate`), face ids, a centroid, the creating `label/role` and that operation's source line; operation diagnostics (clamps, soft effect assertions). The two options enable the asset-dependent `thin-wall` and `uv-overlap` checks; `--surface-quality true` (or thresholds `{"continuity":"G2","maxNet":[8,6]}`) adds `surface-quality` warnings (`detail.check`: `surface-continuity` G0 0.1 mm / G1 0.5 deg / G2 per scene, `surface-density` net above 8 x 6, `surface-fairness` ripples on 5 interior isoparms per direction of every patch, `curve-inflection`, `curve-spike`, `curve-curvature-rate`, `nothing-checked` when no patch or line was recorded; `curvatureFloor` tightens the per-scene G2 floor, default 0.01 1/m) located at the worst point and the `surface`/`featureLine` call; `--edge-flow true` adds `edge-flow` issues (`feature-loop`: a feature line not on one continuous edge loop, with gap points; `aspect` > 4; `size-ratio` > 2; `triangles`/`poles` infos with locations; `support`-tagged strips exempt) |
| `forgeax model render [--views '["front","right","top","iso",{"name":"sheet-front","yaw":0,"pitch":7.4}]'] [--mode wireframe] [--overlays '["tags","sharp"]'] [--selector ...] [--checkpoint c \| --step n] [--values '{...}'] [--frame '[minX,minY,minZ,maxX,maxY,maxZ]']` | real Engine Renderer images of a session state: one PNG per view, a contact sheet, per-view `coverage`, mesh facts, overlay legends. Free cameras `{ name?, yaw, pitch }` (degrees; yaw 90 = right, pitch 90 = top) or `{ name?, direction }` match a reference sheet's own camera (for example a few degrees of pitch). **Orthographic by default**, every view on one `pixelsPerMeter` (`--scale` pins it, `--projection perspective` opts out; pass the same `--frame` and `--scale` to compare checkpoints, steps or parameter sets from one camera), with a drawing sheet (`--annotate false` turns it off): grid, scale bar, extent dimensions (iso: true 3D box sizes and span lengths only), design drawing curves (orange) and dimensions, extruded contours (cyan dashed), `--measure` spans; labels never overlap (moved ones keep a leader). Engineering views: `--section '{"point":[..],"normal":[..]}'` (cut, even-odd cap, hatch; look from the normal side), `--xray "sel.tag('body')"` (see-through shell), `--explode '{"by":"tag","distance":0.5,"directions":{"lid":[0,1,0]}}'` |
| `forgeax model render --mode zebra [--zebra '{"width":3,"orientation":90}']`, `--mode curvature-gaussian\|curvature-mean [--curvature '{"range":2}']`, `--combs true` | surface-quality views: zebra = reflected parallel light stripes (view dependent, any camera), curvature = diverging blue/white/red, combs = curvature combs of `m.featureLine` lines. Computed from the exact NURBS patches (`analysis.exactVertices`) where vertices lie on them, else a mesh quadric fit. A fair body shows continuous, unwobbling stripes and no blotchy sign flips inside a panel; pass one `--curvature` range to compare renders. V-wire: `--overlays '["edges"]'` draws the n-gon edge flow over the shaded body; add `--frame [minX,minY,minZ,maxX,maxY,maxZ]` for a close-up (only edges inside it) |
| `forgeax model replay [--steps '[1,4,9]'] [--view iso]` | the build step by step: the state right after each operation (default every operation that leaves faces, at most 64) from one camera framing all states; numbered frame PNGs, a labeled strip, and each frame's op, label and source line |
| `forgeax model overlay --overlay tags\|roles\|elementIds\|sharp\|seams\|normals` | overlay geometry for a live mesh preview: put the returned `overlay` under a key, `engine.preview.display.set --overlays '{"tags": <overlay>}'` with the preview's target identity |
| `forgeax model diff --against '{"values":{...}}'` (or a checkpoint, session or other `.pack.ts`) | `forgeax.model.diff/1`: count/volume/area/bounds deltas, Hausdorff distance, faces unchanged/moved/added/removed per label and role, plus two `model render` argument sets sharing one `--frame` (V-diff) |
| `forgeax model pose --u 0.6` (or `--pose '{"elbow":-90}'`, `--limits reject`) | the build's rigs (joints, parts, exported path keys) and one pose: applied joint values, clamped limits, joint frames, part-vs-part interference. `forgeax model render --u 0.6` draws that pose with parts in contact highlighted |
| `forgeax model interference [--step 0.05] [--max-travel 0.005] [--tolerance 1e-4] [--clearance 0.005]` (or `--u`) | the scan of the path the rig's `finish()` exported: per pair first contact, first confirmation and deepest penetration (`confirmed` / `candidate` / `designed`, plus `clearance` with `--clearance`: closer than the threshold without touching, each pair's `minDistance`); flush faces a rounding apart are `candidate`; declared fit bands come back in `fits`; `pass` means no confirmed contact anywhere on the path |
| `forgeax model bake --base 1 --detail 2 --resolution 512 [--maps '["normal","ao"]'] [--cage '{"offset":0.01,"maxRay":0.02}'] [--out bake/]` | `forgeax.model.bake/1`: bakes the detail session onto the base session (indices from `model inspect`), with ray hits, coverage, per-map statistics and the bake checks ([uv-bake](uv-bake.md)); `--out` writes `<map>.png`. Each finding names its fix (for `cage-clip`, a cage `offset` above the tallest feature and `maxRay` past the deepest); `cage-clip` and `stray-detail` also list `clusters` (one per clipped feature or hovering part: sample count, worst distance, bounds, face ids, a per-cluster `hint`) |
| `forgeax model synthesize --pick '{"faces":[..]}'` (or `rays` / `boxes`; the View modeling window sends human clicks and box selects) | `forgeax.model.synthesize/1`: the shortest `sel.*` expression with Jaccard J = 1 over the picks (at most 4 tag/role/material/direction/smooth-region atoms with and/or/minus), `alternatives`, and `stability`: `stable` only when every rebuild at the ranged parameters' minimum and maximum verified J = 1; `unstable` when a verified rebuild missed (named in `checks`); `unchecked` without ranged parameters or when a rebuild could not be verified (capture error or timeout, its `error` kept in `checks`) and none missed. A `fallback` `near(p, k)` result is positional and always `unstable`: ask for or add a tag/label instead of pasting it. `model select --highlight true` returns the same overlay geometry for a typed selector |

- Every `model.*` report carries `timing` (load, build, summarize, validate, target, total ms). Only `model validate` runs the exact self-intersection check, which dominates large assemblies; use the other operations for quick looks.
- `model.*` re-runs the build in a capture Worker on every call, so results always match the
  current source. Add `m.checkpoint('<name>')` (no-op outside a capture, max 8) after steps you
  want to render or select on.
- `model render` uses Dawn in Node (Linux prebuild; macOS/Windows need
  `pnpm --filter @forgeax/engine-dawn-node build:native`). A missing device is
  `model-render-backend-unavailable`; device or validation errors fail as `model-render-gpu-error`.
  On a Linux host without a GPU, `model-render-backend-unavailable` usually means the Vulkan
  loader (`libvulkan.so.1`) or a software driver is missing: install the loader and Mesa
  lavapipe (`libvulkan1`, `mesa-vulkan-drivers`), or point `VK_ICD_FILENAMES` at a lavapipe ICD
  JSON and `LD_LIBRARY_PATH` at its libraries.
  In an Engine checkout, export `FORGEAX_SHARED_APP_INPUTS_MANIFEST=shared-build-inputs/manifest.json`
  after `pnpm build:engine` to skip the 40 s shader manifest build.
- `model render` shows shape by default (`--materials palette`): each material slot gets a flat
  palette color in first-use order. `--materials auto` binds the Pack's `material/<slot>` outputs
  (same-Pack textures included) to the slots of the same name and keeps the palette for the rest;
  `materialBinding` lists `{ slot, source: pack|palette|reserved }`, and a cross-Pack or unresolvable
  material GUID fails as `model-render-material-load-failed` (see [materials](materials.md)). Check
  bakes and the full scene in the Engine (`forgeax project preview`), or read the maps that
  `model bake --out` writes.
- With several finished sessions (a bake's base and detail, a rig plus a separate mesh), pass
  `--session <index>` to select, render and pose. Copy the contact sheet with `--output <path>`;
  every run also keeps its files under `.forgeax/tool-runs/` in the project root.
- Inside an Engine checkout `forgeax` is not on PATH; run
  `node packages/engine/dist/bin/forgeax.mjs model ...` from the Engine root after
  `pnpm build:engine`. A game project installs the `forgeax` bin with `@forgeax/engine`.
- Highlighted selections render in the magenta `highlight` slot (edge selections show their
  adjacent faces). A state without complete `uv0` renders with a stand-in box projection
  (`uvProjected: true`).

## Budgets and isolation

| Pitfall | Rule |
|:--|:--|
| Live generation isolation (parameters with `apply`) | Only pure imports pass: `@forgeax/engine/modeling`, `geometry`, `math`, `types`, `pack/source` and listed named factories |
| Dynamic `obj[key]` under isolation | A non-numeric computed key throws at run time; use static field names or arrays |
| Ambient state | No `Date`, `Math.random`, `process`, `fetch`; derive randomness from a seed in the build |
| Build time | A Pack build has a **15 s** timeout; keep segment counts and repeated operations bounded. Move voxel / remesh / simplify work that nears it into a `MeshJob` (`{ name, build(params) -> Model, export }`) and return `meshJobSources(job, { key, params })`: a `modeling-mesh-job` cook source the `createMeshJobCooker([job])` NativeCooker (register it in the build plugin) runs outside the timeout and declares a 10 min cook bound (`createMeshJobCooker(jobs, { timeoutMs })`) that DevKit build roots use instead of their 60 s per-operation deadline; `model.*` captures still run it in place |
| Runtime adjustment | A part regenerated when parameters change at run time should rebuild (parameters to `finish`) within **100 ms p90** in a Worker; keep it to tens of operations on small meshes. Gear/hinge-sized recipes fit (about 30-60 ms); booleans, subdivide and bevel are the costly steps. Tier budgets and measured cases: `packages/modeling/reports/perf-tiers.md` |
| Tool time | Each `model.*` rebuild has a **60 s** budget (`model-work-budget`); for a large assembly on a busy host pass `--timeout-ms` (up to 600000); a Worker heap exhaustion (`model-work-budget`, `detail.heapMb`) takes `--heap-mb` (default a quarter of RAM, 1024-8192; up to 16384). `model render`/`replay` accept both |

