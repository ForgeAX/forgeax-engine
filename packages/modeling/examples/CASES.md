# Case evidence

Per-example evidence and test commands, moved from the package README. The example index is [README.md](README.md).

Every capability is proved by a concrete asset built with it. `examples/crate/` is case **C-001**, a hard-surface prop crate built only from P0
operators: `crate.ts` is the straight-line build and `crate.pack.ts` the ordinary Pack
(`mesh/crate`, parameters `width`, `height`, `depth`; relative imports carry `.ts`).
`examples/case/` holds what the cases share: `record.ts` (the observing session factory
that maps every journal entry to its source line) and `render.ts` (the Dawn harness,
step framing, highlight and label views, and the `history.json` step format).

- `examples/crate/__tests__/crate.unit.test.ts` checks the build: validate has no
  warnings, every label, role, tag and material region survives changed sizes, and
  export -> lift -> export keeps the triangles.
- `examples/crate/__tests__/crate.tools.integration.test.ts` loads the Pack through the
  real loader (`createModelingTools`, the path of `forgeax model inspect|select|validate`):
  five sessions, a warning-free validate, and the same selection under other parameters.
- `examples/crate/__tests__/crate.case.dawn.test.ts` renders each step on the real
  Renderer and draws 60 completed frames of the default and the variant crate, which
  must differ by the Engine Feature Lab threshold (the Lab's `editable-modeling` page
  renders the same recipe in Chromium). With `FORGEAX_CASE_OUT=<dir>` (and
  `FORGEAX_CASE_COMMIT=<sha>`) it writes the case output directory: `step-NN.png`,
  `view-V-*.png`, `history.json`, `validate.json` and the source snapshot.

```bash
FORGEAX_CASE_OUT=./case-out/crate FORGEAX_CASE_COMMIT=$(git rev-parse HEAD) \
  node node_modules/vitest/vitest.mjs run --project=dawn packages/modeling/examples/crate/__tests__/crate.case.dawn.test.ts
```

`examples/desk-lamp/` is case **C-002**, a desk lamp that covers what C-001 did not:
`revolve`, `extrudePolygon`, `cone`, `bisect`, `split`, `triangulate`, `fillHoles`,
`duplicate`, `disconnect` and the selectors `near`, `thin`, `loop` and `ring`, in six
sessions (base, switch, clip, bulb, shade, lamp). `lamp.pack.ts` (`mesh/lamp`, parameters
`height`, `reach`, `shadeRadius`), `lamp-tall.pack.json` and `lamp-pair.pack.ts` are the
three reuse paths above. Its unit test checks the source-line history, a warning-free
validate (also with a 0.5 mm wall check), the same regions under two other parameter
sets, and the lift round trip; its tools test goes through `forgeax model *`.
`lamp.case.dawn.test.ts` writes its case output directory the same way (57 steps, eight
final views including both variants and the product-reuse pair).

`examples/bracket/` is case **C-010**, a machined angle bracket finished with bevels: a
six-segment concave fillet ending in both side faces, a chamfered boss, a rounded blind
slot (mixed convex/concave corners), four-segment rounds on every remaining convex edge
with patterned corners, and a boss-foot fillet whose clamp is reported.
`bracket.pack.ts` is `mesh/bracket` (parameters `length`, `height`, `thickness`, `depth`,
`fillet`); `bracket.case.dawn.test.ts` writes its case output directory the same way.

`examples/housing/` is case **C-012**, the thin-walled lower housing of a handheld
device: a rounded footprint with a vent band, inset slots, `shell` with the top and the
slots as openings, a tongue lip on the top rim, `bisect` floor pads raised into drilled
screw bosses and a rib. `housing.pack.ts` (`mesh/housing`, parameters `wall`, `vents`)
is the Pack; its tools test runs `model.diff` on two parameter sets and two checkpoints,
and `housing.case.dawn.test.ts` writes the case output directory including the V-diff pair
rendered in the `model.diff` frame and `data/diff.json`.

