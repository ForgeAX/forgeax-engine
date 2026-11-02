# mech-gt S7: one assembly that transforms

Stage S7 of case C-100 covers the rig side of the transformation. It turns the S4
transformation into a mechanism. The S3 model, the S5 internals and joint blocks, a real mechanism
for every `transform.json` entry and the drives of every joint form one session on one rig. One
eased path moves that rig from the car form to the mech form and back.

| File | Role |
|:--|:--|
| `s7-assembly.ts` | `buildAssembly()`: the single assembly and the rig extension for drives and mechanism hardware |
| `s7-drives.ts` | linkage geometry: lever cylinders, slide cylinders, gear pairs |
| `s7-motion.ts` | `buildS7()`: the rig (via `rigOver`) and the forward, reverse and round-trip paths |
| `s7.pack.ts` | `scene/s7`, one mesh per part, `animation-clip/s7` (round trip, or `roundTrip` 0 for the run) |
| `s7-evidence.mjs` | CLI scan of the assembly with each confirmed pair assigned to its owner, pose sheets, frame strip |

## Assembly

| Group | Source | Rides |
|:--|:--|:--|
| panels, stowed robot members | `buildS3Car`, the S6b robot form (`s6bMechSource`, `s6b-robot.ts`) | `parts.json` / S4 piece joint, through its mechanisms |
| S6b sub-parts `s6b:<id>` | the S6b rig extension | their member's joint; phalanges their own knuckle joints (30, at 0 on the path); thigh and shin sleeves the knee and ankle telescopes |
| internals (24 `parts.json` ids; discs and hubs join their wheel) | `buildS5Chassis` without the hull | `parts.json` joint |
| joint blocks `hw-<joint>` | `buildS5Joints` without bones | the joint's parent (the housing side) |
| body mechanisms | recipes at the `TRANSFORM` anchor | carrier (the link before the mechanism) and the mechanism link |
| joint drives | recipes from joint-table pins | their own drive joints |

A mechanism's hardware follows its `hardware` list:

| Entry | Hinge | Slide |
|:--|:--|:--|
| base | butt hinge along the axis: leaf A on the carrier, leaf B moving | profiled rail on the carrier, carriage moving |
| `piston` | lever cylinder beside the hinge. The pins are searched for the largest lever arm with a cylinder that brackets the stroke | cylinder along the rail; the rod follows the slide |
| `gear` | wheel on the moving link around the hinge axis, pinion on the carrier | rack on the carrier beside the rail, pinion rolling on the moving link |
| `bearing` | ball bearing on the pin | — |
| `spring` | torsion spring around the pin | return spring along the rail |

`rear-wing-lift` has no hardware: S3 has no `rear-wing` part.

## Drives

A cylinder is two rig joints. The barrel is revolute about the driven axis at its base pin, and
the rod is prismatic along the barrel. Their values come from the driver joint's value at every
key, so the pins close exactly at the keys and stay within 1 mm between keys (keys every 0.004 u, at least 16 per phase).
Sizing:
- The closed and extended lengths bracket the pin distance over the travel, with an 8 mm margin at both ends.
- The bore is the largest that fits.
- The pins must move monotonically.

A gear pair is a wheel on the driven link around the joint axis and a pinion on a revolute joint
of the carrier. It is built with a wheel tooth facing a pinion gap, and the pinion turns
−wheel/pinion times the driver.

Every piston of the joint hardware table has a cylinder:

| Joint | Cylinders | Notes |
|:--|:--|:--|
| spine | 3 | |
| chest | 2 | |
| hips | 2 each | |
| knees | 2 each | |
| shoulders | 2 each | |
| elbows | 1 each | |
| ankles | 1 each | |
| knee and ankle telescopes | 1 per stage | on the outer side of the bone, stage 1 in front of it, stage 2 behind |

Joints that stay still on this path (spine, chest, hips, knees) are sized for a declared sweep.
Wrists, neck and head have gear drives; the wrist gears turn the wrist's z freedom (the path holds the wrists still).

## Path changes on the S4 v2 stow

