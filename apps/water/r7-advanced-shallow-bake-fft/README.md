# Water: Shallow, River Bake And FFT

Run `pnpm dev` and open <http://127.0.0.1:5387/>. The Chinese demo uses ordinary
Pack assets and the standard single-layer-water depth/reflection path. The
three scenes share one Renderer and its normal completion receipts.

An illuminated laboratory floor connects the shallow, River Bake and Ocean
stations. The architecture is supporting presentation; the station views keep
the actual Water output and selectable collision fixtures visible.
Textured Terrain beds retain the authored depth and calibration grid. Station
framing keeps the basin rim, physical gauges and active water surface together;
the shallow, real River Bake and independent FFT operations remain unchanged.

The shallow controls select saved collision recipes and real native rotating
box/capsule, empty-aggregate bounds, nonuniform distance-field and overlapping
fixtures. Rotation changes ordinary Scene poses while centers remain fixed.
The world-water-level control changes the Body Transform; the vertical fixture
group keeps native boxes at world Y `4`, `2.5` and `7 m` for the nonzero-height
selector case. A fourth thin box sits above Y `4 m` with a positive surface gap
of `3/16` of the loaded recipe's cell size, separating a plane from a cell-thick
selector. Automatic NDC impacts have a separate control.

The yellow trajectory specimen has an admitted kinematic sphere collider.
The native dynamic sphere action hands it to the native dynamic solver with CCD and buoyancy,
launches from 7 m above the water, and derives its entry impulse from the
completed native crossing. The basin floor is a native static collider.
Reset restores the trajectory specimen. Runtime facts distinguish this body
from the intentionally kinematic rotation, overlap and source-selection fixtures.

## Authored Configuration

This project explicitly selects `deltaLimit: { kind: 'application-cap',
maximumDeltaSeconds: 1 / 60 }`, live River simulation and nonzero Foam emission.
Enabled rigid recipes explicitly author `overlapThicknessCells: 1`; this is
the coefficient for full vertical overlap size. The disabled rigid branch has
no thickness parameter. Foam advection, emission and dissipation use
frame delta; solver substeps retain their recipe's independent timestep path.
The current Foam contract follows the source's disabled noise branch.
`normalFoamRange: [0,1]` is authored explicitly. Prep Debug writers and the independent River Foam debug
writer are disabled in these three appearance scenes.
`startFadeSeconds: 2` is explicitly authored. WaterBody applies its
origin-relative smoothstep before each depth substep and retires 15 seconds
after water contact ends. Selecting `source-default`
fails recipe creation with `water-advanced-source-parameter-unavailable`; it does
not simulate a guessed zero cap or indicate a device capability failure.

Ocean defaults to the loaded `recipe/ocean` with `gridMesh: null`. The mesh
control selects the separately authored `recipe/ocean-grid` through the World
owner, whose flat grid extent is `[16,16] m` independently of the FFT normal
domain. It emits GPU buffers without attaching a visible Scene mesh or applying
FFT displacement. Changing recipes retires the previous World patch.

## Visual Acceptance

Acceptance is registered before the first demo run:

- Near, middle and distant views retain inspectable water, shore objects and
  reflections on desktop and a narrow mobile viewport, without panel overlap.
- The moving shallow patch reprojects its previous field. A sphere impact
  displaces water; subsequent completed frames show propagation after injection
  stops. The actual Grid/Normal/Foam intermediate bytes accompany the images.
- Current and previous fields differ while evolving under a fixed actor and
  camera, and the actual motion target records that deformation. Pausing
  converges history; reset seeds both outputs without cross-generation motion.
  Moving patch boundaries select current and previous mapping independently.
- River source and sink toggles change actual height/velocity pixels. Bake
  publishes only after a completed GPU copy and validation. Interior, exact
  sample-boundary and outside `WaterSystem.queryBody` results show source,
  height, depth and velocity before and after publication.
- Rebake retains stable source keys/GUIDs and changes the content identity.
  Failed replacement retains the accepted query source. A cold page reload
  restores the durable Pack snapshot, loads its ordinary recipe and paired
  grid/solver-normal textures, then republishes the query grid for the current
  Body generation. The `/2` normal is the direct solver output in the Bake
  lattice; `/1` remains readable but cannot authorize cold admission.
- FFT first request allocates 1x1, requests the authored power-of-two size,
  initializes, computes spectrum and both butterfly axes, and changes the
  water's actual sampled normal. Pause retains pixels; reset repeats the
  allocation sequence. The operation trace carries completion receipts.
- Enable the optional Ocean mesh once and inspect actual GPU buffer sizes,
  `(N+1)^2` vertices, boundary positions/UVs and the first/last cell triangles.
  Disable/rebuild the patch and change device generation to inspect retention
  and retirement through the existing RHI Debug buffer path.

Use `window.__waterR7` for state, operation receipts, query samples and completed
stage readbacks. Capture Tape through the existing RHI debug plugin. Store raw
evidence outside this checkout; never add a reports directory.

The floating settings panel groups interaction, observation and quality by
visible purpose; full Engine parameters are an explicit advanced inspector.
Shared navigation uses WASD/arrows, drag look, E/Q or Space/Page keys, Shift and
wheel travel speed without pointer capture or pointer lock. Panel focus releases
acquired input. Four quality choices edit the accepted Water source configuration.