`examples/hydraulic-joint/` is case **C-102** (a `mech-gt` part), the hydraulic joint of a
mech limb assembled from recipes: a base plate with anchor bolts, a pivot tower, a clevis,
a hydraulic cylinder, an arm fork turning in two ball bearings on an M12 pivot, M10 pins
with nuts and spacers. The cylinder extension sets the arm angle by a two-circle closure;
`joint.pack.ts` is `mesh/hydraulic-joint` (parameter `extension`), and
`joint.case.dawn.test.ts` writes the case output directory with section, exploded and V-diff
views.

`examples/door-hinge/` is case **C-103** (a `mech-gt` part), the upper door hinge: the hinge
recipe bolted with M8 bolts and nuts to body and door brackets, a hold-open spring on the
pin overhang and a trim cover with a rounded rim and panel lines (a U groove along a closed
edge loop and a V seam cut by a plane); the door side then opens about the pin.
`hinge.pack.ts` is `mesh/door-hinge` (parameter `openAngle`).

`examples/suspension/` is case **C-104**, the left front double-wishbone corner of
`mech-gt`: upper and lower A-arms swept along bent polylines with bushings arrayed along
their pivot axis, an upright lofted through 4/8/6/4-vertex sections with a swept,
tapering steering arm, a revolved hub with a brake disc and five radially arrayed
studs, a coil-over whose spring is a helix sweep between arrayed perches, and a tie
rod with a hexagonal adjuster and a lofted rack boot; seven sessions appended into
one assembly. `suspension.pack.ts` is `mesh/suspension` (parameters `armRadius`,
`springTurns`, `wire`, `bend`); the unit test checks that every swept or lofted region
is a closed, warning-free solid on its own and that regions and copy counts survive a
variant, and `suspension.case.dawn.test.ts` writes the case output directory.

`examples/body-blockout/` is case **C-105**, the `mech-gt` car body blocked out from
three views (an S2 preview of `mech-gt` at low fidelity). `body.ts` holds the design drawing
(public length, width, height and wheelbase from the S1 `CAR` table, plus three outlines
the author traced as dense samples: side profile, plan, front section, each scaled onto
its public envelope), fits a contour to each trace within 4 mm, intersects the view prisms
with `threeView`, cuts four wheel arches with the boolean, assigns the greenhouse to
glass and adds the ISO-sized wheels. `body.pack.ts` is `mesh/body-blockout`; the unit test
checks the closed, warning-free result and the public envelope within the fit tolerance.
`c105-evidence.mjs <engine-worktree> <out>` writes the case output directory through
`forgeax model *` only: per-step orthographic sheets (`--step`), the annotated drawing
sheet, section, X-ray, explode and replay views, `dimensions.json`, `validate.json` and
`history.json`.

`examples/body-panels/` is case **C-106**, the `mech-gt` hood and front fenders as NURBS
panels (an S3/S6 part of `mech-gt`). `panels.ts` fits sections to the S2 contours (the hood
centerline to the side profile, the fender outer line to the plan outline), lofts them
across stations and tessellates three panels with `m.surface`: the hood as two patches
joined at the centerline, trimmed for two vents (stroked slots in its domain) with a
carbon strip imprinted, and each fender as a front and a rear patch joined at the cowl
section, trimmed for the wheel arch by a side-view circle and imprinted with a `GT` badge
in stroke text. The rear patches carry a number decal sheet, `shell` gives every panel a
3 mm wall and `panelMaterials()` returns the procedural car paint, carbon fiber, chrome
and decal materials. `panels.pack.ts` emits `mesh/body-panels` with its materials and
generated textures; the unit test checks watertight joins, closed valid panels and the
contour fit, the tools test runs the real Pack loader, and `panels.case.dawn.test.ts`
cooks the materials, renders every step, the final views, a material sheet and per-tool
before/after pairs, and writes the case output directory.