The prone stow with telescoped legs moved the elbows 1.35 m behind the front wheels they
carry. These changes to `transform.json` remove the conflicts the full assembly met:

| Change | Why |
|:--|:--|
| New `wheels` phase: each front wheel with its wishbones, damper and halfshaft (now riding the elbow in `parts.json`) swings 180 degrees outward about a pivot on the elbow line | the wheel ends outboard of the forearm instead of swinging on a 1.35 m lever when the elbows unfold |
| Arm phases reordered: `arms-open` (fenders), `arms-out` (shoulders), then `arms` (elbows and wrists) | unfolding the elbows beside the thighs crossed the side intakes; with the shoulders out first the forearms clear them |
| Fender unfold pivots front-back at the fender's front end and flips 90 degrees up over the shoulder | a pauldron flip that clears the upper arm; turning about the old vertical pivot swept the fender through it |
| `front-motor-l/r-shift` slides the front motors outboard before the shoulders abduct | riding the shoulders from the car's centerline, they met each other and the neck mechanism |
| `pelvis-lift` raises the pelvis beam, gearbox and rear motor 0.45 m (rack and pinion) while the engine covers open; the beam narrows to x ±0.28 (S5) | riding the root, they sat in the sweep of the rear-axle groups that ride the knees when the legs untwist |
| Door pops follow the fender pops (`doors-out` phase) | the door hinge cylinders met the rising fenders |
| An `armor` phase closes the run | S6b's deployable plates are keyed there through its rig extension (`RigExtension.keys`) |
| The bumper drop no longer carries the front subframe | swinging the subframe rails over the nose drove them through the front motors and the lifted hood halves |

## Limit layout: the leg zone

The legs are two-stage telescopes (`<joint>-telescope-1` under the parent, `<joint>-telescope` under it, 0.3 m each). The knee and ankle cylinders stand on the outer side of the bone: inboard, the V12 and its rails sit beside the shut thighs. Everything else that stood below the crotch (y 2.95) in the mech form moves into the torso and back after `stand`:

| Phase | Mechanism | Mech form result |
|:--|:--|:--|
| `open` | `diffuser-lift` raises the rear diffuser center up and back, out of the ankles' path | behind the knees |
| `pack-a` | `engine-cover-*-stow-1` and `engine-cover-*-stow` (two stages) slide each cover half out and back, clear of the roof and the hips | |
| `pack-b` | `engine-cover-*-flip` turns each half 180 degrees about its top edge | back fins, y 3.07 to 4.60 |
| `pack-b` | `pelvis-flip` turns the pelvis beam, gearbox and rear motor back under the hips | |
| `pack-c` | `pelvis-raise` slides them up | backpack, gearbox y 3.53 to 3.93 |
| `pack-c` | `v12-flip` turns the V12 back under the hips | below the gearbox, y 2.97 to 3.47 |
| `pack-c` | `chest-*-open` (moved from `chest`) | the hood halves leave the front trunk before the head rises |
| `head` (now before `wheels` and `chest`) | `head-lift` | the head rises under the closed nose |
| `chest` | `bumper-drop` folds 180 degrees forward and down | upper chest plate below the head, y 4.68 to 4.93 |

Long moves are a hinge flip plus a short slide: a rail as long as the travel does not fit in the car form. The rear wheels stay at the knees and the rear fenders as knee and shin armor. The toe slides and the cover stows are two-stage (`toe-*-set-1`, `toe-*-set`; `engine-cover-*-stow-1`, `engine-cover-*-stow`) for the same reason. The front fenders pop 0.17 m. The diffuser halves are the heels.

`s7-place.ts` (design-time, not run by the build) searches drive pins and hardware positions. It
uses `s7-clearance.ts`, a capsule clearance probe over the rig's own part meshes along the path.
The search keeps the motion: hinges move only along their pin line, and rails only to parallel
lines. Hardware must stay inside the body in the car form. The results go into
`JOINT_CYLINDERS` and `MECHANISM_PLACEMENT`. `model interference` stays the acceptance check.

