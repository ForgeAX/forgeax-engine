# Rigging, poses and interference

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Rigging, poses and interference

`rig(session, { joints })` puts a joint table over one session. A joint has a `parent`
(one root, parents first), a model-space rest `position` and optional `rotation`
(degrees, `Rz * Ry * Rx`), and a `kind`: `fixed` (default), `revolute` (degrees about
`axis`), `prismatic` (meters along `axis`) or `spherical` (`{ x?, y?, z? }` degrees);
`axis` is in the joint's rest frame. `limits` are `[min, max]`, or one range per axis
for spherical joints (an axis without a range is locked). A joint's value moves its own
frame, its children and the parts bound to it.

```ts
const arm = rig(m, { joints: [
  { name: 'root', parent: null, position: [0, 0, 0] },
  { name: 'hinge', parent: 'root', position: [0, 0.4, 0], kind: 'revolute', axis: 'z', limits: [-90, 0] },
  { name: 'rail', parent: 'hinge', position: [0.3, 0.4, 0], kind: 'prismatic', axis: 'x', limits: [0, 0.2] },
] });
arm.bindRigid(sel.all(), 'root', { part: 'body' });
arm.bindRigid(sel.createdBy('flap'), 'hinge', { part: 'flap' });
arm.bindRigid(sel.createdBy('slider'), 'rail', { part: 'slider' });
const path = { keys: [{ u: 0, pose: {} }, { u: 0.6, pose: { hinge: -90 } }, { u: 1, pose: { rail: 0.2 } }], interpolation: 'smooth' } as const;
arm.scan(path, { contacts: [{ parts: ['flap', 'slider'] }] }); // first contacts per pair along u
```

- **Bindings**: `bindRigid(faces, joint, { part? })` names a rigid part (default: the
  joint name); `partFaces(part)` selects its faces. Bindings are selector expressions resolved whenever the rig is used; a
  later binding takes over faces an earlier one selected, so bind `sel.all()` to the
  root first. Every face must belong to a part, parts share no vertex (`disconnect` one
  first), and each binding keeps at least one face. Errors poison the rig like a session.
