# Mechanism design: joints, loops, clearance, stops and load paths

A mechanism is a set of rigid parts, the joints that constrain them, and the proof that the
motion works: no part passes through another, every joint stops where intended, and the
actuator can hold the load. This note covers how to plan that with the kernel's rig tools.
It matters for any model that moves: hinged panels, linkages, telescoping limbs, wheels on
suspension, transforming vehicles.

Owners:

| Concern | Reference |
|:--|:--|
| `rig`, joints, loops, `solve`, `mobility`, poses, paths | [rig](../reference/rig.md) |
| `interference`, `scan`, `stopReport`, `connectivity`, `mountHardware`, `actuation` | [rig](../reference/rig.md) |
| `recipes.*` machine parts and `isoFit` | [rig](../reference/rig.md), [operations](../reference/operations.md) |
| `rig.sweep`, `phaseClaims`, `draft`, `release` | [sweep-deform](../reference/sweep-deform.md) |
| Validate options, `designed-contact` | [validation](../reference/validation.md) |
| Timing the motion | [animation-presentation](animation-presentation.md) |
| Planning order for transforming designs | [design-methodology](design-methodology.md) |

Runnable shapes: `examples/hood-linkage` (four-bar plus hydraulic strut), `examples/door-hinge`
(hinge, bolts, spring), `examples/hydraulic-joint` (cylinder, bearing, fits),
`examples/suspension` (parameter ranges and designed contacts), `examples/transforming-limb`
and `examples/limb-choreography` (stowed-first transformation).

## 1. Decide the kinematics first

Before geometry, write the chain as data: for each moving part, its parent, joint kind, axis,
pivot position and range. In the kernel this is the `joints` array of `rig(m, { joints,
loops, contacts })`:

- `kind`: `fixed`, `revolute`, `prismatic`, `spherical`; `axis` and `limits` (degrees or
  metres) for the moving kinds.
- `mimic: { joint, ratio, offset? }` makes a follower track a leader (gear pairs, parallel
  scissor halves). A pose names the leader only; naming a follower is
  `model-invalid-argument`, and follower limits narrow the leader's range.
- `stops: { min?, max? }` of `{ stop, against? }` records which part is meant to stop the joint
  at each end (section 6).

Keep pivot coordinates in one table that both the geometry and the rig read; a hinge pin
drawn 2 mm off its declared pivot is the commonest reason a mechanism "almost works".

Plan the degrees of freedom. A free planar part has 3, a spatial part 6; each joint removes
the rest. Count them with `mobility(pose, { drivers })`, which returns the Grubler count and
three flags:

- `overconstrained`: more constraints than needed. Three coaxial door hinges count -3 and
  still move 1; that is fine when they are coaxial, a defect when a manufacturing error would
  jam them.
- `underactuated`: the drivers do not fix the pose.
- `uncontrolled` and `idle` / `idleJoints`: joints no driver moves.
- `redundantDrivers`: two drivers fight for one freedom.

Read the count as a design check, not an alarm: a count of 1 with one driver is the common
target; a count of 0 means the parts cannot move at all.

## 2. Closed loops

A tree of joints cannot express a four-bar, a scissor or a strut that closes back on the body.
Declare each closure in `loops: [{ name, a, b, kind: 'pin' | 'ball' | 'slide', at, axis }]`:
a pin removes 5 rows of freedom, a ball 3, a slide 5. `at` is the world position of the
closing joint; `axis` its direction.

```ts
// examples/hood-linkage/hood.ts
const loops = [
  { name: 'm2', a: 'link2', b: 'hood', kind: 'pin', at: at(M2, z), axis: 'z' },
  // ...
];
const joints = [
  { name: 'rod', parent: 'barrel', position: at(C0, zc), kind: 'prismatic',
    axis: CYLINDER_AXIS, limits: [0, STROKE] },
  // ...
];
const path = { keys: [{ u: 0, pose: { rod: 0 } }, { u: 1, pose: { rod: STROKE } }],
  interpolation: 'smooth' };
const s = r.solve(r.sample(path, u));        // Result<{ pose, residual, ... }>
```

