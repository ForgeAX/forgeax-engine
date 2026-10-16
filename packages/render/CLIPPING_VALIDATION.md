# Public clipping validation

The public contract follows [Three.js Material clipping](https://threejs.org/docs/pages/Material.html#clippingPlanes): world-space signed planes discard their negative half-space; intersection mode and shadow clipping are explicit. ForgeaX accepts six planes per camera group and six per material group. The two groups compose independently.

## Reproducible GPU journey

`packages/runtime/src/__tests__/clipping-planes.fixture.ts` owns the production renderer journey through Dawn. The redundant Browser wrapper was removed during CI consolidation; browser transport and Standard assembly remain covered by their dedicated fixtures. Material cases use real Pack cooking, HTTP publication, GUID loading and the published shader ABI. Each captured frame is replayed on a fresh device, with color and depth read back at the selected geometry work and shadow depth read back at shadow works.

| Case | Visible coverage | Shadow coverage |
|:--|:--|:--|
| Baseline | Full object | Full object |
| Union, six planes with repeated half-spaces | Upper-right quarter | One quarter |
| Intersection, six planes with repeated half-spaces | Three quarters | Three quarters |
| One plane, shadows disabled | Right half | Full object |
| Empty planes after clipping | Full object restored | Full object restored |

The fixture checks four interior color/depth samples, shadow pixel area within 0.05 of the expected ratio, live-versus-replay HDR error at most 0.005, and WebGPU validation errors. Union asserts direct drawing; intersection and subsequent cases assert indirect drawing selected by automatic submission. Reports retain the actual draw kind, work/event indices, bindings, capture digests and unseeded-resource declarations instead of assuming a submission lane.

## Evidence that selected the repairs

| RHI Debug observation | Owning repair |
|:--|:--|
| Opaque shadow pipeline had no fragment stage | Preserve the authored fragment stage so shadow clipping executes. |
| Camera clipping was present in ECS but View buffer tail was zero | Carry the companion through the production camera extraction path. |
| Loaded clipped material used the built-in shader without local clipping | Route the extended material ABI through the existing material cooker. |
| Cooked shader read compact parameters while bound bytes used the canonical Standard layout | Select the parameter ABI from the selected program identity in both extraction paths. |
| CSM capture correctly bound 1136 bytes while its smoke contract still expected 1024 | Derive the consumer payload from public `VIEW_ABI` and check buffer slots at the aligned stride. |
| Published custom-shader fixture still embedded the previous View struct | Regenerate the same GUIDs with `recook-material-pack.mjs --write`; retain exact published-program byte equality and 60-frame Dawn verification. |

The shared View payload is 1136 bytes with a 1280-byte aligned slot. The material allocation admits the 848-byte canonical Standard payload plus 112 bytes for clipping, with a 1024-byte aligned slot. A regression checks the final plane at the end of the full physical material payload. Auxiliary view uploads do not overwrite point-shadow slots.

## Commands and artifacts

```sh
pnpm exec tsc -b packages/render/tsconfig.json packages/shader-compiler/tsconfig.json
FORGEAX_SHARED_APP_INPUTS_MANIFEST=shared-build-inputs/manifest.json pnpm exec vitest run --project dawn packages/runtime/src/__tests__/clipping-planes.dawn.test.ts --retry 0
pnpm test:dawn
pnpm test:browser
pnpm ci:focus --kind smoke --select all --frames 60
```

GPU artifacts are generated under `artifacts/clipping-planes/rhi-debug/dawn/{view,material}/`: each case has a `.rhitape`, color/depth readback and a shared `report.json`. The original opaque-shadow failure is preserved under `rhi-debug/failure/`. Generated evidence is separate from the permanent regression fixtures.

## Boundaries

Clipping does not construct caps or alter CPU bounds/picking. Expanded Points/Lines admit camera clipping and reject unsupported local clipping. Custom shaders/features opt into the common clipping module. Planar reflection now copies the display camera's public clipping planes into a detached capture snapshot with `clipShadows: false`; its own oblique near plane remains with the reflection owner. Future refraction captures can use the same `CameraSnapshot.clipping` contract. Existing cube/probe captures clear inherited display clipping. Captures reuse the display camera's shadow maps; capture-specific view planes do not regenerate those maps.

## Integration regression

The full CI runtime metrics journey also exposed a pre-existing query-set
snapshot error during the LOD baseline-to-treatment transition. The permanent
RenderGraph regression first failed, then passed with explicit frame resolution
of query sets. The real benchmark passed all six falsifiers and retained 128
samples after the owner repair. This does not change clipping coverage or reduce
any smoke, pixel or performance threshold.