- **Automatic weights**: `bindAuto(faces, joints, { part?, resolution, stiffness,
  smoothing, smoothingStrength, maxInfluences, prune })` binds a deforming region (boot,
  sleeve, cable, organic skin) over several joints with the `skin.bind` compute job (TS
  baseline): a 26-connected geodesic distance from each joint's bone (joint to each
  child) through the non-exterior cells of a
  `resolution`-cell occupancy grid (default 64), W = (1 / S(d))^2 with stiffness
  S (default 0.2), `smoothing` cotangent iterations (default 8, strength 0.5), then
  normalize, at most `maxInfluences` (default 4, the Skinning kernel's width) and
  `prune` (default 0.01). A bone inside an open sleeve seeds the sleeve's inner wall,
  so open shells bind too. Vertices the region shares with rigid parts are pinned to
  their part's joint (the joint must be in `joints`), so seams never open; regions
  share no vertex with each other. `weights(part)` returns the per-vertex joints and
  weights with the job report; `pose`/`toMesh` move the region by linear blend skinning,
  `interference` and `scan` test rigid parts only, and the region exports only with
  `form: 'skinned'`. A vertex no bone reaches inside the shape falls back to straight
  distances and makes the result `partial` (`locations`, reason `unreached`).
- **Skinned LOD**: `reduceSkinForLod(input, { budget?, minMass?, keep?, positions?, poses? })`
  drops joints for a lower LOD. `input` is what `finish({ form: 'skinned' })` writes: the joint
  `names` and `parents` (`jointTreeOfPaths(skin.jointPaths)` reads them from the `SkinAsset`),
  `SkeletonAsset.inverseBindMatrices` and the mesh `skinIndex` / `skinWeight`. Leaves merge into their
  parent, lowest weight mass first (a merged leaf adds its mass to the parent, ties go to the higher
  index), so a joint with children merges only after them, until `budget` joints remain; `minMass`
  also merges every leaf under that mass. Joints in `keep` (animation targets, sockets) and their
  ancestors never merge, nor does the root; a budget below that floor is `model-precondition` with
  `floor`. Weights of a merged joint move to the nearest surviving ancestor, are summed per joint and
  renormalised, so a rigid vertex stays one influence at exactly 1; a vertex touching no merged joint
  is copied unchanged. The result carries the surviving `joints` (original indices, ascending),
  `remap` (original joint to new index, also for `ShadowCapsuleSet.joints` and clip channels),
  `names`, `parents`, `inverseBind`, the new `skinIndex` / `skinWeight` and
  `report: { before, after, merged: [{ joint, into }] }` (`into` is the parent at merge time). With
  `positions` (bind pose) and `poses` (column-major world matrix per original joint) the report adds
  `maxDisplacement`, the largest vertex move against the unmerged skin: zero at bind pose, and
  nonzero only where a merged joint moves relative to its ancestor. Pure and deterministic; build
  one `SkeletonAsset` / `SkinAsset` / mesh per LOD from the result (the Engine Import LOD generator
  keeps `skinIndex` / `skinWeight` as locked attributes and does not reduce joints).
- **Poses**: `pose(values, { limits })` is forward kinematics; `limits: 'clamp'` (default)
  applies the nearest limit and lists every clamp, `'reject'` fails instead. A path is
  keyed poses over u in [0, 1] (`linear`, `smooth` with zero velocity at keys, `step`, or
  `hermite`: Steffen's monotone cubic, which passes mid keys with velocity, never overshoots
  between keys and stops only at each joint's first and last key); keys are sparse: each joint is keyed only where a key names it, interpolates
  between its own keys (so overlapping phases need no repeated values), starts from
  rest at u = 0 unless a key names it there, and holds its last value; joints no key
  names stay at rest, so u = 0 is the rest pose unless keyed. `sample(path, u)`
  returns the pose; `toMesh(pose)` and `posedSnapshot(pose)` move a copy of the session.
- **Interference**: `interference(pose, { tolerance, contacts })` tests every part pair
  whose posed bounds overlap: a BVH narrows triangle pairs, exact predicates
  (`orient3d`) classify them. For closed parts the depth is the surface penetration:
  crossing triangles are clipped behind the planes they cross and the farthest point
  inside the other part is measured to its surface, and every vertex inside the other
  part counts too (parts sunk along shared mesh lines only touch as triangles); each pair is tested in a transform
  built from the joints below its common ancestor only, so shared motion never changes a
  result and parts whose own joints are at rest keep their exact rest contact (seams of
  split skins); parts without crossings are tested
  for containment. Open sheets use the triangles' local reach through each other.
  A penetrating pair also carries `suggestedMove`: the translation of `parts[1]` (posed model
  space) that resolves it, `depth` plus the pair's tolerance along the axis where the two posed
  bounds overlap least, away from `parts[0]` (ties: lowest axis, positive); absent at depth 0.
  Each pair also reports `reach`: how far crossing surfaces pass through each other. Thin
  parts slicing through each other have a depth of at most half the thinner part, so no
  tolerance on depth tells them from a seat: closed parts whose edges each pass through the
  other (entering one face and leaving the opposite one) with the depth at that saturation
  (at least 0.45 of the thickness passed) are `confirmed` with reason `through`, whatever the
  tolerance or seat . A part sunk less than half its thickness across another stays
  a seat. Depth is otherwise at most half the thinner part's thickness: parallel parts that
  collide edgewise in one plane (neither passes through the other; coplanar links of one
  mechanism plane) are therefore `designed` under a seat at least half their thickness and
  `candidate` below 0.2 mm thick at the default tolerance, so size seats to the measured depth.
  Plates stacked across their thickness report the full overlap.
  `confirmed` means deeper than the tolerance (default 1e-4 m), contained or through;
  `candidate` touches within it; `designed` is a declared contact within its own
  tolerance (default 1e-3 m), for pins in holes and hinge knuckles. Declare them once in
  the spec (`rig(m, { joints, contacts })`); per-call `contacts` add or override.
- **Path scan**: `scan(path, { step, maxTravel, refine })` samples u every `step`
  (default 0.05) and at every key, subdivides each interval where two parts close
  enough to meet could move more than `maxTravel` (default 0.005 m) relative to each
  other, then bisects each pair's first contact and first confirmation `refine` times
  (default 6). Parts thicker than `maxTravel` cannot pass through each other unseen,
  but a graze whose path inside the other part is shorter (a corner clipping a corner,
  0.26 mm deep at the 5 mm default in a probe) can fall between samples: lower
  `maxTravel` to bound it.
  `pass` means no confirmed interference at any sample; `clamped` lists the limits the
  path ran into.
- **DMU clearance**: `scan(path, { clearance: 0.005 })` adds the third DMU class.
  `confirmed` is a clash, `candidate` an undesigned contact, `clearance` a pair that comes
  closer than the threshold without touching; pairs that keep it everywhere (ok) are not
  listed. Every listed pair carries `minDistance` (the exact surface distance, 0 on
  contact) and `minDistanceAt`, refined by a golden-section search around the closest
  sample; `firstContact` of a `clearance` pair is the first u closer than the threshold.
  Distance changes no faster than the parts move, so an interval is subdivided until the
  bound `(d0 + d1 - travel) / 2` clears the threshold within a precision of 0.1 mm: a thin plate that passes within 4 mm for a fraction of one sample step is
  found, one at 6 mm is not. Designed contacts are exempt. Against the plain scan a
  clearance scan costs about 2x the CPU on the `transforming-limb` example (2.0-2.2x) and 1.3x on
  the `mech-gt` S4 sheet form. Surfaces a rounding apart (`minDistance` at most 1 nm) touch: the exact contact test sees no contact there, so the scan classes them
  `candidate`, not `clearance` .
- **Closed loops**: `rig(m, { joints, loops })` cuts each closed chain (four-bar,
  slider-crank, cylinder rocker, six-bar) at one joint: a loop `{ name, a, b, kind, at, axis }`
  says joint `b`'s body meets joint `a`'s body at `at` (rest model space) as a `pin`
  (coincident points, parallel axes: 5 rows), `ball` (3 rows) or `slide` (point on the axis
  line, same orientation: 5 rows). The tree holds the rest of the mechanism and the closure
  holds at rest by construction. `pose` solves the loop joints a pose does not name
  (Levenberg-Marquardt with a central-difference Jacobian) by predictor-corrector continuation
  from the nearest pose solved before: steps of at most 0.1 rad or 1 cm, each predicted along
  the tangent and accepted only when the corrected solve stays near the prediction and keeps
  the orientation of the closure Jacobian, else halved; the other assembly mode has the
  opposite orientation, so a near-parallelogram keeps its mode through its folds,
  so a path keys only the drivers and `scan`, `toMesh` and `finish` follow the closed
  mechanism; a pose the loop cannot reach is `model-solver-diverged`.
  `solve(pose, { guess? })` returns the full pose with `residual` (closure error, below
  1 nm), `conditioning` (smallest over largest singular value of the closure
  Jacobian in the solved joints), `branchGap` (distance to the other assembly mode, found by
  re-solving from starts pushed along the least determined direction) and `branchRisk` when the
  conditioning is below 1e-3 (a change point), the gap below 0.35 (a fold, where the modes come
  within 20 degrees) or continuation met a fold it could not step around. `mobility(pose, { drivers? })` compares the Gruebler-Kutzbach
  count (2 rows per pin or slide when every loop is planar) with the rank of the closure
  Jacobian over all joint coordinates: `overconstrained` when the closures only hold through
  special geometry (three coaxial door hinges count -3 and move 1), and with `drivers` the
  motions left free (`underactuated`, `uncontrolled` joints) and `redundantDrivers`. The
  spin of an S-S link (a spherical joint meeting the loop at one ball: tie rods, rod ends) is
  reported as `idle` (`idleJoints`) and left out of `mobility`, actuation and `conditioning`;
  continuation pins it, so it never reads as underactuation or a branch risk .
  Solved loop joints are not clamped to their limits (the loop would open); one that passes
  a limit is reported in `clamped` with `solved: true` (so `scan.clamped` shows it), and
  `limits: 'reject'` refuses the pose .
- **Mimic (gear ratio)**: `mimic: { joint, ratio, offset? }` on a revolute or prismatic joint
  makes its value `ratio * value(joint) + offset` (a gear, a rack on a pinion, a mirrored jaw;
  `ratio` is follower units per leader unit, mixed kinds allowed). The leader is declared
  earlier, so a cycle needs a forward reference and cannot be written. A follower is not a
  coordinate: pose, path keys, `solve` guesses, `drivers` and choreography name the leader
  (naming a follower is `model-invalid-argument`, the hint names leader and ratio), `mobility`
  and `grubler` drop one per follower, `actuation` reports only the leader (follower load
  arrives by virtual work), and `motionReport` and `phaseClaims` read a follower as its leader.
  Follower limits narrow the leader: every follower is composed to its root leader and the
  ranges intersect there; compile fails when the intersection is empty or excludes 0. A named
  leader clamps to that effective range (the clamp names the leader). `stopReport` poses a
  follower stop through the leader and reports a stop end outside the effective range as
  `unreachable`; `atStop` uses the effective range. A follower may not be a loop joint; a
  leader may. A loop-solved leader is not clamped, and a follower beyond its own limit is
  reported in `clamped` with `solved: true`.
- **Mass and actuation**: `massProperties(model, { density, faces? })` returns the
  volume, mass, centre of mass and inertia tensor (about the centre of mass) of a closed shell,
  exactly for the polyhedron (signed tetrahedra); an open selection is `model-precondition`, as
  is any connected shell that is inside-out (negative volume, e.g. `mirror` without `flip`,
  unless another shell encloses it: then it is a cavity, such as a sealed void left by a
  boolean difference, and its volume subtracts) or encloses no volume (at most 1e-9 of its
  largest extent cubed); the detail lists each such shell. `shells` counts the closed shells summed: each adds its own volume, so overlapping,
  un-booleaned shells are counted twice; boolean them (`union`) first.
  `rig.actuation(pose, { density, gravity, ratings })` weighs every closed rigid part (default
  steel, `STEEL_DENSITY`; open parts are listed in `massless`), differentiates gravity's
  potential along each driven coordinate (tree joints, and loop drivers through the solved
  loops) and reports the holding torque (N m) or force (N) per joint, the mass and centre of
  mass; an effort above its `rating` is listed in `exceeded`, as a cylinder pushing
  near its dead centre is. At a limit the derivative is one-sided; a joint resting on a
  declared stop with the effort pushing into it is `atStop` (the stop carries it, never
  `exceeded`).
- **Pose report**: `rig.poseReport(pose, { front, up, ground,
  hips, shoulders, feet, contact, density })` gives the front-view tilt of the hip and shoulder
  lines and their counter-tilt (`contrapposto`: opposite signs, 5-15 degrees apart), the
  centre of mass against the convex support polygon of the grounded feet (`margin`, negative
  outside), each foot's `gap` to the ground (grounded within `contact`, 5 mm), and the front
  silhouette's `fill` of its bounding rectangle, its `negativeSpace` (background share inside
  each row's extent above the hip line: arms standing clear of the torso) and the
  `lineOfAction` (the silhouette midline's largest deviation from the straight bottom-to-top
  line, as a share of the height, and its shape `straight`, `C` or `S`); `issues` (severity `warn`, measured values in `detail`) name
  `no-contrapposto`, `unbalanced`, `not-grounded`, `thin-silhouette` (fill below 0.41),
  `no-negative-space` (under 4 %: a box on legs) and
  `straight-line-of-action` (within 1 % of the height), and `massless` (open parts carry no
  mass and are listed in `massless`; without any mass there is no balance margin). These are
  necessary, not sufficient, hero-pose checks. `poseReport` and `actuation` reject a pose past
  a joint limit by default (a report on another pose than the one asked for misleads);
  `limits: 'clamp'` holds it and lists the joints in `clamped`. `coverage` and `pass` replace the old
  `notChecked`: a gate the options left out is `coverage.unchecked` (`no-contrapposto` without hips
  and shoulders, `unbalanced` and `not-grounded` without feet, reason `not-requested`; one of
  hips and shoulders, or no mass, is `missing-input`), and `pass` needs no issue and something
  checked, so a clean report is not read as a pass.
- **Choreography**: `rig.choreograph({ phases, duration, keyStep,
  stagger, interpolation, extra, limits })` turns phases into a path. Each phase has `from`
  and `to` values (its movers are the joints that differ, or `joints`) and a `beat`:
  `span` [t0, t1] seconds (its window), a quintic ease with an `anticipate` dip and an `overshoot`
  settle (shares of the travel, over the first and last 30 % of the window) and `within` sub-windows by
  joint-name prefix (one leads, one follows). `stagger` shifts the windows of joint groups.
  A joint follows the latest of its phases that has started. Keys sit every `keyStep`
  (0.05 s) inside each window, twice as many and cosine-spaced for shaped beats, snapped to
  a microsecond so shared window ends share a key; at each key time every phase active there
  keys its joints, so overlapping phases never interpolate across each other's keys, and
  `extra(pose, phase)` adds the values of members a key must carry (loop closures, drive
  cylinders), once per active phase. A beat that drives a joint
  past its limits fails (`model-invalid-argument`, `detail.beyond`); `limits: 'clamp'`
  holds it at the limit and lists the farthest request per joint in `clamped`. The result
  carries `extremes` per joint, `spans` (each phase's u window with its stagger and joints, for
  `phaseClaims`) and `readPoints` (each phase end with its `hold`, the seconds
  until the next phase starts, 0 while another phase moves) for a shot list. It reproduces the 523-key
  `mech-gt` example transformation (`examples/mech-gt/s7-motion.ts`) key for key with identical values.
  `rig.motionReport(path, { groups, main, duration, fps, still, readPoints, hold })` samples
  the motion per frame (24 fps): the intervals each joint group moves (speed above `still`,
  0.02 rad/s or m/s), the share of frames with at most one main group moving
  (`concurrency`), the still `holds` and the still frames after each read point;
  `issues` name `concurrent` (under 90 %) and `short-hold` (a read point held under
  `hold`, 8 frames).
- **Motion space**: `rig.sweep(path, { voxel, parts, u })`
  returns the `SweptVolume` of the parts: the cells of a world lattice of spacing `voxel`
  (0.01 is the space-claim default) they pass through. Each part's rest-frame distance field
  (`voxel.fromMesh` at half the voxel) is sampled at poses refined until no point moves more
  than a quarter voxel between samples, and a cell counts when its centre comes within about
  1.4 voxels of the part (half the cell diagonal plus the field and sampling errors), so the
  sweep covers every cube the part touches and overshoots by at most about one voxel (a
  turning bar's sweep against its analytic annulus: no cube missed, no cell beyond 1.5
  voxels). `count`, `volume`, `bounds`, `has(p)`, `union` and `sdf()` (for
  `model.voxel.toMesh`) read it; `sweepOverlap(a, b)` gives the shared cells of two sweeps of
  one voxel. `rig.phaseClaims(path, { voxel, phases: [{ id, u, joints }], contacts })` sweeps
  each phase. Every part that moves in its window is a mover: under one of its `joints`
  (`parts`; every mover without `joints`), or `unclaimed` when no overlapping phase declares
  it (drive members keyed through `extra`, loop links), never dropped. The parts that do not
  move stand still at its start. A conflict is `static` (a mover's cells meet a part standing
  still) or `concurrent` (two movers of the same phase, or of overlapping phases, share cells
  while a joint between them moves: a timing hazard a sampled scan misses when the parts pass
  the same place at different moments; parts carried rigidly together are skipped); designed
  `contacts` are exempt, and parts closer than about a voxel conflict. Pass
  `choreograph(...).spans` as the phases: each phase's actual u window, widened by its
  stagger, with its joints. `draft(model, { direction, faces, warn })` gives
  each face's angle to a pull direction: up to `warn` (85) `safe`, up to 90 `critical`,
  beyond an `undercut`; `shadowed` lists faces a ray along the direction finds behind other
  faces. `rig.release(part, path, { u, near, warn })` drafts the part's faces that have a
  neighbour within `near` (5 mm) in front of them against their velocity at u+: moving
  away is `safe`, sliding along `critical`, moving into the neighbour an `undercut` (the part
  cannot leave that way).
- **Stops**: a limited revolute or prismatic joint declares
  `stops: { min?, max? }`, each `{ stop, against? }`: the part the end lands on and the
  moving part that lands (default every part the joint carries). `rig.stopReport({ pose,
  contact })` sets each stopped joint to its limit (others at `pose`, default rest) and to
  mid-travel: `landed` when the gap at the limit is within `contact` (0.5 mm), the parts
  overlap no deeper than that (`depth`, the interference depth: a gap is only a clearance)
  and the stop is clear at mid-travel, `open` when the end stops short, `through` when it
  runs into the stop, `early` when the stop is in the way at mid-travel, `missing` when the
  stop part is not bound; `unstopped` lists limited ends without a stop, and `pass` requires
  every limited end to have a stop and every stop to land.
- **Connectivity**: `connectivity(poses, { gap, hardware, roots })`
  checks that every rigid part hangs off the roots through touching hardware in each pose.
  Parts touch when their surfaces come within `gap` (default 0.5 mm, exact triangle
  distance) or one encloses the other. Parts of one joint connect directly; across a joint
  (a part's joint and its nearest part-carrying ancestor) only when one of the two is
  hardware (`hardware(part)`, default the `mount-*` part names). The `roots` joints (default the
  rig root) and the joints above them, such as a stand mechanism, are fixed. Each pose
  lists the `floating` parts (with the nearest part they may attach to within 5 cm), the
  `detached` touch groups (one mount reattaches each) and the `unlinked` joints, which no
  hardware crossing links.
- **Mount hardware**: `mountHardware({ metal, frame, roots, hardware, poses, within, reach, clearance, seat, size })`
  builds connecting hardware at rest. It binds one rigid part per joint, `mount-<joint>`
  (faces tagged `hardware:<joint>`, box-projected UVs). Each joint whose subtree carries
  parts gets one element by kind, unless existing hardware already links it at rest:
  - revolute and fixed: a hinge, a pin in two knuckles;
  - spherical: a ball in an equator ring;
  - prismatic: a rail over the whole travel with a four-plate carriage.

  The element's halves keep `clearance` (default 0.1 mm), so they stay connected in every
  pose without touching. Placement and routing:
  - **Element:** sits on its locus (anywhere on a hinge axis, a rail parallel to the slide,
    a ball at its anchor) where it is closest to both sides.
  - **Arms:** run from the element to the nearest faces.
  - **Posts:** join the separate touch groups of one joint's parts (a minimum spanning tree).
    A post is at most `reach` long (default 0.25 m); when the closest pair of points is
    blocked, other post ends are tried.
  - **Seats:** arm and post ends sink `seat` (default 0.2 mm) into their faces, which become
    designed contacts up to the arm radius.
  - **Clearance:** every element, arm and post keeps clear of all other parts (including
    their insides) and of other joints' hardware, at rest and in each of `poses` (sample
    the transformation path), and stays inside the `within` box at rest (a car form's skin).

  What cannot is not built. It is listed in `unroutable` (`element`, `arm` or `standoff`,
  with the parts it was meant to reach) for its owner to open a path. Check the result
  with `connectivity` and `scan`.
- **Export**: `finish({ key, packageId, path?, form?, materials? })` is Pack build output.
  `materials` maps each mesh slot name to a Pack material source key
  (`{ paint: 'material/arm-paint' }`); every part entity and the skinned mesh entity then
  carry `MeshRenderer.materials` as those GUIDs in slot order, and a slot without an entry is
  `model-invalid-argument` naming it. Without `materials` the renderers carry an empty list. The
  default `rigid` form writes one `mesh/<key>.<part>` per part in its joint's rest frame
  and `scene/<key>`: a root entity, one entity per joint (`Name`, `Transform`, `ChildOf`,
  `AnimationTargetId` derived from `[key, joint]`) and the part entities under their
  joints. Rigid parts render as ordinary meshes with exact per-part bounds and culling,
  with no skinning palette or skinned material; Scene propagation moves them. With
  `path`, `animation-clip/<key>` samples the path (`duration`, `frameRate`) and the root
  carries an `AnimationPlayer` that plays it once and holds the end pose
  (`looping: false`); bind its targets with
  `bindAnimationTargets(world, root, joints)`. `clips: [{ name, path, duration, frameRate?, loop? }]`
  (exclusive with `path`) writes `animation-clip/<key>/<name>` each; the Engine clip has no
  loop flag, so `loop` is in `rig.exportedClips` (name, key, loop, duration, frames) and sets
  `AnimationPlayer.looping` for the first clip, which the player starts on. `output` and `path` record what the last
  `finish()` exported; `model.pose` and `model.interference` use that path. `form: 'skinned'` writes one mesh with
  `skinIndex`/`skinWeight` (rigid parts single-influence, `bindAuto` regions up to four
  influences), `skeleton/<key>` and `skin/<key>` for the
  Engine's Skin path (its material needs the `forgeax::pbr-skin` program).

- **Pack declaration**: a Pack returning `rig.finish()` output declares the scene's
  `sceneComponents` (`Name`, `Transform`, `ChildOf`, `AnimationTargetId`, `AnimationPlayer`,
  `MeshFilter`, `MeshRenderer`, plus `Skin` when skinned); the project build rejects the
  scene otherwise.
- **Materials**: pass `finish({ materials: { <slot>: 'material/<key>' } })` so the part and
  skinned entities carry their `MeshRenderer.materials` (see **Export** above); without it the
  list is empty and a rig scene draws with default materials.
- **Binding check**: a misspelled label inside a binding's `or(...)` selects nothing and
  leaves those faces on an earlier part; compare `rig.parts()` face counts or the
  `model pose` parts with the intended split.

Known limits: depth is sampled at clipped polygon corners and centroids, so it is
exact for convex overlaps and a lower bound for deeply non-convex ones;
`bindAuto` regions are left out of interference. Automatic weights have no bone-heat
or inpaint transfer tier yet, and falloff tails give distant bones a few percent of
weight (raise `stiffness` or `prune` to localize).
