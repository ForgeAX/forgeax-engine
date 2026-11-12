# mech-gt S4: split and transformation design (paper stage)

Stage S4 of case C-100 before its tools exist: cut, separate, rigging, joints and pose
checking arrive with B7. This stage fixes the design as data that later stages build and
check against. It adds no operators and no geometry.

| File | Role |
|:--|:--|
| `transform.json` | SSOT of the design: car-form root and pose, armor pieces, transformation mechanisms, joint hardware, phases |
| `pose.ts` | typed access and forward kinematics of the `joints.json` skeleton (reused by S7) |
| `__tests__/transform.unit.test.ts` | consistency of the design with `parts.json`, `joints.json` and the S1 car frame |
| `mechanics.ts`, `s4-mech-hardware.pack.ts`, `s4-car-mechanisms.pack.ts` | placeholder blocks for the design, built with existing operators (see below) |
| `s4-evidence.mjs` (with `evidence.mjs`) | the stage output directory of case C-100-S4, through `forgeax model *` only |

## Concept (v2, 2026-10-22)

In car form the mech lies **face down** inside the car (`carRoot`: root at
`[0, 0.58, -0.45]` on the nominal car, turned 90 degrees about X). Its legs are
**telescoped**: thigh and shin each slide shut by 0.25 m (`telescopes`, opened in the legs
phase). The root sits in the tub, the spine and chest along the cabin floor, and the head
under the cowl. The arms run straight back along the sills, and the legs lie twisted out
45 degrees beside the engine with the feet in the tail. The car rear becomes the legs, the
cabin and tub the torso, and the front clip the chest. The trunk itself is the S5
internals (monocoque = torso core, V12 = back power core, gearbox and rear subframe =
pelvis, front subframe = chest frame), so S3 builds no trunk volumes.

### Why v1 changed

v1 laid the mech straight with its root at the wheelbase center, so the post-merge scan
found its stowed core inside the S5 internals (13 confirmed at rest). With the S5 joint
mechanisms placed too, the conflict turned out to be geometric:

- The shoulders are 3.9 m above the feet, and the tail is 3.85 m from the front axle. In
  any straight pose, head first or feet first, a shoulder mechanism lands inside a wheel
  (84 mm into the front tire).
- Inside the wheel barrel, the upper arm cannot leave without crossing the tire or the
  hub and upright.
- Kneeling (hip about -15 degrees, knee 150) was approved but fails: with the ankles limited
  to 40 degrees, the 0.5 m feet stand up through the deck. A grid search over hip, knee,
  ankle and root found only poses with the two feet crossing.
- Telescoped legs save 0.5 m, enough to move the whole mech 0.45 m back. The shoulders
  clear the front wheels and the feet still fit in the tail.

Placement rules that came with it:

- The stowed volumes stop outside each end joint's mechanism sphere.
- Actuators span the shut bone length.
- The tub bulkheads are notched where the core passes.
- The front motors move outboard of the head.
- The rear suspension became a low-arm pushrod layout (the coil-over lies between the
  arms), so the knees pass above the rear corners.

| Car region | Mech | Main parts |
|:--|:--|:--|
| front clip (frunk) | chest, head stowage, hands | `hood-l/r`, `bumper-center`, `head-unit`, `hand-l/r` |
| front fenders and wheels | pauldrons, forearms | `front-fender-*`, `front-wheel-*`, `front-wishbones-*` |
| cabin and tub | torso core, back, wings | `monocoque`, `roof-front/rear`, `door-*-outer/inner` |
| engine bay | backpack, pelvis | `engine-cover-l/r`, `v12-engine`, `rear-subframe-center` |
| rear fenders, wheels, tail | legs, calves, toes | `rear-subframe-l/r`, `rear-fender-*-front/rear`, `rear-wheel-*`, `diffuser-l/r` |

## Car-form pose

Joint angles in degrees; the right side mirrors y and z. Every value is inside its
`joints.json` limit, and the folded skeleton stays inside the S1 envelope (tested by
forward kinematics).