`solve(pose, { guess })` finds the loop-consistent values of the unlisted joints. What to read
in the result:

- `residual` below 1 nm means the loop closes. A pose the linkage cannot reach returns
  `model-solver-diverged`; widen the driver range or correct a link length.
- `conditioning` near zero and `branchGap` small mean the linkage is near a singularity or
  another assembly branch. `branchRisk` is set when conditioning is below 1e-3, or the gap
  to the other branch is under 0.35, or continuation along the path met a fold. A mechanism
  that can flip branches at some pose is a defect even when the sampled poses look fine:
  change link lengths or add a stop.
- A loop-solved joint pushed past its limit appears in `clamped` with `solved: true`; the
  design is asking for more range than the joint has.

Transmission angle is the quality check that the kernel does not compute: the angle between
a driving link and the link it pushes should stay roughly between 40 and 140 degrees over the
whole stroke, because near 0 or 180 the output force blows up and the linkage jams. The
hood example keeps a small hand-written `transmission(angles)` function (angle between the
cylinder axis and the pushed arm, folded to 0..90 degrees) and evaluates it over the solved
poses of the stroke; do the same for any linkage and tune the pivot positions until the
worst value is healthy.

Over-centre locks (toggle clamps, strut stays) hold by passing the dead point by a small
margin. `recipes.overCenterLock` builds one and refuses `overCentre <= 0`; the margin sets
the holding force and the release effort, so sample both sides of the dead point with
`solve`.

## 3. Standard parts and fits

Reach for `recipes.*` before modeling a machine element by hand. Each returns
`Result<RecipePart>` with `model`, `anchors` (named attachment points) and `dimensions`, and
the part drops into a session with `m.append(part.model, { translate, tag })`:

| Recipe | Notes |
|:--|:--|
| `gear`, `rack` | tooth form from module and teeth; mate by anchor distance |
| `hydraulicCylinder({ bore, rod, stroke, extension, pin, name })` | barrel, rod, end clevises; `extension` poses the rod |
| `ballBearing`, `hexBolt`, `hexNut`, `washer`, `coilSpring` | stock elements |
| `hinge`, `slideRail` | leaf hinge with knuckle, linear guide |
| `pinJoint({ d, name })` plus lug, clevis, bushing, rodEnd | refuses lug edge ratio e/D below 1.5 |
| `overCenterLock` | see section 2 |

Fits decide whether a pin turns or sticks. `isoFit(d, 'H7/h6' | 'H7/g6' | 'H8/f7' |
'H11/c11')` returns the bore and shaft limits for a nominal diameter from 1 to 180 mm;
`fitSegments` and `clearanceRadius` turn a fit into modeled radii. Choose by role: H7/h6 is a
locating fit, H7/g6 a slow sliding or pivot fit, H8/f7 a free running fit, H11/c11 a loose
fit for dirty or hot service. Model the bore and the pin at their actual radii rather than
the same radius: a zero-clearance pin is a self-intersection, and the validator will say so.

When parts touch on purpose (a pin in its bore, a gear mesh, a roller on a rail), declare it:
`validate({ contacts: [{ parts: [a, b], tolerance }] })`. The report then carries a
`designed-contact` issue with `detail.fits` for the pair instead of a `self-intersection`,
so real clashes stay visible. `examples/suspension` builds a whole axle this way and probes
parameter ranges to see which combinations leave the designed set.

## 4. Clearance through the motion

The question "do parts hit each other anywhere in the stroke" has two tools:

- `interference(pose, { tolerance: 1e-4, contacts })` checks one pose. Each pair is
  `confirmed` (volumes truly overlap), `candidate` (within tolerance, thin features, or too
  thin to be sure) or `designed` (declared contacts, tolerance 1e-3). Fields: `depth`,
  `reach`, `suggestedMove` (a translation that separates the pair) and reason `through`
  when one part passes entirely through a sheet; a through-pass needs at least 0.45 of the
  sheet thickness. A seat is designed at half the thickness or more; below 0.2 mm
  thickness a pair is only a `candidate`.
- `scan(path, { step: 0.05, maxTravel: 0.005, refine: 6, clearance, contacts })` sweeps a
  whole path with adaptive refinement so that no step moves a point farther than
  `maxTravel`. It reports `minDistance`, `minDistanceAt`, `firstContact`, `clamped` and
  `pass`. Add `clearance` (a required gap) to get the `clearance` class; it costs about
  twice the CPU. A pair with `minDistance` at or below 1 nm is a `candidate`, and designed
  contacts are exempt.

Weigh these when reading a scan:

- A `confirmed` pair at the very first sample is usually a modeling fault (a bolt not
  subtracted from its hole), not a motion fault.
- Anticipation or overshoot added for animation widens the scan range; scan the path you
  will actually play, not the nominal one. In `examples/limb-choreography`, an anticipation
  that stayed inside the joint limit still drove the upper arm into the chassis, so the beats
  were reduced to overshoot only.
- `clamped` in a scan means a sampled pose was pushed to a limit; the path asks for more
  than the rig allows.

Only rigid parts are tested. Auto-weighted skinned regions are not, so keep structural parts
rigid.

## 5. Motion space: swept volumes, claims and release

Static clearance of the moving part is not the same as the space it needs. `rig.sweep(path,
{ voxel: 0.01, parts, u })` returns a `SweptVolume` (`count`, `volume`, `bounds`, `has`,
`union`, `sdf`) for the voxels a part passes through. Uses:

- `sweepOverlap(a, b)` compares two parts' swept volumes: shared voxels mean the paths cross
  somewhere, even if the parts never meet at the same time. Combine with phase information
  before calling it a clash.
- `rig.phaseClaims(path, { voxel, phases: [{ id, u, joints }], contacts })` tests who owns
  space in each phase. A `static` conflict is a moving part sweeping through a part that is
  not moving in that phase; a `concurrent` conflict is two parts moving together through the
  same voxels. `unclaimed` lists motion that no phase accounts for (an undeclared mover).
  Resolve a conflict by reordering phases (section 9), not by shrinking parts.
- `draft(model, { direction, faces, warn: 85 })` reports pull directions for casting or
  moulding: safe, critical (near the warn angle) and undercut faces, plus `shadowed`.
- `rig.release(part, path, { u, near: 5 mm, warn })` looks at the part's faces that have a
  neighbour within `near`: moving away is `safe`, sliding along is `critical`, moving into
  the neighbour is an `undercut` (the part cannot leave that way: a pin that must withdraw,
  a cover that must lift).

## 6. Stops

Every joint with a limit needs something to stop it. Declare it in the joint's `stops` and
check with `rig.stopReport({ pose, contact: 0.5 mm })`, which classifies each end:

- `landed`: at the limit the gap is within `contact`, the overlap is no deeper than that, and
  the stop is clear at mid-travel.
- `open`: the end stops short of the stop.
- `through`: the end runs into the stop.
- `early`: the stop is already in the way at mid-travel, so the usable range is shorter than
  declared.
- `missing`: the declared stop part is not bound to the rig.

`unstopped` lists limited ends with no stop declared; `pass` requires every limited end to
have a stop and every stop to land. Design stops into the structure (a tab, a boss, a face of the frame) so the load of a
stop goes into a frame, not into the hinge pin.

## 7. Sizing the actuator

`rig.actuation(pose, { density, gravity, ratings })` returns, per driven joint, the holding
torque or force needed at that pose given the mass of everything the joint carries, and
flags `exceeded` against `ratings`, `atStop` when a stop is carrying the load, and
`massless` when a downstream part has no solid volume. It rejects a pose beyond a limit
unless `limits: 'clamp'`.