Hinge leaves are built with leaf A opposite leaf B's mid-travel direction, so the leaves never fold onto each other over the swing. Hardware positions along a hinge pin mirror with the anchors (a right-side hinge axis is the mirrored rotation axis).

Hardware fastened to the panels it moves, or to its base part, is a declared contact with a
10 mm tolerance (`MOUNT_TOLERANCE`), only where the hardware and the panel ride the same rigid joint. Hardware moving against a panel gets no allowance. On the sheet-form skin a leaf or rail sits on the panel
surface. S6 gives the panels their inner mounting faces. The placement search (`s7-place.ts`) also keeps every hardware capsule inside the car body in the car form and above the ground in the mech form.

### Status: frozen (2026-10-23)

The limit layout is frozen as history: the split-rear re-layout (S4 v3) replaces it. On the final commit:
- `s4-transform`, `transform` and `mechanics` unit tests pass, and the S4 path on the S3 model scans clear.
- The strict full-assembly scan has two open families. (seven hinge leaf pairs lie flush on one slab at a single pose, 2 mm deep; the coplanar-overlap detector reports them, the earlier scan passed them at depth 0.) The fender family: `front-fender-*` vs `front-wishbones-*` (up to 9 mm, u 0.686 to 0.695). The inboard upper pivot bearing of the wishbones sweeps through the fender skin at the arch edge while the wheel group swings out. It does not respond to the pop length and direction, the swing pivot, a wider arch (worse) or a trimmed liner. The scan tests hold it as an exact known pair with its depth (`FROZEN_PAIRS` in `__tests__/s7-frozen.ts`).
- Containment: the front wheel swing hardware lies outside the car-form skin, partly below the ground. Pivots that keep it inside (x 0.93 to 0.96) land the wheel on the side intakes and rear fenders. `s7-motion.unit.test.ts` holds these as an exact known-violation list (`FROZEN_OUTSIDE`); any new part or larger distance fails:

  | Part (each side) | Outside the skin (m) |
  |:--|:--|
  | `hinge-front-wheel-*-swing-a` | 0.155 |
  | `hinge-front-wheel-*-swing-b` | 0.15 |
  | `bearing-front-wheel-*-swing` | 0.29 |
  | `gear-front-wheel-*-swing`, `pinion-front-wheel-*-swing` | 0.23 |
  | `gear-bumper-drop` (center) | 0.005 |

  In the mech form the toe joint housings `hw-toe-*-mechanism` reach 3 mm below the ground (`FROZEN_BELOW`), and the soles stand 10 to 12 mm above it.
- Measured at u = 1: top 5.99 m (pauldrons; head unit top 5.71 m), crotch about 2.95 m: leg/H 0.49, head/H 0.077 (head unit) to 0.098 (S6b head). Front silhouette fill 0.33, enclosed background 0.12.

## Motion

Each phase uses the S4 values in a quintic-eased time: zero velocity and acceleration where the
phase starts and ends. A joint is keyed only within its own phase. The round trip is 12 s to the
mech form, a 1 s hold, and 12 s back.

## Verification

- `__tests__/s7-motion.unit.test.ts`:
  - one assembly: the part list, the S5 internals and the declared pistons;
  - linkage closure and pinion ratios;
  - the ease at the phase ends;
  - reverse and round trip;
  - the same faces in both forms.
- `__tests__/s7-motion.engine.integration.test.ts`: the round-trip clip plays through AssetRegistry, Animation and Scene. Every joint, including drive joints, matches the kernel pose.
- The sheet-form scan of the whole assembly is the acceptance gate: forward run every 0.05 u with travel subdivision, 0 confirmed beyond the frozen known pair (`__tests__/s7-frozen.ts`) and no clamped limit (`s7-scan.integration.test.ts`). The default modeling stage skips it and keeps a cheap check in `s7-motion.unit.test.ts`: the car form and every phase end. `pnpm test:modeling -- --mech-gt` runs the whole-run scan, and every mech-gt change must pass it. The two halves of each hinge are a declared pin contact (3 mm).