`examples/mech-gt/` is the final target **C-100** (code name `mech-gt`, a car that
transforms into a mech), built stage by stage; each stage adds its own Pack layer. Stage
S1 is the proportion frames: `proportions.ts` builds `s1-car.pack.ts` (`mesh/car-frame`:
body envelope cage, ISO-sized wheel envelopes, axle lines, wheelbase marker and the
`frunk`, `cabin` and `engine-bay` zones from public dimensions; `CAR` marks each value
`public` or `estimate`) and `s1-mech.pack.ts` (`mesh/mech-frame`: joint markers, bones,
head envelope and a head-unit ruler from `joints.json`, imported with
`with { type: 'json' }`). `parts.json` is the part list both forms share: every part
names a car-frame zone and a mech joint. The unit test measures the export against the
public dimensions (2 % tolerance) and checks both table schemas; `s1-evidence.mjs
<engine-worktree> <out>` writes the stage output directory (steps, views,
`dimensions.json`, `validate.json`, `history.json`) through `forgeax model *` only.
Stage S4 is first a paper design (`S4-DESIGN.md`): `transform.json` holds the car-form
root and pose, the armor pieces cut from `parts.json` parts, the hinges and slides of each
transformation phase and the joint hardware S5 builds. `pose.ts` gives forward kinematics
of the skeleton. Its test checks the design against the joint limits, the part list and
the S1 envelope. `mechanics.ts` renders the design with placeholder blocks (bored bearing
rings, crossed pins joined by `union`, slotted clevises, hinge knuckles and slide rails)
in `s4-mech-hardware.pack.ts` and `s4-car-mechanisms.pack.ts`; `s4-evidence.mjs`, like
`s1-evidence.mjs`, drives the shared `evidence.mjs`.
Stage S2 (`s2-body.ts`, `s2-body.pack.ts` → `mesh/s2-body`) is the body block from three
views on the S1 frame. Its drawing carries the S1 envelope, wheel circles and tire
footprints as silhouettes, so every orthographic drawing compares the body with S1.
Bisect planes at the part boundaries split the hull into large faces, and booleans open
the wheel arches and the side and front intakes. Every body face carries exactly one
`parts.json` body part tag. The test holds length, width, height and wheelbase within 2 %
of S1; `s2-evidence.mjs` writes the stage directory from orthographic `model render` sheets.
Stage S5 has two Packs. `s5-chassis.pack.ts` (`mesh/s5-chassis`) places the internal
mechanics inside the S3 panels (closed 3 mm walls, no solid hull): tub with bulkheads
notched for the stowed core, battery and harness, front rails and rear cradle, four
double-wishbone corners (recipe pivot bearings, dampers and springs; low rear arms with the
coil-over lying between them), front motors, V12, a hollow gearbox with a recipe gear pair,
rear motor and halfshafts; `buildS5Internals()` is the same set without the body, every part
tagged `part:<id>`. `s5-joints.pack.ts` (`mesh/s5-joints`) gives every movable joint of the
skeleton its recipe mechanism (ball bearing; crossed pins in bearings; clevis with bolt and
nut) plus hydraulic actuators beside the parent bones; `buildS5JointsStowed()` places them at
the car-form joints. Both validate with no crossing or touch; the test keeps every internal
part inside a compartment or wheel well. `s5-evidence.mjs` renders the section, X-ray and
exploded views, including an internals-only explode.
Every absolute position (zones, splits, profile keys, compartments, frames, mechanism
anchors) is authored against the nominal S1 car and placed through `fit` (`proportions.ts`:
piecewise linear along z over tail, axles and nose, scaled across and up), so the stages
follow `CAR`: the perturbation test rebuilds S1, S2, S3 and S5 on a 1 % and a 6 % longer
wheelbase and checks validation, the S2 3 mm wall, the compartments and the car form at rest.
Stage S3 (`s3-rough.ts`) is the rough model of both forms. The car form is the C-106 NURBS
hood and fenders plus patches of one S2-derived body surface for every other panel, with
shut lines, trims, closed 3 mm walls and lathed wheels (`s3-car.pack.ts`). The mech form is
one lofted volume per limb segment and the head; the trunk is the S5 internals. Each volume
is placed at its joint's car-form frame so it folds inside the car, and stops outside the S5
mechanism spheres of its end joints. `s3.pack.ts` puts both on the S4 rig (`s4-transform.ts`
`rigOver`) and `finish`es the scene with the transformation clip, so `forgeax model pose`,
`model interference` and `model render --u` work on it. The S4 test scans that path in sheet
form (open skin panels, closed volumes) every 0.05 u with no clamped limit and the same part
set in both forms; the car-form test checks the S3 panels, the stowed volumes, the S5
internals and the stowed joint mechanisms at rest (0 confirmed interference).
`s3-evidence.mjs` and `s4-verify-evidence.mjs` write the stage directories.
Stage S6 (`s6-exterior.ts`) is the final exterior, split into five part groups (`front`,
`nose`, `cabin`, `rear`, `wheels`), each its own Pack (`s6-<group>.pack.ts` →
`mesh/s6-<group>`) so every build stays inside the Pack build budget, with the S3 rig's
part tags. Panels are the S3 NURBS patches as closed 3 mm walls whose visible edges get a
1.2 mm chamfer; the nose adds headlight lenses, the rear taillights and carbon diffuser
pieces, and the wheels are lathed tires, rim barrels, five-spoke faces (extruded with spoke
windows), hubs, brake discs and calipers. Every slot gets a procedural Standard material
(tiling textures on uv1 in meters); `uv.auto` charts the uv0 atlas, and the Pack defers a
normal and AO bake (`bakeSources`) whose detail adds louver ribs over the engine cover, so
the `louvre` slot wears the baked normal map. Each Pack also requests two LOD levels from
Import's chain (`generatePackMeshLods`, error-bounded: about 50 % and 35 % of the triangles
at 0.4 % and 1.5 % of the extent). `s6.case.dawn.test.ts` builds and bakes every group,
renders the finished car and its LODs and writes the stage directory with the per-group budget.

