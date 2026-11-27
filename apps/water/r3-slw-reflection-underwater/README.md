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
