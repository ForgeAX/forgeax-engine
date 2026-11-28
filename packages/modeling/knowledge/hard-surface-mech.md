# Hard-surface mechs and armored machines: parts first, then lines, then surfaces

Part of the [`@forgeax/engine/modeling` manual](../README.md).

A mech from a concept image fails in two opposite ways: every plate becomes a rounded car
panel, or the whole body becomes one blob with panel lines drawn on it. Both come from
skipping the reading step. This page is a set of considerations for reading a reference
as a machine, and for the order in which an armored body earns its detail. It extends
[design-methodology](design-methodology.md) (levels, drawing data, checks); read that
first. It does not give a recipe: pick what the reference needs.

## Prerequisites: what must hold before the next thing is worth doing

The order is a set of dependencies, not a checklist. When a row is false, work on a later
row is probably rework.

| Before this is worth doing | this must hold | How it is judged |
|:--|:--|:--|
| Any threshold against the reference | one authoritative reference, conflicts decided, drawing noise measured | [reading the reference](#reading-the-reference) |
| Parallel part work, later proportion changes | one spec module owns proportions, landmarks, mounts, materials; parts read it and never own a length | the spec is imported by every part; `validate({ drawing })` `dimension` items |
| Any detail | L0 masses and silhouette pass | `silhouetteIoU`, `compare`, then look at the render |
| Surface construction | parts are split and every structure line has a stated reason | structure lines drawn over the reference, read by a person |
| Joint refinement, poses | who carries, turns, pushes and passes through each joint is decided; range is measured | `rig.scan`, `clearance`, mobility ([mechanism-design](mechanism-design.md)) |
| Plates and seams | neighboring plates come from one parent form; each edge has a craft | zebra and curvature renders across the seam |
| Fasteners, grooves, text | details sit on frozen geometry and are placed by what they land on, not by typed coordinates | `thinHole`, `panelLine`, `textRegion`; no floating detail |
| Delivery mesh | topology layout is decided before the mesh exists; quality is ranked topology, cell shape, size gradation, fidelity | `meshQuality` |
| Reporting | numbers were regenerated after the last build, and each claim names the kind of evidence behind it | [evidence](#evidence-and-reporting) |

## Reading the reference

- **One authority.** When views disagree (a side view says the knee is high, the front
  view hides it), decide once, write the decision next to the `Drawing` item, and keep the
  enlarged crop that justified it. Two silent guesses become two models.
- **Measure the drawing before trusting a threshold.** Re-render or re-crop the reference
  at two scales, or compare its mirrored halves, and note how far the same outline moves.
  A gate tighter than that noise rejects correct models and trains the build to chase
  shadows. The `compare` thresholds (IoU 0.85 hard gate, `validate({ drawing })`
  silhouette 0.93) are defaults for clean sheets; loosen them for a noisy image and say so.
- **Views carry different information.** Side defines height and thickness, front defines
  width, back adds only what the others hide (back wings, vents). Weight a view by what it
  alone can say.
- **A single perspective concept image is not an orthographic sheet.** Foreshortening
  shortens near limbs and enlarges the near hand. Mark every item read from it
  `basis: 'estimate'` with a loose `tolerance`, state the assumed camera, and prefer
  proportions between neighboring parts over absolute lengths. Tighten only when a second
  view or a public dimension confirms it.
- **Cast shadows are not the silhouette.** Crop or key out the ground shadow before
  `compare` or `silhouetteIoU`; otherwise a correct model scores low and the fix goes into
  the wrong place.

## Reading a mech as parts

Ask what the machine is made of before asking what it looks like.

- A **skeleton**: a few bodies (pelvis, torso, head, limbs) with joints between them.
  Joints are exposed hardware: cylinders, rods, boots, often a different material.
- **Open shells**: one to three armor layers per segment that wrap the skeleton and do not
  close around it. A shin plate is a trough, not a tube; the gap shows the layer below.
- A **dark liner**: the inner body visible through gaps. It is a real part with its own
  material slot, not a hole.
- **Attachments**: vents, grilles, thrusters, markings, hardware. Most do not change the
  silhouette and belong to the last levels.

Then decide, for each part, how plates meet: butt, overlap or hinge. A line you cannot
justify (this is where the plate ends, this is the seam where two plates meet) is
not a structure line yet; do not model it. Do not round every plate: armor is mostly
flat or gently curved with crisp, deliberate edges, and the roundness belongs where the
reference is round.

Mechanism tools answer joint questions: [mechanism-design](mechanism-design.md) for
kinematics, `rig.scan` with `clearance` for the sweep, and the mobility checks for loops.
Ask four things of each joint and write the answers into the joint table: what carries
it, what turns, what pushes, what must pass through. A part that spans a joint (a cable,
a skirt) is bound to one side on purpose and checked across the range.

## Surfaces and plates

- **Plates that share a parent look related.** Cutting neighboring plates from one smooth
  parent form (`layer` of a region, then split it into plates with selectors) keeps highlights
  continuous across a seam. Modeling each plate on its own and joining them breaks the
  reflection at every seam; the zebra render (`forgeax model render` with the zebra mode)
  shows it.
- **The edge is part of the design.** A plate edge can be hidden under the neighbor, flat
  folded, rolled, or cut at 45 degrees; each reads differently at distance. Choose per
  edge from the reference, not one bevel for all. `bevel`, `layer` with `rim`, and
  `markCrease` with `subdivide({ creaseSharpness })` are the tools; the crease cage that
  makes an egg-shaped shell with graded edges is in `examples/pauldron` and
  `examples/limit-cage`.
- **Let the gap show something.** A seam that opens onto the dark liner reads as layered
  armor; a seam that is only a groove reads as one painted shell.
- **Keep metal honest.** `metal({ finish: 'brushed' })` and a copper colour for exposed
  joints separate hardware from armor before any texture exists.

## Detail: where it goes and what it costs

Split detail by what it changes ([game-asset-pipeline](game-asset-pipeline.md)):

| Detail changes | Keep as |
|:--|:--|
| the silhouette or a shadow edge | geometry on the form |
| only the surface relief (rivets, embossing, grilles too fine to model) | baked detail; `thinHole` for grilles |
| it moves, glows or swaps | a separate part with its own material slot, handled at run time |

Rules that save rework:

- Place fasteners and grooves on a frozen host, by label and selector, never by index.
  `array({ onCurve })` spaces them evenly along a seam curve; `recipes.hexBolt` supplies
  the bolt. A fastener must touch its host. The kernel has no dedicated
  floating-part check yet (`validate({ shells })` reports overlap, not gaps), so probe
  the contact with `sel.near` or an `interference` scan before baking.
- **Text is chirally unique.** Mirroring a part that carries text or a number reverses
  it. Build text-bearing parts un-mirrored on the correct side and mirror only the
  anonymous ones; `textRegion` strokes the text onto a face.
- Do not spend triangles on what a bake gives for free; do not bake what changes the
  silhouette.

## Evidence and reporting

Three kinds of evidence answer three different questions. They do not stand in for each
other.

| Evidence | Answers | Fails to answer |
|:--|:--|:--|
| Overlay of render on reference | does the shape match | whether a constraint holds |
| Probes: `validate`, `rig.scan`, `interference`, `meshQuality` | does a stated constraint hold | whether it looks right |
| In-game or final-pipeline capture | does it read in the target view and lighting | which part is wrong |

- Every number in a report comes from the build you ship. After the last edit, rerun the
  checks and regenerate the numbers.
- A number is necessary, not sufficient: look at every render the gate scored.
- A gate that nothing measured is not a pass. The kernel reports `nothing-checked` and
  unmeasured drawing items for this reason.
- Write the gates per level and part before the first builder, and fold the results into one
  table with `forgeax model accept`: a gate with no result is `unmeasured`, a result from an
  earlier build is `stale`, and a level cannot pass over a failing lower level.
- If the target seems unreachable, say so and show the measurement. Do not lower the
  target to make the table green.

## What the tools do not decide

Whether a plate edge should be rolled or flat, how heavy the machine should feel, and
which details deserve their triangles. The checks catch drift and constraint violations,
not intent.