`examples/panel/` is case **C-011**, an equipment panel built with the boolean jobs: a
2 x 4 hole array (one difference, eight tool components), four rounded vent slots (each
a union), a flush pocket with a unioned boss bored through, a U-handle union, a domed
knob from an intersection and an access cover split out with `splitBy`. `panel.pack.ts`
is `mesh/panel` (parameters `width`, `depth`, `thickness`); its unit test checks the
source-line history, that every boolean ran `ok` on the baseline with complete
provenance, and the same regions over the declared range. `panel.case.dawn.test.ts`
writes the case output directory, with `validate.json` from the `model.validate` tool.

`examples/pauldron/` is case **C-014**, the left shoulder armor of `mech-gt` (`parts.json`:
`front-fender-l` becomes the pauldron on `shoulder-l`): a low-poly 6 x 4 plate with an
inset panel, a raised spine and recessed side panels whose edges are marked sharp, two
Catmull-Clark levels (rolled rim, crisp panel lines), a lattice dome, a taper and a bend
over the shoulder ball, plus a chest-side mount subdivided with creased long edges. A
`rig` over the mech-gt joints binds the plate to `shoulder-l` and the mount to `chest`;
`pauldron.pack.ts` exports the rig (`scene/pauldron` with one mesh per part, parameters
`length`, `width`, `curl`). The unit test checks a warning-free history, the same regions
over the declared range and the two poses, and `pauldron.case.dawn.test.ts` writes the
case output directory with the cage/subdivided and rest/raised V-diff pairs.

`examples/wheel-rim/` is case **C-101** (a `mech-gt` part), the alloy wheel rim sized from the
S1 front wheel (20 in bead seat diameter): a revolved deep-dish face disc whose flat spoke
face is merged per spoke with `cleanup.planar`, spoke windows cut in one difference by a
`radial` array of corner-rounded (bevelled) window prisms, chamfered window rims, lug
pockets and holes (a radial array of five) and the center bore, then a revolved barrel
(flanges, bead seats, drop center well) with a rounded lip, the face unioned in and a
valve-stem hole. `wheel-rim.pack.ts` is `mesh/wheel-rim` (parameters `diameter`, `width`,
`spokes`, `offset`). The revolve segment count is a multiple of twice the spoke count, so
facet edges run along every spoke and window centerline, and every drill turns half a
facet: no tool edge lies on a facet edge. The unit test checks that every named selector
(window walls and chamfers, lip round, lug and bore walls, valve, machined lip) still
lands in its semantic region, with the same per-window counts, over the declared range;
`wheel-rim.case.dawn.test.ts` writes the case output directory with the `model.diff` pair of
five and seven spokes. `record.ts` maps a `for` loop's repeated calls to the loop body.

