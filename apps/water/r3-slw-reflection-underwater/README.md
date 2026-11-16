# Water R3: Reflection And Underwater

Run `pnpm dev --port 5381` in this directory and open <http://127.0.0.1:5381/>.
The Chinese control panel owns scene presets, water selection and material operations.
The header icon hides or restores the complete panel in one action.

The demo selects independent Water SSR temporal resolution alongside main TAA.
The rendering panel exposes Always, Auto and Off without changing Engine defaults.

Focus the canvas to move with <kbd>W</kbd>, <kbd>A</kbd>, <kbd>S</kbd>, <kbd>D</kbd>;
<kbd>Q</kbd>/<kbd>E</kbd> move vertically and <kbd>Shift</kbd> increases speed.
Drag with the left or right mouse button, or one touch, to look around; arrow keys
also rotate the camera. Panel focus and window blur release acquired input.

The browser App owns input snapshots, pointer capture and the frame loop. Presets,
height changes and manual controls write the same camera pose. Interaction listeners
and the camera system retire through the App plugin lifecycle.

For frame diagnostics, call `window.__waterR3.setManualCameraEnabled(false)` before
`setCameraPose({ eye: [0, 2, 10], target: [0, 0, 0] }).unwrap()`. The setter returns
a structured failure for nonfinite or vertical poses. `readState()` reports
`cameraPose` and `manualCameraEnabled`; re-enable manual input explicitly afterward.
Use the existing World time policy separately when a capture also needs frozen time.