| Joint | Angles | Why |
|:--|:--|:--|
| shoulder | y 30, z -10 (left) | arms straight back along the sills, outside the tub and the engine bay |
| hip | y 45 (left) | legs twisted out so the feet lie flat into the tail corners |
| knee, ankle | telescopes 0.25 m each | legs shortened by 0.5 m, so the whole mech moves 0.45 m back |
| ankle | x -40 | feet folded toward the tail, above ground clearance |
| neck | x 20 | head tucked under the cowl, below the hood |

The knees land within 0.3 m of the rear axle, which is why `parts.json` mounts the rear
wheels on the calves (`knee`). The shoulder mechanisms stay behind the front wheels.

## Armor split

`pieces` cut ten body and chassis parts into 23 rigid pieces that exist in both forms
(criterion 5: the same part set). Pieces of one part may ride different joints. For
example, a rear fender becomes a knee cap (`knee`) and a heel guard (`ankle`), and the
engine cradle becomes a pelvis beam (`root`) and two hip rails (`hip-l/r`) so the tail
can split into legs. Parts without pieces move as one unit.

## Mechanisms and phases

| Phase | u | Motion |
|:--|:--|:--|
| unlatch | 0.00-0.10 | body locks release |
| open | 0.10-0.25 | door hinges and skin split slides, engine cover hinges, rear wing slide |
| legs | 0.25-0.45 | leg split slides on the cradle rails, toe cap hinges; ankles and toes unfold |
| stand | 0.45-0.60 | the root turns upright about the hip line |
| chest | 0.60-0.75 | front clip flip (180 degree hinge over the windshield base), roof front fold |
| arms | 0.75-0.90 | fender hinges into pauldrons, front wheel swing arms, halfshaft release slides, hand hinges; shoulders, elbows and wrists unfold |
| head | 0.90-1.00 | chest plate slides part, head lift slide, door wing hinges; neck and head unfold |

Anchors and axes are car-form coordinates at u = 0. Hinge ranges are degrees and slide
ranges meters. Mirrored pairs reflect anchors across X: slide axes mirror as vectors
and hinge axes as rotation axes. Every mechanism names the B4 recipes it needs.

## Joint hardware (S5 build list)

Every joint with degrees of freedom has a hardware entry whose kind follows its DOF
count: revolute for 1, universal for 2, spherical for 3. Each entry lists counts of
`gear`, `piston` (hydraulic rod), `bearing`, `bolt`, `spring`, `hinge` and `slide-rail`
from the B4 recipe library; the root has none. S5 turns these entries into modeled parts
(criterion 3: every movable joint has its mechanism).

## Placeholders (sketch views)

`mechanics.ts` attaches the design to the S1 skeleton using today's operators, so the
design can be rendered and validated before S5. Every block is a separate closed part.

| Design entry | Placeholder | Operators |
|:--|:--|:--|
| spherical joint | bearing ring (r 0.11 m) facing along the bone from its parent, ball inside | `cylinder`, boolean `difference` (bore), `sphere` |
| universal joint | two crossed pins | `cylinder` x2, boolean `union` |
| revolute joint | clevis block with a fork slot open toward the child, pin bore, pin | `box`, boolean `difference` x2, `cylinder` |
| hinge mechanism | bored knuckle and pin on the anchor, along the axis | `cylinder`, boolean `difference`, `cylinder` |
| slide mechanism | rail along the axis (travel + 0.12 m) and a carriage beside it | `box` x2 |

Bones stop at the support distance of the blocks on their joints, so the result
validates with no crossing. `s4-mech-hardware.pack.ts` gives the mech form and
`s4-car-mechanisms.pack.ts` the car-form mechanisms inside the S1 envelope. Their
checkpoints (`skeleton`, `spherical`, `universal`, `revolute`; `envelope`, `hinges`,
`slides`) are the case steps.

