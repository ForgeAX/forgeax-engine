# apps/hello/gltf

> feat-20260515-gltf-loader-via-asset-system M5 convergence app — end-to-end proof of the gltf importer pipeline landing inside the same `assets.load(guid, 'scene')` + `assets.instantiate` spine `apps/hello/room` uses (charter P4 consistent abstraction; plan-strategy section 3.2 sequence B).

## Quickstart

```bash
pnpm install
pnpm --filter @forgeax/hello-gltf dev    # http://localhost:5173
pnpm --filter @forgeax/hello-gltf build
pnpm --filter @forgeax/hello-gltf smoke  # dawn-node 60 frames + pixel readback (epsilon = 0.05)
```

## Runtime recipe

[src/main.ts](src/main.ts) configures the app's Catalog source, selects the scene GUID from the imported Pack, and loads the complete scene closure:

```ts
configureRuntimeAssetCatalog(assets, runtimeBinding);
const scene = (await assets.load(assets.parseGuid(sceneEntry.guid), 'scene')).unwrap();
const instance = assets.instantiate(scene, world).unwrap();
app.start();
```

The scene load resolves its Mesh and Material dependencies. Returned handles belong to the app's asset owner; spawning does not require another registration step. GUID identity comes from `assets/box.gltf.meta.json`. Production code handles the returned `Result` errors before using a handle.

## Tier-B fork fixture (`assets/box.gltf`)

`box.gltf` is a Tier-B subset fork of the official Khronos `BoxTextured.gltf` sample: single mesh with `POSITION` + `INDICES` only (no `NORMAL`, no `TEXCOORD_0`, no `KHR_*` extensions), one `UnlitMaterial` carrying a `baseColorFactor` scalar (no textures), and one perspective `Camera`. The buffer is embedded as a base64 `data:` URI so the fixture is self-contained — `parseGltf`'s `externalLoader` is never invoked. The 24-vertex layout (4 vertices per face × 6 faces) preserves the original BoxTextured topology so future texture / NORMAL upgrades (`feat-future-gltf-textures`, OOS-1) only need to add accessors to the same buffer.

## Smoke gate (AC-14)

`pnpm --filter @forgeax/hello-gltf smoke` runs the dawn-node headless path: 60 frames + pixel readback with `epsilon <= 0.05` distance from the clear color (0.05, 0.05, 0.08). Three criteria: (a) `backend = webgpu` (b) frames >= 60 (c) at least one meshed sample site exceeds the threshold (charter P3 + P4 verified by a single mesh rendering above clear color).

The literal `pnpm --filter @forgeax/hello-gltf smoke` is the SSOT smoke command anchor; it appears byte-for-byte in `apps/hello/gltf/package.json#forgeax.smokeInvocation`, `.github/workflows/ci.yml`, and AGENTS.md `Smoke gate`.

## v1 scope vs future

Out-of-scope for this closed loop, with upgrade anchors (see `requirements.md` OOS-1 .. OOS-15):

- `NORMAL` / `TEXCOORD_0` / textures / samplers / images — `feat-future-gltf-textures`.
- PBR 5 fields (metallic / roughness / occlusionTexture / emissiveFactor / alphaMode) — `feat-future-gltf-pbr-material-fields`.
- Multi-primitive meshes — `feat-future-gltf-mesh-multi-section`.
- This Tier-B fixture intentionally has no `KHR_*` declarations; the package
  importer supports the current extension surface documented in
  `packages/gltf/README.md`.
- Camera ortho — `feat-future-gltf-camera-ortho`.
- Skin / morph / animation — `feat-future-gltf-skin` / `feat-future-gltf-morph` / `feat-future-gltf-animation`.
- gltf build-time cook (gltf -> .pack.json + dead-code-elim) — `feat-future-gltf-buildtime-cook`.
- Strict per-pixel `baseline.png` lock — `feat-future-pixel-parity-hello-gltf`.
