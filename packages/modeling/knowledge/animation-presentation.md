# Animation and presentation: timing a motion and judging a pose

A mechanism or a character that moves has to be read by a viewer: one thing happens at a
time, each end pose is held long enough to be understood, and a hero pose has a clear
silhouette. This note covers how to turn a joint-space motion into a timed path, how to
measure whether it reads, how to check a still pose, and how a path becomes an exported clip.
It matters whenever a rig is shown rather than only built. Camera, lighting and render
settings are outside the kernel and appear here only as judgement (section 8).

Owners:

| Concern | Reference |
|:--|:--|
| `rig.choreograph`, `rig.motionReport`, `rig.poseReport`, clips, `finish` | [rig](../reference/rig.md) |
| `rig.phaseClaims`, `rig.sweep`, `rig.release` | [sweep-deform](../reference/sweep-deform.md) |
| Clearance and stops that the motion must respect | [mechanism-design](mechanism-design.md) |
| Joint ranges, loops, solving | [mechanism-design](mechanism-design.md), [rig](../reference/rig.md) |
| Character pose planning | [stylized-character](stylized-character.md) |

Runnable shape: `examples/limb-choreography` (a limb that transforms in seven phases) built
on `examples/transforming-limb`.

## 1. Path first, timing second

A motion is data before it is animation: a path `{ keys: [{ u, pose }], interpolation }`
over a normalized parameter `u`, with sparse keys. `interpolation` is `'linear'`, `'smooth'`,
`'step'` or `'hermite'`. Two layers:

1. Joint-space design: what each joint does, in what order, between which values. Check this
   with `scan`, `stopReport` and `phaseClaims` ([mechanism-design](mechanism-design.md)).
2. Timing: when each phase starts and ends in seconds, how it eases, where it rests.
   `rig.choreograph` produces both from one table.

Do not time first. A timing tweak changes the poses sampled between keys, so every clearance
claim has to be re-run after any change to timing, easing, anticipation or overshoot.

## 2. Phases with `rig.choreograph`

```ts
// examples/limb-choreography/choreo.ts
const phases = [
  { id: 'fender-open', from: { 'fender-hinge': 0 }, to: { 'fender-hinge': 105 },
    beat: { span: [0, 1], overshoot: 0.03 } },
  { id: 'wheel-up', from: { 'wheel-swing': 0 }, to: { 'wheel-swing': p.wheelSwing },
    beat: { span: [1.4, 2.3], overshoot: 0.05 } },
  { id: 'hand-out', from: { telescope: 0 }, to: { telescope: p.stroke },
    beat: { span: [6.3, 6.9] } },
];
const result = r.choreograph({ phases, duration: 8.4, interpolation: 'hermite' });
```

Each phase has `from` and `to` joint values (its movers are the joints that differ, or an
explicit `joints` list) and a `beat`:

- `span: [t0, t1]` seconds: the window the phase owns.
- A quintic ease inside the window: slow in, slow out. Use it for anything with mass.
- `anticipate`: a dip against the direction of travel, as a share of the travel, over the first
  30 percent of the window. It reads as preparation.
- `overshoot`: travel past the target and settle back, over the last 30 percent. It reads as
  weight and makes a stop look soft rather than clipped.
- `within`: sub-windows by joint-name prefix, so that one joint leads and another follows.

Other options: `keyStep` (0.05 s) sets key density; shaped beats get twice as many keys,
cosine-spaced. `stagger` shifts the windows of joint groups so a chain (shoulder, elbow, wrist)
follows with delay instead of moving as one block. `interpolation` is applied between keys.
`extra(pose, phase)` adds the values a key must carry that are not driven by the table, such
as loop-closure joints or drive cylinders, once per active phase.

Limits matter. A beat that drives a joint past its limit fails with `model-invalid-argument`
(`detail.beyond` names it) instead of clamping silently; `limits: 'clamp'` holds it at the
limit and lists the farthest request per joint in `clamped`. This is deliberate: an
anticipation dip below a hinge's closed limit is a request to push into the body. Two
outcomes seen in the example: the dip was refused for the fender hinge; and for the shoulder
a dip that stayed inside the limit still drove the arm into the chassis (a scan confirmed
it), so the final design used overshoot only on the big swings.

The result carries:

- `path`: the sampled keys for `sample`, `toMesh`, `scan`, `sweep`.
- `extremes` per joint: the farthest values reached, including anticipation and overshoot,
  for checking against limits and ratings.
- `spans`: each phase's actual `u` window, widened by its stagger, with its joints; pass it
  straight to `phaseClaims`.
- `readPoints`: each phase end with its `hold`, the seconds until the next phase starts (0
  while another phase moves). This is the shot list.

## 3. One thing at a time

The viewer follows one main action. Overlap is a tool, not a default: small secondary motion
(a latch settling, a cover closing) may overlap a main swing, two big swings must not.

`rig.motionReport(path, { groups, main, duration, fps: 24, still: 0.02, readPoints, hold: 8 })`
samples the motion per frame and reports, per joint group, the intervals in which it moves
(speed above `still`, in rad/s or m/s). Name the groups by the story, not by joint:

```ts
const GROUPS = { fender: ['fender-hinge'], wheel: ['wheel-swing'],
                 arm: ['shoulder', 'elbow'], hand: ['telescope', 'claw'] };
```

Readings:

- `concurrency`: the share of frames in which at most one main group moves. The issue
  `concurrent` fires below 90 percent. Raise it by moving a window, not by speeding things
  up: shrinking a window to avoid overlap makes the motion snappy and hard to follow.
