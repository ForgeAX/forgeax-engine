# Modeling Show

A reusable Show of modeling Pack sets. It covers studio light, a floor and turntable, camera
rails, the transformation performance, explode, section and X-ray views of the inside, and
a timeline that rebuilds the model to any history step. Case C-111 shows the C-107
transforming limb and the C-106 body panels. It is also the target of F1 `mech-gt` S8,
where the whole machine is one subject made of several Packs.

## Program

A program is plain data plus build functions. C-111 is defined in `assets/show/c111.ts`,
and `assets/show/programs.ts` registers programs by name. `assets/show.pack.ts` selects one
program and lists its Pack outputs, so the project build publishes them.

| Field | Meaning |
|:--|:--|
| `subjects[].packs[]` | Pack outputs by `packageId` and source key. `scenes` (for example a `rig.finish()` scene with its clip), `meshes`, and `materials` by slot. Every listed output joins one subject in one build space. |
| `subjects[].xray` | Part names (entity `Name`) that become see-through shells in `xray` segments. |
| `subjects[].controls` | Debug panel controls (see Debug panel); default `COMMON_CONTROLS`. |
| `subjects[].history` | Build stages `{ label, build, session? }`. Each stage is re-run with the kernel step capture, and the stages join into one timeline. A whole machine lists every build stage. |
| `segments[]` | `{ subject, kind, seconds }`. `kind` is one of `turntable`, `transform`, `explode`, `section`, `xray` or `history`. |

A segment may carry `form`, the transformation parameter held through a beat of another
kind (for example a turntable of the robot form at `form: 0.5` of a round-trip clip).
`assets/show/pack.ts` (`showPack`) builds the project roots of one program; each Show
project's `show.pack.ts` calls it.

`createShow` takes an optional `pose(kind, u)` that replaces the default choreography (`stagePose`), for example to hold the camera.

Every `AnimationPlayer` in a subject's scenes follows the same transformation parameter
u, each over its own clip duration. The camera frames the subject's bounds over the whole
path.

## F1 mech-gt showcase

`mech-gt/` is a second Show project with the `mech-gt` program (`assets/show/mech-gt.ts`): the
finished car (S6 exterior, S6c details and cockpit) on the turntable, the S7 assembly
transforming car -> robot -> car, the robot form on the turntable, explode and section. Its
sibling Packs re-export the forgeax-modeling `examples/mech-gt` stage Packs, and the S7 parts
wear the finished Packs' materials. The S7 rig and the S6 part groups are `modeling-mesh-job`
cook sources: the build root registers one cooker (`S7_JOB`, `S6_JOBS`) that builds each job
once for all its outputs, within its declared cook deadline. `__tests__/mech-gt.unit.test.ts` rebuilds the Packs and fails when the
program names an output they no longer publish.

```sh
apps/modeling-show/mech-gt/scripts/rebuild.sh <out.mp4>                  # build, record every segment, 720p MP4
apps/modeling-show/mech-gt/scripts/rebuild.sh <out.mp4> 0:32,1:0,2:0,3:0,4:0   # car turntable only
```

The showcase video is the film in `assets/show/cinematic.ts` (one continuous take: car
turntable, transformation once, robot turntable; the camera frames the current form), rendered
offline without UI on Dawn by `__tests__/mech-gt.record.dawn.test.ts`, which validates every frame
(blank, stale duplicate, exposure):

```sh
apps/modeling-show/mech-gt/scripts/film.sh <out.mp4> [processes] [WxH]   # lavapipe ICD in the environment
```

`scripts/outputs.mts` cooks each sibling Pack's outputs in-process and caches them in `.cache/`
(keyed by the modeling source and the Pack file), so a change re-cooks only the Packs it touches.

`scripts/record.mjs` seeks every segment with the timeline slider and captures each frame
(resumable); `package.json#forgeax.frameTimeoutMs` allows the slow frames of a software renderer.

The interactive pages on the Modeling Studio board share (`show/<subject>/` beside the board, picker
`show/index.html`) are Show projects built for the web: `mech-gt` (subject `f1-rig`), `mech-gt-car`
(`f1-car`, the finished car alone), `maid-whale-g7` (`f2-g7`, the G7 face figure with its cooked `material/<slot>` materials) and `maid-whale` (`f2`, `f2-wip`; slots colored by the subject
`palette`), `hood-linkage` (case `c-116`) and `scifi-mech` (case `c-410`, the bake case: low mesh with baked maps, detail preview, plain look). `scripts/show-rebuild.mjs` rebuilds the subjects whose input changed (see Rebuild runner below), checks each with
`scripts/page-journey.mjs` (sandboxed Chromium, share headers from `scripts/share-server.mjs`, gzip, 20 Mbps / 50 ms RTT)
and publishes it with the picker (`scripts/show-picker.html`); subjects and the schedule are in Modeling Studio
`ops/show-subjects.json` and `ops/show-rebuild.md`. The share serves them from an opaque origin (`CSP: sandbox allow-scripts`), so App `auto` runs every realm on the page's main thread.