## Verification on the B7 rig

`s4-transform.ts` `rigOver` puts any car-form session on a `rig`, and the transformation
is verified on the S3 rough model (`s3-rough.ts`, `s3.pack.ts`): NURBS panels with shut
lines, lathed wheels and the mech volumes.

- **Rest pose (car form).** Each `joints.json` joint sits at its car-form frame
  (`pose.ts` `carFormFrames`), under a `lift` slide for the stand-up.
- **Mechanisms.** Every mechanism is a revolute or prismatic joint, chained under the
  joint of the pieces it moves. Design rule, tested: everything one mechanism moves rides
  one joint.
- **Mech form.** The move to the mech form is `mechPose` minus `carPose` per axis, within
  the shifted `joints.json` limits. The `lift` slide carries the root from its car-form
  position to the mech root, and each telescope is a slide on its bone.
- **Path.** Every joint is keyed at rest at u = 0 and at the start and end of its own
  phase, so a phase moves only its own joints (tested).

The scan runs in **sheet form**: open skin panels and closed mech volumes. A closed
panel's penetration depth cannot exceed half its wall, so thin panels slicing through
each other would never be confirmed. The first S4 result, scanned on closed S2 panels,
missed exactly that (forgeax-modeling #54, corrected). The sheet-form path scan of
`forgeax model interference` is clear: 0 confirmed at every 0.05 u, with refinement and a
travel bound of 5 mm. No limit is clamped, and the only candidate is the hood-halves seam.

Design changes the scans forced:

| Finding | Change |
|:--|:--|
| Panels swung along seams they shared with their neighbours | unlatch phase: doors and engine-cover halves pop out, fenders pop up, tail corners spread, before any hinge turns |
| Gull lids crossed each other near the centerline | lids pop outward first; hinges 12 cm off center |
| A 180 degree front-clip flip swept through the folded head, neck and chest | no flip: the hood stays on the mech back (the car underside is the chest front); the bumper assembly drops 90 degrees to open the nose for the head |
| The roof front rode the neck 1-1.5 m below it | it rides the chest |
| Assemblies tore apart (bumper corners, headlights, inner doors on other joints) | they ride the joint of their mechanism |
| The fender unfold swept over the hood and the parked wheel | the arms unfold first, then the fenders pop up and unfold outward |
| Abducting shoulders lifted the forearm wheels through the hood | elbows unfold before the shoulders abduct (25 degrees); the wheel swing, hand deploy and door wing hinges are removed |
| The rising head met the hood halves | the hood halves lift 0.3 m in the chest phase |
| Two-axis car-pose joints had no exact inverse | per-axis car pose (v1 single-axis; v2 keeps every path end exact per axis) |

On the v2 stow, the S3-rig scan is clear before the arms phase. From there the front
wheels, which ride the elbows (now 1.35 m behind them), swing through the hood and
fenders, and the forearms and hands meet the side intakes. Those pairs wait for the motion
line's wheel transfer mechanisms and are listed explicitly in the test.

## S7 path changes

S7 changes the path on the v2 stow so that the single assembly (panels, stowed core, S5
internals and mechanisms) scans clear. It adds a `wheels` phase, in which the front wheels swing
onto the forearms. The arm phases run in the order fenders, shoulders, elbows. The fenders flip up
over the shoulders into pauldrons. The front motors shift outboard, and the pelvis beam and
gearbox slide back during the stand-up. See `S7-MOTION.md`.

## Open for later stages

- The full assembly scan (S5 internals and joint mechanisms on the rig) belongs to the
  motion line (S7, criterion 5). The car form at rest is clear (`car-form.unit.test.ts`).
- The mech silhouette is a rough model: S6 refines panels and volumes.
- Anchors are placed against the S1 envelope and zones. S2/S3 move them onto the real
  body surfaces, and the tests keep them inside the body.
- Actuator sizing (piston stroke, gear ratios) waits for the B4 recipe parameters.
