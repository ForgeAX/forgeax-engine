# Rendering response: Three.js r184 and Forgeax

Open `rendering-response.html` for the comparison pages. These compare rendering
with fixed geometry, camera, light and texture inputs. Native Skylight continues
to own both diffuse environment lighting and reflections. API compatibility and
the Physical material family are separate work.

| Area | Previous difference | Current rendering contract | Deliberate difference |
|---|---|---|---|
| Environment reflections | Independently filtered cube mips and a linear roughness mapping | Image Skylights, local probes and Atmosphere share r184 WebGPU CubeUV, progressive 512-sample GGX convolution, face borders and nonlinear roughness levels | Existing BRDF providers remain; this change does not unify the BRDF LUT |
| Point / Spot shadows | Point ignored filter width; Spot used a slope-dependent bias and square PCF grid | Width 3 uses five Vogel samples at radius 1 with fragment-pixel rotation; width 5 doubles radius; Spot offsets its receiver before projection and uses normalized depth bias | Point retains its world/texel bias units; width 1 uses hardware bilinear comparison, whereas Three Basic uses nearest comparison |
| Directional contact | Wide filter depth bias could skip a five-centimeter blocker | Integer PCF covers the actual bilinear phase; PCSS corrects each texel-center receiver and blocker depth on its local plane | Grazing receivers retain the bounded bias fallback; local planes approximate curved surfaces |
| Shadow caster side | Single-sided color and generated shadow passes rendered the same faces, leaving visible self-shadow stripes | Generated Standard/Unlit casters reverse single-sided culling, matching Three's non-VSM default; double-sided and custom shadow passes retain their authored policy | Directional receiver-plane correction and geometric normals remain |
| Transparency / Fog / targets | Raw camera targets omitted transparent draws and standalone opaque Fog; distance sorting reused the display camera | Opaque then sorted transparent target draws, capture-local distance sorting, per-depth Fog, linear HDR target values | Three's default direct material output differs from the explicit HDR composition reference used here |
| GTAO | Quantized normals could darken an unobstructed slope at default zero bias | Normal-plane admission includes the bounded 12-bit octahedral normal uncertainty; default author parameters and the analytic integral stay unchanged | Forgeax retains its 5×5 bilateral filter; Three WebGPU GTAONode is raw unless DenoiseNode is explicitly connected |
| SSR / temporal | Full-sized resources still used half-sized dispatch and receiver coordinates | Trace, temporal resolve and composition share every internal scene pixel; rough reflections retain confidence-weighted mips | TAA/TAAU retain independent history, clipping and disocclusion policy; display history stays at output size and uses Catmull-Rom reconstruction to limit repeated motion blur; both TAA and TAAU restart local sample accumulation after motion stops |

## Reproduce

Build the engine, then start this app with the existing shared shader manifest:

```bash
FORGEAX_SHARED_APP_INPUTS_MANIFEST=$PWD/shared-build-inputs/manifest.json \
  pnpm --filter @forgeax/parity-color-lighting dev --host 127.0.0.1 --port 4282
node apps/parity/color-lighting/scripts/verify-shadow-response.mjs \
  'http://127.0.0.1:4282/shadow-response.html?capture' artifacts/rendering-parity/shadows --capture
node apps/parity/color-lighting/scripts/verify-transparency-response.mjs \
  'http://127.0.0.1:4282/transparency-response.html?capture' artifacts/rendering-parity/transparency --capture
node apps/parity/color-lighting/scripts/verify-gtao-response.mjs \
  http://127.0.0.1:4282/gtao-response.html artifacts/rendering-parity/gtao
```

`--record` on the shadow/transparency scripts saves pre-fix evidence without
asserting the final comparison bounds. Ordinary runs enforce those bounds.
Screenshots complement numeric readbacks; only the engine's recorded paths
produce RHI tapes. The standalone GTAO kernel page uses native WebGPU and is not
an engine frame capture.

The environment page retains the [material-grid measurements](ENVIRONMENT_RESPONSE.md).
The SSR [example](../../hello/ssr/README.md) supplies real motion, recovery,
reflection-probe and Atmosphere journeys. The portal accepts an `ssr` query
parameter naming that example's preview URL.

## Measured results

These are fixed-fixture error measurements, not a whole-engine similarity score.

| Measurement | Result |
|---|---|
| HDR environment, nine material/roughness spheres, 0° and 90° | Worst material spatial relative error decreases from approximately 20% to 7% |
| Point/Spot shadow visibility, 24 cases | Filtered wall MAE at most 0.0000368; caster-interior MAE at most 0.00000182 |
| Directional contact, 12 browser cases across three camera positions each | PCF1/3/5 and PCSS keep centimeter / column shadows attached and unobstructed ground lit at the original thresholds |
| Two transparent HDR layers, 32 combinations | Linear target error is zero; final tone/OETF error stays within one 8-bit step |
| Actual camera targets, including reverse-camera sorting | Eight combinations pass |
| GTAO open plane, slope and distant edge | Raw output agrees; contact-edge raw MAE is 0.000685 and filtered MAE is 0.003884 |
| GTAO lighting composition | Default direct-light error is zero; mixed-light decomposition error is at most 0.000366 |
| TAAU translating detail at frame 60, against an independent 4×4 spatial reference | Scale 0.5 error decreases from 0.1263 to 0.0919; scale 0.75 from 0.1137 to 0.0659 |

The shared CubeUV binding also covers SingleLayerMedium's sky reflection. Water
uses the same roughness and Skylight rotation while retaining its medium Fresnel
and transmission calculation.

## What the measurements isolate

- Shadow-on / shadow-off ratios isolate visibility from BRDF differences.
  Wall and caster-interior regions are measured separately; the silhouette is
  excluded from both. Camera motion moves the regions with the geometry.
- Transparency uses two HDR layers, both blend conventions, Fog on/off, opaque
  and transparent clear alpha, linear and Reinhard output, and both native paths.
  Three explicitly blends into a linear floating target before output conversion.
  The target comparison happens before tone mapping. An independent tone/OETF
  calculation checks the final native output.
- GTAO receives the same depth and quantized normals. Open plane, open slope,
  contact edge and distant edge are compared before and after spatial filtering.
  Zero intensity must remain identity. The engine regression also renders actual
  geometry, captures its AO work, and compares ambient-only, direct-only and mixed
  lighting. Default AO weights the environment once; explicit direct-light
  occlusion is tested separately. The engine's current AO path requires Deferred.
- SSR's full-resolution gate uses the production graph and a real RHI recorder.
  It rejects missing lower rows. Receiver coverage, camera movement, roughness
  mips, hit reactivity and temporal history remain separate regression gates.
  Temporal motion quality is compared against independently integrated spatial
  references, not merely a small frame-to-frame change.

Software Vulkan and browser SwiftShader results establish correctness; they are
not measurements of hardware frame time.