`gallery/` is the Show project of single-Pack cases (program `gallery`, `assets/show/gallery.ts`).
A gallery subject names only its Packs; `discoverOutputs` fills in every mesh (LOD levels excluded)
and every `material/<slot>` material each Pack publishes, from the realm's Catalog. Slots without
a material take the Show palette. To add a case, re-export its Pack as
`gallery/assets/<case>.pack.ts` and append `{ name, source, packs: [{ packageId }] }` to
`GALLERY_SUBJECTS`.

## Rebuild runner

`scripts/show-rebuild.mjs` runs from cron every 5 minutes (`scripts/show-rebuild-cron.sh`). Pure decisions and
state/lock helpers are in `scripts/show-rebuild-lib.mjs` (tests: `__tests__/show-rebuild.unit.test.ts`); the full
journey of a published page is `scripts/show-journey.mjs`. `node scripts/show-rebuild.mjs --dry-run` prints, per
subject and lane, whether it would build and why, and writes nothing.

**Subjects** (`ops/show-subjects.json`, re-read before every build, so a subject added mid-cycle is picked up):

| Field | Meaning |
|:--|:--|
| `id`, `title`, `project`, `modelingBranch`, `note` | Subject identity, Show project under `apps/modeling-show/`, forgeax-modeling branch |
| `journey` | `full` or `basic` journey script |
| `fastLane` | F1 subject: builds first and takes the normal forgeax-heavy lane for package and smoke |
| `wip` | The branch is a PR or feature branch. If it is not on origin (not pushed yet, or deleted) the previous build stays live and the picker shows `modeling branch '<b>' is not on origin ...; keeping the live build ...`; the failure clears once the branch exists again |
| `small` | The subject builds in the small lane (below) |

**Why a subject builds** (`reason` in the log and the dry run): `modeling head change`; `engine age`; `forced`
(`--force`/`--only`); `first build`. A key (Engine commit @ modeling head : project) is attempted once; the next
head change retries.

**Engine refresh.** Every publish records the Engine commit it was built with (`lastGood.engine`). That commit's own
date (not the last build time) is its age. A live page whose Engine commit differs from the `integration/modeling`
head by more than build-side packages (`devkit`, `import`, `pack`, ... see `BUILD_SIDE`) rebuilds once that commit is
older than `ENGINE_REFRESH_HOURS` (6). A build-side-only difference does not force a rebuild, but any build of an
old subject then uses the head Engine, so cook speedups reach the runner with the next modeling change.

**Publish and journey.** A build is gated by the quick smoke, swapped in and published at once. The full throttled
journey then runs in a separate detached process (`forgeax-heavy --low`, log
`~/.local/share/forgeax-show-rebuild/journeys/<id>-<modeling7>.log`): the build loop does not wait for it and the
cycle locks are not held by it. It writes its verdict into `state.json` (`lastGood.journey`, `fullJourneyAt`); on
failure it rolls the share back to the previous build (or removes a first build) and records the reason. One journey
runs per subject: a newer publish of the same subject cancels the running one and takes over its rollback target (the
last verified build), and a verdict whose build `builtAt` is no longer the live one is dropped. A geometry-only rebuild
on an unchanged Engine within `FULL_JOURNEY_HOURS` (3) of a passed journey runs only the smoke.
An identical page on the same Engine also reuses its full journey outside that window. `pageDigest`
identifies the live page; `fullJourneyPageDigest` identifies the page that actually passed. A quick
build preserves that verified digest, so changed geometry cannot inherit indefinite coverage.
Records without a verified digest need a full journey once the three-hour window expires.

> [!NOTE]
> Full journeys share `journey-run.lock` across subjects and lanes. A second process waits up to
> 30 minutes; a dead owner's lock is reclaimed. A timeout leaves the build pending and logs the reason.

**Lanes and locks.** Subjects with `"small": true` build in the small lane, all others in the big lane. Each lane has
its own pid lock (`cycle.lock` for big, `cycle-small.lock` for small) and its own Engine worktree (big: the runner
worktree; small: its sibling `<runner>-small`, created and prepared on first use, `FORGEAX_SHOW_SMALL_REPO`
overrides), because a build checks out its modeling head inside the Engine checkout. At most one big build runs beside
at most one small build, each under `forgeax-heavy --low`; a lane stops while MemAvailable < 16 GB. A cycle that wins
the big lock runs the big lane and starts the small lane as a child process; a cycle that finds the big lock held
runs the small lane if its lock is free; a second big build never starts. State writes go through `state.json.lock`
read-modify-write, so lanes and journeys do not overwrite each other.

## Engine owners

Each beat of the Show goes through an existing Engine owner:

