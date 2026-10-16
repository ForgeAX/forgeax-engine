# apps/hello/room

> feat-20260511-asset-system-v1 / M7 convergence app — end-to-end proof of the asset-system-v1 surface (Handle brand + AssetRegistry + hierarchy + merged single MeshRenderer + Three.js-aligned shading dispatch via MaterialAsset.shadingModel).

## Quickstart

```bash
pnpm install
pnpm --filter @forgeax/hello-room dev    # http://localhost:5173
pnpm --filter @forgeax/hello-room build
pnpm --filter @forgeax/hello-room smoke  # dawn-node 60 frame + multi-mesh readback
```

## Scene

Three meshed entities sharing the builtin `HANDLE_CUBE` mesh asset (M2 GPU upload only pre-populates `HANDLE_CUBE` + `HANDLE_TRIANGLE`; custom procedural upload is deferred to `feat-future-asset-system-v2`):

- Root Cube — `Transform` + `MeshFilter(HANDLE_CUBE)` + `MeshRenderer { material: <standard handle> }` (PBR orange)
- Sphere child — same + `ChildOf -> root` + `MeshRenderer { material: <unlit handle> }` (flat blue)
- Plane child — same + `ChildOf -> root` + `MeshRenderer { material: <standard handle> }` (PBR green)

Plus one `Camera` + one `DirectionalLight`. Visual distinction between the three meshed entities is carried by `Transform` (scale + translation) + the bound `MaterialAsset.baseColor` (resolved through the `MeshRenderer.material` handle) — the shape is cube in all three cases for v1 convergence (requirements AC-05 permissive gate; AC-25 human-locked tolerance).

## Smoke gate (AC-05 / AC-25)

`pnpm --filter @forgeax/hello-room smoke` runs the dawn-node headless path: 60 frames + 5-site pixel readback + per-site distance to clear color. Four criteria: (a) backend=webgpu (b) frames >= 60 (c) at least one meshed site exceeds `SMOKE_PIXEL_THRESHOLD` (default 0.05) distance from the clear color (0.05, 0.05, 0.08) (d) `Renderer.onError` fire count = 0.

Output log literals are preserved byte-for-byte with `apps/hello/cube/scripts/smoke-dawn.mjs` for grep-based tooling reuse:
- `[hello-room] backend=webgpu`
- `[smoke] frames observed=<N>`
- `[smoke] pixelSamples=<json>`

The literal `pnpm --filter @forgeax/hello-room smoke` is the SSOT smoke command anchor; it also appears byte-for-byte in `apps/hello/room/package.json#forgeax.smokeInvocation`, `.github/workflows/ci.yml`, the forgeax-step-verify SKILL doc, and AGENTS.md §Smoke gate (charter proposition 5 consistent abstraction; architecture principle §1 SSOT).

## Asset surface details

See [`packages/engine-runtime/README.md`](../../packages/engine-runtime/README.md) §Transforms / §Hierarchy / §Assets / §Materials / §Geometry for the full surface docs + progressive disclosure quickstarts.

## v1 scope vs v2

Out-of-scope for this closed loop, with upgrade anchors:
- Texture asset loading in the scene (the `public/textures/wall.png` fixture is reserved for v2; v1 demo ships with solid baseColor only) — `feat-future-asset-hot-reload`.
- Strict per-pixel baseline lock (`baseline.png` pixel-parity) — `feat-future-pixel-parity-hello-room`.
- Shader variants + MaterialAsset runtime edit — `feat-future-shader-variant`.
- Custom procedural mesh upload (Sphere / Plane factory handles wired to GPU buffers) — `feat-future-asset-system-v2`.