`examples/transforming-limb/` is case **C-107** (a `mech-gt` part): the front-left corner of
the car that becomes the robot's left arm. One straight-line session builds the fender
on a hinge recipe, the shoulder on a ball-bearing recipe, the upper arm and the folded
forearm with clevis lugs, a slide-rail recipe and a hydraulic-cylinder recipe for the
telescoping hand, the claw and the wheel on a swing arm (72 operations). `limbRig`
binds seven rigid parts to seven joints (revolute fender hinge, shoulder, elbow, wheel
swing and claw, a prismatic telescope) and `limbPath` keys the transformation in
overlapping phases. Its unit test requires a scan with no contact at all and no clamped
limit, and catches the first design (`beamEnd` 0.45: the upper-arm beam over the elbow
meets the forearm web from u = 0.6885). `limb.engine.integration.test.ts` instantiates
the exported scene in an ECS World, binds the joint targets and checks every joint's
propagated transform against the kernel's forward kinematics at six points of the clip.
`limb.case.dawn.test.ts` writes the case output directory (84 steps: the build, the binding,
nine poses on one camera, the scan and the first design's clash).

`examples/wheel-uv/` is case **C-013**, UV unwrapping of a tire and a hub cap. The tire
is a revolved section with two grooves and 128 tread pockets, first box projected (the
before state), then cut by a radial seam and sidewall seams and unwrapped with LSCM; the
first attempt warns that the pocketed, grooved tread strip is heavily distorted, so the
second unwrap also cuts along the sharp edges (`seams: 'sharp'`) and every piece
develops. The hub cap is unwrapped along its sharp edges, its badge re-unwrapped with
ExpMap, and both parts share one packed atlas. `wheel.pack.ts` is `mesh/wheel`
(parameters `grooveDepth`, `pocketDepth`, `segments`). `wheel.case.dawn.test.ts` produces the V-uv views: checker renders on the
session's own uv0 (`checkerTexture`, `checkerMesh` in `examples/case/render.ts`) and the
atlas layout (`uvLayoutMesh`, `layoutView`), before and after, plus `uv.json` with the
`measureUv` facts of each state.

`examples/joint-boot/` is case **C-108** (a `mech-gt` part): the flexible boot over the
mech's left knee (`joints.json` `knee-l`). Thigh and shin cuffs with clamp rings and
five overlapping elliptical bellows folds are revolved as nine closed rings;
`voxel.union` (6 mm grid, 16 mm blend, two smoothing sweeps) melts them into one hollow
corrugated sleeve, four `bisect` cuts trace the clamp band borders, which are marked
sharp, `remesh` evens the triangles to about 12 mm while the borders slide along
themselves, the outer band faces are offset 4 mm as labeled steel clamps, and `simplify`
brings the part to its 4000-triangle budget with every clamp label border an exact hard
edge; a cylinder projection gives the new surface UVs. `boot.pack.ts` is `mesh/knee-boot`
(parameters `folds`, `blend`, `budget`) as the `BOOT_JOB` mesh job: in place the build
took 8 s at the defaults and 11 to 15.5 s at the maxima (one run hit the 15 s timeout);
deferred it takes about 10 ms, and `boot.pack.integration.test.ts` fails above 10% of the
budget; `boot.import.integration.test.ts` runs the Pack through Import's
`buildScriptablePack` with `createMeshJobCooker([BOOT_JOB])` and checks the published
mesh-binary (and the structured failure without the cooker); `boot.case.dawn.test.ts` writes the case output
directory with wire close-ups of each stage, the nearest-face tags of the union, the hard
edges, a capped section and the 4000 / 1500 budget pair.

`examples/armor-bake/` is case **C-110** (a `mech-gt` part): a detail map bake for the
mech's shoulder armor. The detail plate carries a vent grille, three panel line grooves
and six bolts; the low-poly base is the same plate as a 6 x 4 grid with the same dome,
taper and curl. `uv.auto` charts the base (6 charts along the sharp rims), and one bake
pass maps the detail onto it as normal, AO and material-id maps. `armor.pack.ts` is
`mesh/armor`, `mesh/armor-detail`, `material/armor-baked` and the three maps as
`modeling-bake` cook sources (parameters `curl`, `resolution`). `armor.case.dawn.test.ts`
renders the base wearing its maps beside the detail, the maps over the UV square,
`bake.json` (job metrics and the tangent frame check) and the maps as PNG data.

`examples/actuator/` is case **C-112** (a `mech-gt` part): the mech's thigh actuator (the
S5 hydraulic-cylinder recipe with a bellows dust boot) through the S6 game-ready route.
`buildActuatorDetail` is the bake source: 64-segment revolutions, two port bosses (a
designed 1 mm contact with the barrel), two V panel-line grooves and six gland bolts.
`buildActuatorShell` deletes the hidden rod (simplifying it next to the gland bore would
close their 0.3 mm clearance), revolves the boot at 24 segments with one marked seam down
its meridian (`uv.auto` must not chart a closed band), simplifies only the rigid parts to
the rest of the 1500-triangle budget and auto-UVs the shell; `actuatorBake` maps the
detail onto it as normal and AO (projection distance 7 mm: the default 4.4 mm starts rays
inside the 5 mm bosses). `actuatorRig` binds the barrel and rod rigidly, the boot with
`bindAuto` over the gland and rod joints, and its collars rigidly to those joints (the
shared seam vertices are pinned). The unit test checks the budget, clean validation, the
pins, zero crossings over the whole stroke, the exported skin posed by the Engine's
`skinVertexPosition` against the rig within 1e-5 m, the bake against a self-bake
falsifier and the Pack outputs; the first design (`simplifyBoot`: the boot decimated with
the rest) folds its lowest fold into itself at full retraction. `actuator.pack.ts` is the
skinned shell (`mesh/`, `skeleton/`, `skin/`, `scene/`, `animation-clip/actuator`),
`mesh/actuator-detail`, the two maps as `modeling-bake` cook sources and one Standard
material per slot (parameters `stroke`, `rest`, `folds`, `budget`, `resolution`).
`actuator.case.dawn.test.ts` writes the case output directory: both builds, the bake, the rig,
the boot weights, five skinned poses wearing the maps, the first design, `bake.json`,
`budget.json`, `weights.json` and `poses.json`.