| Beat | Owner |
|:--|:--|
| Turntable and explode | Scene `Transform` |
| Transformation | `AnimationPlayer` held paused at `u x duration` |
| Section | Camera `ClippingPlanes`. The section plane and an above-floor plane clip their intersection, so the floor stays. `caps` shades the cut faces of closed opaque parts as a solid section. |
| X-ray | `MeshRenderer` materials. An alpha-blended Standard material without depth writes replaces the shell materials. |
| Camera rails | Path `preparePath` samples |
| Light | A procedural HDR environment on a Skylight, plus a shadowed key light |
| Mirror | Camera `PlanarReflection` on the disc top plus the Pack-cooked `material/disc` (`planarReflection: true`); the target comes from the realm's render target authoring (`executionBootstrapHost.renderTargets`). |
| History | Kernel FXEM step snapshots exported to runtime meshes. Faces that a step created use the `highlight` slot. |

The timeline (`assets/ui/timeline.ui.html`) is a UiAsset mounted in the presentation
realm. It talks to the Show over the App port (`assets/show/protocol.ts`). Every Show project
mounts the same html and css; `__tests__/panel.unit.test.ts` fails when a project copy drifts
(a project's asset roots cannot reach the shared directory). Its controls:

- The segment chips jump to a segment.
- The slider scrubs the position u within the current segment.
- Space plays or pauses.
- The arrow keys move one history step, or 5 % of the segment in other beats.
- Dragging on the canvas orbits the camera, Shift or right drag pans, the wheel zooms (the Show
  reads the frozen `InputSnapshot`; pointer lock stays off).

### Debug panel

The **Debug panel** button (top right, collapsed by default) opens the controls of the subject
on stage. A subject declares them as data in `ShowSubjectSource.controls`
(`assets/show/controls.ts`); without a declaration it gets `COMMON_CONTROLS`. The panel shows a
declared control only where it applies (`applicableControls`): parts (and explode) need more
than one part, finish needs `clean` looks, mechanism needs a transformation clip.

| Control | Row | Show command |
|:--|:--|:--|
| `camera` | Auto, Front, Side, Rear 3/4 and Top aim from the subject's frame; Auto returns to the choreography | `view` |
| `floor` | Floor on/off hides the floor and turntable discs and drops the mirror capture | `floor` |
| `finish` | Paint clean / weathered: `clean` slots take the program looks the Show Pack cooks (`material/look-<name>`); clean is the default | `finish` |
| `shading` | Lit, Curvature, Zebra, Facet edges (below) | `analysis` |
| `parts` | One checkbox per part (entity `Name`; plain meshes take their Pack key), Show all | `hide` |
| `bake` | Bake case (`bake { high, low, plain, channels }`: high mesh key, low mesh key prefix, plain material key): Low mesh / High mesh and Baked maps / Plain switch the parts by name and their materials; the shading views skip the level off stage. The map-channel viewer is not built (`channels` is unused) | `bake` |
| `explode`, `section`, `mechanism`, `lod`, `uv-checker` | Schema only: `lod { levels }`, `uv-checker { scale }`. Declaring one fails with `control-not-ready` until its slot exists | |

`parseControls` rejects unknown kinds (`control-unknown`), pending kinds, malformed parameters and
repeats; `resolveSubjects` applies it to every subject. A new control kind is one union member in
`controls.ts`, its `SHOW_CONTROL_KINDS` entry and, once implemented, one slot in `panel.ts`.

Surface views (`assets/show/analysis.ts`): Curvature (mean curvature) and Zebra (stripes of one
fixed light, baked in each part's frame) replace each part's surface with a vertex-color mesh
from the forgeax-modeling surface analysis; Facet edges overlays crease and facet lines. Views
are computed on first use within a per-frame budget (the panel shows `computing n/m parts`) and
cached; Lit restores the parts' own meshes and materials. The subject `legend` line sits under
the caption.

## Run and verify

```sh
pnpm exec forgeax dev start --root apps/modeling-show                  # interactive
vitest run --project=dawn apps/modeling-show                          # 60-frame Dawn smoke with pixel falsifiers
FORGEAX_SHOW_OUT=/tmp/show vitest run --project=dawn apps/modeling-show   # also writes the frame sequence
node apps/modeling-show/scripts/smoke-browser.mjs                      # browser journey through the timeline UI
JOURNEY=panel node apps/modeling-show/scripts/page-journey.mjs <url> <out>  # debug panel controls on a built page
```

- **Dawn smoke.** It seeks fixed cues with one held camera and a still turntable (through the `pose` option), so each compared pair differs only in its own beat: the turntable spins, the transformation goes from 0 to 1, the subject explodes, the section cuts, the X-ray turns on, and the history goes from its first step to its last. The second subject must replace the first, with nothing of the first left on stage. A beat whose owner does nothing compares equal and fails. The smoke then plays the whole timeline with the real choreography in 60 completed frames.
- **Browser smoke.** It clicks segment chips, drags the slider and steps the history with the arrow keys.

## Known limits

- Section caps cover closed opaque Standard parts only. X-ray shells and open sheets keep an open cut.
- Only the turntable disc mirrors: one PlanarReflection plane per camera, on the disc top. The floor below it stays matte.
- In the browser, the history's author lines are the positions served by the dev server.
