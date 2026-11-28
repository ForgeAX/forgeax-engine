# Water R3: Reflection And Underwater

Run `pnpm dev --port 5381` in this directory and open <http://127.0.0.1:5381/>.
The Chinese control panel owns scene presets, water selection and material operations.
The header icon hides or restores the complete panel in one action.

Open `?pipeline=forward&view=surface&aa=none` for the Forward reflection
comparison. The screen-space reflection control toggles the scene's SSR.
Use `ssr=off` for the same starting view with only environment reflection.
The camera can start with `aa=taa`, `aa=tsr`, or `aa=msaa` on Forward.
The default renderer for this demo is Deferred.

Focus the canvas to move with <kbd>W</kbd>, <kbd>A</kbd>, <kbd>S</kbd>, <kbd>D</kbd>;
<kbd>Q</kbd>/<kbd>E</kbd> move vertically and <kbd>Shift</kbd> increases speed.
Drag with the left or right mouse button to look around; arrow keys also move.
Space/PageUp and PageDown move vertically; the wheel adjusts travel speed and
Escape releases canvas focus. Panel focus and window blur release acquired input.

The browser App owns input snapshots and the frame loop. Navigation acquires no
pointer lock or pointer capture. Presets,
height changes and manual controls write the same camera pose. Interaction listeners
and the camera system retire through the App plugin lifecycle.

For frame diagnostics, call `window.__waterR3.setManualCameraEnabled(false)` before
`setCameraPose({ eye: [0, 2, 10], target: [0, 0, 0] }).unwrap()`. The setter returns
a structured failure for nonfinite or vertical poses. `readState()` reports
`cameraPose` and `manualCameraEnabled`; re-enable manual input explicitly afterward.
Use the existing World time policy separately when a capture also needs frozen time.

Controls are grouped by scene, camera, water appearance, quality and advanced
selection. Material asset operations and channel values are nested under advanced
appearance. Four quality presets edit the existing WaterZone, Camera and SSR
owners. The full Engine object inspector mounts only when explicitly expanded.

The **焦散观测** scene has Off, Texture and Dynamic modes, with independent
scale, line width, softness, visible-distance and underwater-depth controls.
`?scenario=caustics&caustics=dynamic&aa=none` opens its dynamic mode. Only its own
Body selects the short-ripple WaveSet. Off and leaving restore `waves/basin`,
the original DirectionalLight direction/intensity/shadow selection and Water
materials. No replacement receiver slab is added.

Dynamic production reads the accepted fixed Gerstner inputs through
`waterGerstnerSurfaceBindings`, refracts a 192-square source grid toward the
explicit reference plane y = -4.5 m and adds triangles into a 512-square field.
Each source contribution is bounded to six; additive overlap may exceed six.
The receiving sample clamps relative concentration to six and subtracts the
flat reference of one, so the neutral field contributes exactly zero. The
appearance gain defaults to 0.70. The demo explicitly selects these values through the Water caustics entry.

Texture mode copies a TextureGenerator-authored continuous, warped cellular
light network into the same graph field. R3 supplies its own receiving shader
with bounded counterflows and local pulses instead of uniform scrolling.
The demo reads only the selected Body's admitted public WaveSet dependency and
uses `cookGerstnerWaveSet` to derive an amplitude-squared weighted angular
frequency. Its animation phase is that frequency times the same World
`Time.elapsed` used by scene-clock Water waves. The R3 shader's scalar clock slot
carries this phase; current and previous submitted phases use the same mapping.
World time scaling and freezing therefore affect waves and texture motion
together. Frequency ratios, displacement size and pulse contrast remain artistic
policy, not a pointwise optical reconstruction. No private Water buffers or
Engine policy additions are involved. Neither route imports UE assets.

Water's reusable receiver feature uses the generic `before-medium` placement, after
opaque lighting and before Single Layer Water and transparency. It reads the
exact current-view Deferred GBuffer normal and depth, reconstructs receiver
positions and composites only local concentration over the original scene
color. R3 uses the actual scene sun hue and a local concentration response,
with a soft limit on amplification of existing highlights. Zero concentration
and blocked sunlight add exactly no color. The receiver still uses already
shaded scene color as a material-response proxy: it cannot separate albedo,
diffuse irradiance and specular light, and does not independently evaluate a
receiver BRDF. The 1.75 response calibration is demo presentation policy, not a
physical light-energy claim. Existing water absorption and scattering then
transport that added radiance, so submerged highlights can become cyan or
blue-green rather than retaining the sunlight's surface hue. Canonical Terrain
sections and submerged spheres keep their original materials. The concentration field is projected along one flat-interface
refracted sun direction onto these visible receiver positions; this is a
single-reference-plane approximation, not an arbitrary-depth optical solver.

When temporal AA is active, the receiver draw writes a second MRT output into
the optional `temporal-reactivity` alias. Its alpha-only maximum preserves
geometry motion/depth and existing responsiveness. Only the changing light's bounded local contribution becomes responsive;
previous submitted texture taps cover vacated highlights. Frozen inputs preserve
ordinary temporal accumulation on the original geometry. Without temporal AA, the same
feature uses its single-color entry and no second attachment.

Both modes read the actual scene DirectionalLight direction and intensity.
The controls edit that light itself. Receiver shading calls the Engine's current
CSM visibility, including geometric occluders. A zero-intensity or below-horizon
sun removes the contribution. Ordinary straight-sun CSM visibility is reused;
refracted-path occlusion, offscreen receivers and multiple scattering are outside
this demo. Existing Water/underwater media transport the composed receiver color.
Source readiness follows Water's matching mesh-owner roster; waiting or disabled
production clears a zero field without blocking native Water admission.

The shared producer/receiver and caustics shaders are owned by `@forgeax/engine/water/caustics`. This app selects its scene, light, budgets and cooked material values.