`examples/tunic/` is case **C-113** (artist editing tools), structure first: a revolved
mannequin torso whose chest moves forward with a symmetric, connected soft selection; a
bodice `layer` over the torso band (4 mm gap, 2 mm wall, conformed); a flared skirt whose
waist band is shrinkwrapped onto the hips and blends free below; a V-neck knife-projected
onto the visible bodice and recessed; and a side seam cut along the skirt surface (UV seam
and hard edge). `tunic.case.dawn.test.ts` frames every step on the region it edits and
also draws the artist operators before their step from the same camera.

`examples/quality-body/` is case **C-114** (surface quality): a car-like body
corner (hood, fender and door with a waist crease) built the right way and the wrong way.
Right: feature lines first (`m.featureLine`, 4 control points each, fair), panels lofted
between them (8 x 3 nets), the shoulder and waist creases held by 5 mm and 3 mm G2 blends,
exported along the isoparms as quads (`spacing: 'even'`, `nonPlanar: 'keep'`). Wrong: the
same shape traced with 0.4 mm noise on a 24 x 18 grid and interpolated into one patch.
`quality-body.unit.test.ts` is the gate (right passes `surfaceQuality` and `edgeFlow`,
wrong fails density, feature loops, aspect and has triangles; its hood curvature ripples
over 5 times more); `quality-body.case.dawn.test.ts` renders both as zebra, mean
curvature (one range), V-wire, combs and shoulder close-ups from the same cameras.
`views.ts` shows how a script builds those views from the kernel functions. Fitted
(`buildRight(session, { fitted: true })`): the same noisy trace, each panel fit
between its two feature lines (fixed boundaries) to a 4 x 5 net with curvature-rate
fairing; it passes like the right body (fit error under 0.65 mm, hood roughness within
2 x), while one 8 x 6 patch over the whole trace smears both creases. `layout.ts` builds the right body from a patch layout
(`buildFromLayout`): 0 findings with `layout` added to the checks.

