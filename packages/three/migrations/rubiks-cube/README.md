# GitHub Rubik migration

Source: [HichemTab-tech/RubiksCube-threejs](https://github.com/HichemTab-tech/RubiksCube-threejs/tree/9c46b0394ea4081e663cae1307c64990e0143e52),
commit `9c46b0394ea4081e663cae1307c64990e0143e52`, MIT, copyright HichemTech.
It is a complete interactive application with 27 cubies, grouped six-face
Lambert materials, CanvasTextures, ambient/directional lights, OrbitControls,
ray picking, face rotation and solving logic. Its declared Three dependency is
`^0.160.0`; the independent reference here pins the compatibility target r184.

The build script verifies the upstream revision and unchanged tracked files.
It changes the root import to `@forgeax/engine/three` and the OrbitControls barrel
import to the explicit supported addon entry. The third-party `three.interaction`
package resolves the same constructor family. Game logic and material values
remain unchanged; no ambient light or texture is removed to make the scene run.

The host copies existing CDN dependencies locally and waits for the same webfont
before importing either application. Without that shared precondition the two
bundle sizes can cause Canvas text to be painted with different fonts. A separate
diagnostics panel observes completed frames and saves actual frame bytes and,
on Forgeax, the ordinary RHI tape and source UUID/entity mapping. The reference
renderer is only the independent oracle and is absent from the Forgeax bundle.

## Reproduce

Run from the engine repository after `pnpm build:engine`:

```sh
git clone https://github.com/HichemTab-tech/RubiksCube-threejs.git artifacts/three-compat/github/rubiks-cube
git -C artifacts/three-compat/github/rubiks-cube checkout 9c46b0394ea4081e663cae1307c64990e0143e52
npm --prefix artifacts/three-compat/github/rubiks-cube ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node packages/three/migrations/rubiks-cube/build.mjs artifacts/three-compat/github/rubiks-cube artifacts/three-compat/github/reference reference
FORGEAX_SHARED_APP_INPUTS_MANIFEST=shared-build-inputs/manifest.json node packages/three/migrations/rubiks-cube/build.mjs artifacts/three-compat/github/rubiks-cube artifacts/three-compat/github/forgeax forgeax
```

Serve the Forgeax build at a server root; its default shader manifest is rooted
there. In two terminals:

```sh
python3 -m http.server 5193 --bind 127.0.0.1 --directory artifacts/three-compat/github/forgeax
python3 -m http.server 5192 --bind 127.0.0.1 --directory artifacts/three-compat/github
```

Then run the real browser migration gate:

```sh
CI=1 pnpm ci:graphics --probe browser -- node packages/three/migrations/rubiks-cube/verify.mjs
```

The verifier accepts optional native URL, reference URL and artifact-directory
arguments. It requires 60 completed native frames, button turns and inverse
restoration, real scene picking and picked mouse down/move/up events. Four fixed scene states
compare canvas pixels with the independent reference at MAE <= 0.05 and at most
3% of channels outside epsilon 0.05; foreground MAE must also stay <= 0.05.
The saved native tape must contain actual geometry work and at least 189 mapped
mesh sources. Failures retain their JSON, PNG and binary evidence and return a
nonzero exit code. The pinned source classifies every cubie as `F1` before assigning its colors;
its drag handler therefore cancels face turns on both renderers. The failed
initial mouse-turn gate is retained as diagnostic evidence. The verifier checks
that the same picked events reach the original handler and reports this inherited
limitation; it does not patch the game's logic. The project's full solver and every input sequence are not
exhaustively tested by this gate.

This sample does not establish complete r184 compatibility. See
the package-wide contract for all remaining obligations.

## Measured result

The migrated application and reference each completed over 240 frames in the
verification run. All four states passed; maximum whole-image MAE was
0.00006465 and maximum foreground MAE was 0.001338. The captured native frame
contained 325 GPU work items, 740 resources and 230 source-object mappings.
These are correctness observations from software WebGPU, not performance claims.