Mass comes from `massProperties(model, { density, faces })`; use `STEEL_DENSITY` for steel
or pass the real density. It requires closed, outward-facing shells and returns
`model-precondition` otherwise; overlapping shells that are not combined with a boolean are
counted twice, so combine or separate them first.

Weigh: take the worst pose, not the nominal one (a strut holding a hood is loaded most at the
bottom of the stroke where the lever arm is longest); add margin for friction and dynamic
load; and for a hydraulic cylinder convert force to bore with pressure, then check the rod's
buckling length by hand since the kernel does not.

## 8. Load paths and hardware

A mechanism that moves correctly can still be unbuildable if a part floats.

- `connectivity(poses, { gap: 0.5 mm, hardware, roots })` checks that every rigid part hangs
  off the roots through touching hardware in each pose. Per pose it lists `floating` parts
  (with the nearest part they could attach to), `detached` touch groups (one mount
  reattaches each) and `unlinked` joints (no hardware crosses them). Parts touch when their
  surfaces come within `gap` or one encloses the other; across a joint only hardware
  (default the `mount-*` part names) connects. Run it at several poses; a panel can be
  supported when closed and floating when open.
- `mountHardware({ metal, frame, roots, hardware, poses, within, reach: 0.25, clearance: 0.1
  mm, seat: 0.2 mm, size })` builds one rigid part per joint, `mount-<joint>`: a hinge for
  revolute and fixed joints, a ball in a ring for spherical, a rail with carriage for
  prismatic. Arms run to the nearest faces, posts join separate touch groups (at most `reach`
  long), and every element keeps clear of other parts in each of `poses`. What cannot be
  routed is listed in `unroutable` (`element`, `arm` or `standoff`); move the joint nearer to
  structure or open a path. Check the result with `connectivity` and `scan`.
- Put loads through the stiffest section and keep pivot pins in double shear (a clevis
  rather than a single lug) when the load is large; `recipes.pinJoint` with clevis and lug
  builds the pair, and the e/D ratio guard keeps the lug from tearing out.

## 9. Stow first, then unfold

For a design that transforms (vehicle to robot, panel stack to display), choose the stowed
configuration first and make it a valid object by itself, then derive the unfolded one.
Reasons: the stowed state has the tightest packaging, so it fixes volumes and joint
positions; the unfolded state has slack. Procedure:

1. Place every part in its stowed pose and run `interference` and `connectivity`.
2. Define the unfold as a path (sparse keys, `interpolation: 'smooth'` or `'hermite'`) and
   `scan` it with a `clearance`.
3. If a conflict is a timing problem, split the motion into phases and check them with
   `phaseClaims`; reorder rather than redesign.
4. Check every stop with `stopReport` at both ends.
5. Sample the loops with `solve` over the path and read `branchRisk`.

`examples/transforming-limb` and `examples/limb-choreography` follow this order. The timing
of the phases is covered in [animation-presentation](animation-presentation.md).

## 10. Delivery

A finished mechanism leaves the session with `finish({ key, packageId, path?, form:
'rigid' | 'skinned', materials, clips })`. Rigid form keeps one mesh per part, which is
what clearance, stops and hardware were checked on; `skinned` is for deforming regions.
`rig.exportedClips` and `bindAnimationTargets` carry the choreographed paths to runtime
clips, and `sceneComponents` describes the entities to spawn. Keep a validation call with
`contacts` for every declared designed pair in the build, so a regression in a fit shows as
a located issue.

## 11. What the tools do not decide

- Stress, fatigue, thermal growth, friction and wear: the kernel is geometric.
- Dynamics: acceleration, inertia and backlash are not simulated; `actuation` is static.
- Buckling and bearing life; manufacturer part tables beyond `isoFit`.
- Whether the linkage looks right; judge from renders at several poses.