`examples/patch-network/` is case **C-115**: the door side, C-pillar and rear deck
side of a mid-engine body corner, lines first: the knee
and shoulder lines are single-span curves; the lower band is fit to a noisy trace with the
knee as its fixed edge and split exactly into P04, P04c and P05; P10 and P11 are fit with
the knee and shoulder pieces as fixed edges, and S03 (the C-pillar) between them is
matched G2 to both; the knee is a G0 crease on its line held by three G2 blends, which trim
the patches beside it. `patch-network.unit.test.ts`: 0
layout and surface-quality findings and no T-junctions, the tessellated C-pillar seams at
the surface-quality limits, and the same region traced and interpolated with `nurbs.grid` failing
density and fairness; `patch-network.case.dawn.test.ts` renders both.

`examples/scifi-mech/` is case **C-410** (showcase): an original 3.5 m heavy bipedal
mech built as a high-to-low bake. Every part is described once (`mech.ts` over the hard-surface
kit `kit.ts`) and built at two levels: `LOW` is the form layer (chamfered slabs, frame
struts, 12-segment hubs and rams, 6-sided hoses), `highUpTo(stage)` adds the detail source
stage by stage (`form`, `bevel`, `panels`, `vents`, `fasteners`, `hydraulics`, `markings`):
edge bevels, raised and stacked panels with V seams, through-hole vents with louvre slats over
hex-perforated sheets, `recipes.hexBolt` rows and domed rivet rows along every rim,
`recipes.gear` hub caps, `recipes.hinge` hatches and seeded greebles, braided hoses (a
twisted 12-lobe `sweep` with fittings placed by `array onCurve`), `recipes.hydraulicCylinder`
rams, a `recipes.coilSpring` damper, cable bundles, `textRegion` stencils and hazard chevrons
(tagged `floater`) and emissive slits. The full build is 2.76 M high triangles against 14.8 k
low (99.46 % fewer). `pipeline.ts` folds every recipe slot into eight bake classes (the
material-id palette), packs the low groups into three 2048 atlases with `uv.auto` (groups
balanced to 381-413 px/m; hard edges above 45 degrees are chart borders; the mirrored limbs
share texels, so stencils sit only on unique parts) and returns `bakeSettings('after' |
'before')`: bake groups `bake:<group>.<element>` (body, hoses and rams are separate low
geometry), the averaged cage blended to the face normal 2 cm from hard edges, a 5 cm / 11 cm
cage (the automatic cage reached 11 cm / 26 cm on the torso), AO over all groups, floaters;
`before` is the pre-cage behaviour (split shading normals, AO per group) kept as the
hard-edge falsifier. `scifi-mech.unit.test.ts` checks the low budget and slot folding, a
high group 30x denser than its low with counted features, byte-identical rebuilds, the three
atlas densities within 8 % with no chart across a hard edge, and the head baked onto its low
against a self-bake falsifier. The case harness (`examples/scifi-mech/case/`) bakes the
sets at 2048 px, composes albedo / ORM / emissive from the material ids with a layer-3 wear
pass (edge chipping, scratches, grime and rust from the baked curvature and AO plus
object-space noise), encodes KTX2 and renders HIGH, LOW + maps and LOW without maps with the
Engine Renderer.

`scifi-mech.pack.ts` is C-410 as a page asset: `mesh/c410-low.<part>` (19 parts, one slot per
texture set, the set's `uv.auto` atlas), `mesh/c410-high` (the detail source without the
fastener stage, decimated by `simplify` to at most 300 k triangles), per set
`texture/c410-<set>-normal|albedo|orm|emissive` (2048 normal and albedo, 1024 ORM and
emissive, UASTC KTX2 through `encodeKtx2`: normals BC5 RRRG, the rest BC7-class),
`material/c410-baked-<set>` and `material/c410-plain` (constant values, maps off). All heavy work
is in `show-job.ts` (`c410.set1|2|3` bake with parallel Workers and compose through `maps.ts`,
`c410.high` decimates), cooked by `createC410Cooker()`; the Pack's `build()` only lists the
outputs (5 ms). `show.ts` is the page metadata (`SHOW_META`), its stats read `show.stats.json`,
written from the cooked outputs by `scifi-mech.show.integration.test.ts`
(`FORGEAX_C410_COOK=1`, plus `FORGEAX_UPDATE_GOLDEN=1` to rewrite).