- `holds`: the still stretches, and the still frames after each read point. The issue
  `short-hold` fires when a read point is held fewer than `hold` frames (default 8 at 24 fps,
  one third of a second). A pose that is not held is not read.

Typical windows: a big swing 0.8 to 1.5 s, a small adjustment 0.4 to 0.7 s, a hold after each
read point 0.3 s or more, a longer hold (a second) at the end pose of the story.

## 4. Space and timing together

Timing can hide or create clashes that a sampled scan misses. `rig.phaseClaims(path, {
voxel, phases, contacts })` sweeps each phase and reports:

- `static` conflicts: a mover's swept cells meet a part that stands still in that phase;
- `concurrent` conflicts: two movers of overlapping phases share cells while a joint between
  them moves, a timing hazard the sampled scan misses when parts pass the same place at
  different moments (parts carried rigidly together are skipped);
- `unclaimed` movers: a part that moves in a window no phase declares (a drive member, a
  loop link). Fix by listing it in the phase `joints` or the `extra` callback.

Feed it `choreography.spans`. If a `concurrent` conflict appears, shift one window until the
overlap disappears; if a `static` conflict appears, the geometry or the order has to change.
Then repeat `scan` over the played path with a `clearance`; anticipation and overshoot are
part of the played path.

`rig.release(part, path, { u, near, warn })` answers a presentation question as well: can
this part move away at this moment (a cover lifting off before the arm swings) without
the neighbours blocking it.

## 5. Actuator and holding checks over the path

At each read point the mechanism rests, so every rest pose must hold itself or be held by a
stop. For each, run `rig.actuation(pose, { density, gravity, ratings })` (holding effort per
joint, `exceeded` against ratings, `atStop` when a stop carries the load) and
`rig.stopReport({ pose })`. A pose that needs a large holding torque on an unstopped joint is
a design question: add a stop or a detent, or move the read point to a pose that is stable.

## 6. Hero pose for a figure

A still pose is judged with `rig.poseReport(pose, { front, up, ground, hips, shoulders,
feet, contact: 0.005, density, limits })`. The report measures, from the front view:

| Measure | Issue code | Threshold |
|:--|:--|:--|
| hip line and shoulder line tilt in opposite directions, 5 to 15 degrees apart (`contrapposto`) | `no-contrapposto` | outside that range or same direction |
| centre of mass against the convex support polygon of the grounded feet (`margin`) | `unbalanced` | negative margin |
| each foot's `gap` to the ground | `not-grounded` | gap above `contact` (5 mm) |
| silhouette `fill` of its bounding rectangle | `thin-silhouette` | fill below 0.41 |
| background share inside the silhouette rows above the hip line (`negativeSpace`) | `no-negative-space` | below 4 percent |
| deviation of the silhouette midline from a straight line (`lineOfAction`, shape `straight`, `C` or `S`) | `straight-line-of-action` | within 1 percent of the height |
| open parts carry no mass | `massless` | listed in `massless` |

Weigh the intent behind each:

- Contrapposto: hips and shoulders tilt against each other so the pose has weight and rhythm.
  A stiff, symmetrical pose is correct for a monument and wrong for a character.
- Balance and grounding: a pose that cannot stand reads as falling or floating. A deliberately
  airborne pose is the exception, and the report will say so.
- Silhouette: the pose should read as a black shape. A thin fill (a stick figure) or a box
  with no gaps between arms and torso is a weak silhouette; open the elbows, move a hand out.
- Line of action: one flowing line through the pose (C or S) gives energy; a ruler-straight
  one is stiff.

`coverage.unchecked` lists the checks the options left out (`not-requested`) or could not run
(`missing-input`); `pass` needs no issue and at least one check performed, so an empty request
never reads as a pass. A pose past a joint limit is rejected unless `limits: 'clamp'`, which
lists the joints in `clamped`. All of this is necessary, not sufficient: the pose still has to
look good from the camera that shows it.

## 7. From path to clip

A choreographed path becomes a runtime clip through `finish({ key, packageId, path?, form,
materials, clips: [{ name, path, duration, frameRate?, loop? }] })`. `rig.exportedClips` lists
what will be exported (name, key, loop, duration, frames), `bindAnimationTargets(world, root,
joints)` binds the clip targets to entities, and `sceneComponents` describes what to spawn
(`Name`, `Transform`, `ChildOf`, `AnimationTargetId`, `AnimationPlayer`). Export rigid when the
parts were checked as rigid, skinned when regions deform.

Weigh: the clip frame rate should be the one used for `motionReport` so holds measured in
frames are real; a looping clip needs its first and last key to match; the exported
`duration` should equal the choreography `duration`.

## 8. Judgement the kernel does not make

Everything below is outside the rig tools. Treat it as a checklist for review renders.

- Camera: pick a focal length that does not distort the form (a moderate telephoto for
  products and mechanisms, wider only for environments), frame the whole silhouette with
  margin, keep the horizon level unless tilted on purpose. Show a transformation from a fixed
  camera so the change is the only thing that moves; a move on top of the motion competes
  for attention.
- Lighting: a key light from about 45 degrees to the side and above, a softer fill, a rim
  light that separates the silhouette from the background. Avoid hard shadows across the
  features that matter. Check that a metallic part has something to reflect, and that the
  flat colours of a stylized figure do not wash out.
- Background: a plain contrasting value helps the silhouette; clutter hides it.
- Review sequence: render the end poses stills first; then the motion; then the transitions
  frame by frame at the tightest clearance. Fix timing last.
- Pacing: a story with six phases at 1 second each and no holds feels like a blur. Cut
  phases or lengthen the total before shortening holds.
