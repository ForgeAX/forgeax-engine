# ForgeaX Engine Capability Catalog

> [!IMPORTANT]
> Generation baseline commit: `11d914eddf3c0c6db8ce64fd48dd39638addc02e`. This public capability snapshot was reviewed and updated against changes from `787eac1a35f9e1948b6543798c1dad06e10a3565` to that commit.
> The earlier audit baseline `f1a7ad38e402379c6a58ad492aadf11395b83653` is historical provenance, not current product HEAD. Recheck against the caller's exact Engine commit, current owner, README/exports, and matching real gate receipts.

This catalog describes Engine capabilities and boundaries, not a game's enabled features. A package in the lockfile or SDK establishes availability, not registration of its components, pipelines, plugins, or assets in the game.

Include only capabilities with a public owner, README/exports, and real gates. Structural smokes, debug backends, and teaching examples alone do not prove real GPU or product paths.

## Reading conventions

| Form | Meaning |
|:--|:--|
| **Built-in** | Directly provided by the public runtime/core packages; data and platform constraints may still apply. |
| **Opt-in** | Requires explicit configuration, feature/pipeline/plugin installation, or capability admission. |
| **Build-time** | Runs during import, cooking, compilation, packaging, or offline validation, outside the player runtime. |
| **Host-side** | Owned by browser/Node/desktop Host; does not cross into ECS World, Engine Worker, or Kernel Worker. |
| **Development** | Debugging, inspection, evidence, or dev-server capability; disabled by default in production or tree-shaken. |
| **Test/experimental** | Proves structure, determinism, or exploratory results, not real GPU/product readiness. |

## Navigation

| Category | Contents |
|:--|:--|
| [Rendering pipelines and effects](#rendering-pipelines-and-effects) | Renderer, Standard, RenderGraph, lighting, shadows, post-processing, environment. |
| [Materials, shaders, and geometry](#materials-shaders-and-geometry) | MaterialAsset, WGSL, geometry layouts, scenes, animation, 2D, media. |
| [GPU, RHI, and VFX](#gpu-rhi-and-vfx) | RHI backends, GPU-driven rendering, frame graphs, GPU particles. |
| [Core architecture and ECS](#core-architecture-and-ecs) | Types, math, World, queries, relationships, schedules, state machines. |
| [App, input, and plugins](#app-input-and-plugins) | Host frame loop, execution tiers, multiple Worlds, input, Cordis/DSH. |
| [Physics, audio, networking, and intelligence](#physics-audio-networking-and-intelligence) | Rapier, Web Audio, replication, Activity, NPCs. |
| [Assets and content production](#assets-and-content-production) | GUIDs, Pack, Importer, DDC, Catalog, format import, runtime loading. |
| [AI tools, inspection, and delivery](#ai-tools-inspection-and-delivery) | CLI, Preview, Profiler, Remote, RHI Debug, SDK. |
| [Not currently counted as delivered](#not-currently-counted-as-delivered) | Candidates without a real owner or with only partial projections. |

---

## Rendering pipelines and effects

### Rendering core

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Renderer extract/prepare/record | **Built-in** | Extracts rendering facts from ECS World, prepares persistent resources, and records GPU commands. `runtime` only assembles concrete services without duplicating rendering ownership. | `render` · `runtime` |
| `createRenderer` assembly | **Built-in** | Selects RHI/backend, creates AssetRegistry and Renderer, and owns `ready/draw/dispose`; excludes asset authoring and game scheduling. | `runtime` |
| Standard render pipeline | **Built-in** | `forgeax::standard` is the public Renderer facade's product pipeline. Its stage order is scene → transparent-blend → bloom → output-transform (tone/LUT) → fxaa → post-effect → present; it is the only pipeline directly installable through the current facade. | `render` |
| Standard Deferred lighting | **Opt-in** | An admitted Deferred profile evaluates each opaque Standard Surface once into compact SceneColor/G-buffer attachments, then resolves direct lights, IBL, probes, AO, and SSR fallback in the same graph. Unsupported attachment/storage capabilities select the explicit Forward lane. | `render` · `shader` · `rhi` |
| URP/HDRP parity asset configuration | **Test/experimental** | `forgeax::urp` and `forgeax::hdrp` remain only in parity/config fixtures and comparison tests. The public facade does not register these IDs for game startup. | `render` · `runtime` |
| Typed RenderGraph | **Built-in** | Declares typed resources, access, and passes, then compiles an immutable execution graph; excludes ECS, material, and pipeline product policy. | `render-graph` |
| RenderGraph dependencies and barriers | **Built-in** | Derives order and barriers from RAW/WAR/WAW access, lifetimes, and backend kind; features do not create separate resource ledgers. | `render-graph` |
| RenderGraph last-known-good | **Built-in** | Renderer retains an executable LKG when graph compilation fails and preserves one encoder/finish/submit transaction on successful frames. LKG/recovery is outside the generic RenderGraph package. | `render` |
| RenderFeature injection | **Opt-in** | Producers join the same graph through extract/prepare/contribute; the active RenderPipeline projects logical targets. App only forwards features. | `render` |
| RenderFeature submission receipt | **Development** | Optional `onFrameSubmitted` reports compute/draw passes admitted after prepared-resource resolution. It proves command admission, not GPU readback or nonzero indirect-draw instances. | `render` |
| Frame-varying occlusion query sets | **Built-in** | Raster passes may resolve a fixed query set or a frame callback once before execution, so rotating query pages do not rebuild graph topology or attachment resources. | `render-graph` · `rhi` |
| Custom RenderPipeline | **Opt-in** | Users pass a complete typed pipeline declaring scene, targets, features, and output topology at Renderer construction; there is no runtime pipeline swap and no hidden parallel pipeline. | `render` |
| Custom fullscreen post-processing | **Opt-in** | Compiled WGSL effects can join a pipeline's post stage. Shader compilation remains build-time work, never ad hoc runtime compilation. | `render` · `shader` |
| Unified color-domain contract | **Built-in** | Standard shares linear HDR → linear LDR → display-encoded semantics and `transparent → bloom → tone → lut → fxaa → output` order, with one final encoding owner. | `render` |
| Persistent Render Scene | **Built-in** | Consumes World change evidence to maintain stable scene IDs, dirty ranges, and Transform/Material/Instance tables; full rebuilds still query World. | `render` |
| Multi-World composition | **Built-in** | One Renderer combines renderables/lights from multiple Worlds with explicit camera and singleton-resource owners. | `render` · `app` |
| Multi-camera CameraView composition | **Built-in** | Each Camera with a `CameraView` renders an independently culled view with private depth, post-processing, and temporal history. The Renderer extracts and plans the view roster once, shares asset residency and scoped frame work, and commits all views plus composition in one submission. | `render` · `app` |
| Non-XR stereo output | **Opt-in** | `StereoCamera` expands a perspective Camera into two off-axis eye views (Three.js StereoCamera math) composed side-by-side, top-bottom or as a write-mask anaglyph; each eye keeps its own depth, post-processing and TAA history in the same submission. | `render` |
| Reverse-Z depth | **Built-in** | Every Camera projection is Reverse-Z: near maps to depth 1, far and the depth clear to 0, and scene passes test with `greater`. Custom `renderState.depthCompare` must follow the reversed convention. | `render` · `math` |
| Render bundle reuse | **Built-in** | Compiled scene passes reuse render bundles keyed by physical command identity while the scene is stable; graph/device retirement releases them, and scene churn or dynamic state bypasses the cache explicitly. Output pixels must match the direct-recording path. | `render` · `rhi` |
| Frame observation | **Development** | Collects bounded metadata/readback for the current linear-HDR frame in the same graph, without a second capture renderer. | `render` |
| Semantic scene-data target | **Built-in** | The Standard scene producer publishes the `forgeax::scene-data::temporal-v1` sampled target. TAA/Motion Blur consumers receive opaque tokens rather than creating velocity/G-buffer or graph ledgers. | `render` · `shader` |
| Renderer health and recovery | **Built-in** | Reports structured health, device-lost, internal-fault, and recoverability; Runtime/App initiates actual rebuilds. | `render` · `app` |

### Cameras, visibility, and geometry submission

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Perspective camera | **Built-in** | `Camera` supports FOV, aspect, near/far, and automatic aspect. World/Scene supplies pose; Render consumes resolved transforms. | `render` |
| Orthographic camera | **Built-in** | `Camera` supports orthographic bounds and near/far; picking and rendering share projection semantics. | `render` · `picking` |
| Offscreen RenderTarget | **Opt-in** | Renderer-owned typed targets support 2D/cube, formats, mips, MSAA, depth, material sampling, and one-shot readback. Render owns admission, generation, and recovery. | `render` |
| CubeCamera capture | **Opt-in** | ECS `CubeCamera` produces six capture views with once/on-demand/continuous modes. Candidate results promote only after the matching `FrameReceipt` completes. | `render` |
| ReflectionProbe IBL | **Opt-in** | ECS `ReflectionProbe` drives renderer-owned six-face capture, PMREM, local box projection, and probe selection; unavailable probes fall back to Skylight irradiance. Capture is amortized (one raw face or PMREM step per frame), so a new or re-added probe publishes after roughly 40 frames; wait for `inspect().reflectionProbes.activeCount > 0` before judging receivers. | `render` |
| Planar reflection capture | **Opt-in** | `PlanarReflection` mirrors an auxiliary camera into a sampled 2D RenderTarget with an oblique near plane, bounded cadence, completion-receipt promotion, resize/recovery, and no recursive capture. | `render` · `shader` |
| Public clipping planes | **Opt-in** | Camera `ClippingPlanes` and material `withClipping` admit up to six world-space planes. Color, depth, temporal, instanced/skinned, and optional shadow coverage share the transformed world-position predicate; no section caps or CPU-bounds mutation. | `render` · `shader` · `types` |
| Selection outline | **Opt-in** | Camera `Outline` selects exact entity handles and composites visible/hidden silhouettes from existing scene depth. It preserves material/visibility state, supports ordinary coverage variants, and does zero work when absent, empty, or width-zero. | `render` |
| Hierarchical visibility | **Built-in** | `Visibility` resolves effective state along `ChildOf`; hidden objects are excluded before material preparation. | `scene` · `render` |
| Frustum culling | **Built-in** | Uses MeshAsset AABB and `GlobalTransform.world`; geometry/import producers own bounding-box facts. | `render` · `math` |
| Adjacent LOD coverage blending | **Built-in** | `MeshAsset.lodHysteresis` turns an LOD switch into a screen-coverage band where the two adjacent levels draw complementary dithered coverage; per-view GPU LOD projection kernels keep CPU parity. | `render` · `shader` |
| Layer and sort keys | **Built-in** | Layer/SortKey supplies visible-layer and stable-sort facts; renderer owns transparent sorting. | `render` |
| Transparent material sorting | **Built-in** | Sorts transparent draws by Layer, then world z/camera distance, then stable keys. Blend/depth/cull state comes from MaterialAsset, not ad hoc entity switches. | `render` |
| GPU Instancing | **Built-in** | `Instances` holds batched instance-local transforms for glTF `EXT_mesh_gpu_instancing` and ordinary Engine instancing. Renderer-owned `peek` provides detached observation without advancing upload cursors. `World.setArrayRange` row writes keep per-frame projection, bounds and upload cost proportional to the moved rows. | `render` · `gltf` |
| Multiple submeshes/materials | **Built-in** | A MeshAsset can contain multiple submeshes; `MeshRenderer.materials[]` aligns with `materialSlots` to select materials. | `types` · `render` |
| Mixed primitive topology | **Built-in** | Submeshes can use triangle-list, line-list, and other topologies with their own PSOs; debug lines need no separate mesh system. | `geometry` · `render` |
| Shadow participation | **Built-in** | `ShadowParticipation.cast` and visibility determine caster eligibility; VFX/special producers declare shadow boundaries through their features. | `render` |

### Lighting, shadows, and environment

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Standard PBR | **Built-in** | Metallic/roughness PBR consumes base color, normal, metallic, roughness, emissive, occlusion, and IBL; MaterialAsset owns the parameter contract. | `shader` · `render` |
| Unlit shading | **Built-in** | Consumes material/texture and render state without direct-light or IBL policy. | `shader` · `render` |
| Directional Light | **Built-in** | Uses direction, linear RGB, and lux intensity; supports CSM. Sun automation occurs explicitly within the Atmosphere environment chain. | `render` |
| Point Light | **Built-in** | Uses Transform, candela, metric range, and a squared range window. Public `decay` is a finite nonnegative f32 distance exponent: default `2` is inverse-square, `0` keeps only the range window, and fractional values such as `1.4` are supported. Cube-array shadows are optional. | `render` |
| Spot Light | **Built-in** | Uses Transform, range, inner/outer cones, and candela, with a separate spot-shadow atlas. | `render` |
| IES light profiles | **Opt-in** | `PointLight`, `SpotLight`, and `RectAreaLight` share peak-normalized Type-C IES assets and a 32-layer array in Standard Forward/Deferred. Point/Rect use the Transform frame (+Z polar axis, +X toward +Y azimuth); Rect multiplies its LTC result by the center-direction distribution. IES shapes emission independently of geometry shadows. | `render` · `shader` · `import` |
| Multiple-light PBR | **Built-in** | Extracts bounded direct lights from current Light components. DirectionalLight is a single snapshot; backend/capabilities constrain point/spot capacity. | `render` |
| Standard clustered lighting | **Opt-in** | `forgeax::standard` shares one local-light Cluster path across Forward/Deferred, using `compute-storage` or `cpu-storage` with up to 256 light slots. Missing `storageBuffer` yields structured refusal, not a four-light uniform fallback. | `render` · `rhi` |
| Directional CSM/PCSS | **Built-in** | `DirectionalLight` supports 1–4 cascades, split/blend/bias, and closed `pcfVogel`/`pcf1`/`pcf3`/`pcf5`/`pcssMedium`/`pcssHigh` filters (default five-sample Vogel, three cascades, split lambda 0.5). Cascades stabilize on the shadow-texel grid; receiver bias covers one texel of depth slope and PCF taps compare against the receiver plane, so wider filters add no bias or taps. Render owns inspection, LKG, and capability fallback. `CapsuleShadow` casters are excluded from the cascades, and cascade views participate in the incremental shadow cache. | `render` · `shader` |
| Directional contact shadows | **Opt-in** | `DirectionalLight.contactShadowLength` (meters, default `0`) adds a short screen-space depth march toward the sun inside the Deferred lighting pass. It recovers grass/foliage/foot contact occlusion below cascade resolution with no extra pass or target. Forward ignores it. | `render` · `shader` |
| Point cube shadow | **Opt-in** | PointLightShadow generates a six-face cube-array depth atlas. `PointLight` alone does not allocate shadows. Receivers sample it only with `forgeaxShader({ engineEntries: { pointShadows: true } })`; otherwise `inspect().pointShadow.status` is `unavailable`. | `render` |
| Spot shadow atlas | **Opt-in** | Uses a separate 2D atlas with at most four active tiles in the current product path. | `render` |
| Shadow caster opt-out | **Built-in** | `ShadowParticipation { cast: false }` keeps the entity visible while excluding it from every shadow map. | `types` · `render` |
| Incremental shadow cache | **Built-in** | Shadow views are cached across frames in global static/dynamic layers: a settled static scene re-rasters nothing, and moving one caster invalidates only the views containing it with a closed invalidation reason visible in inspection. | `render` · `shader` |
| Capsule shadows | **Opt-in** | Skinned entities tagged `CapsuleShadow` leave the directional cascades; their posed skeleton capsules are tile-binned per view and evaluated inline by Deferred lighting. glTF/FBX importers derive the capsules. | `render` · `skinning` · `gltf` · `fbx` |
| Baked lighting identity | **Built-in** | `bakeFingerprint` hashes every baked-lighting input (mesh, transform, material, lights, settings, algorithm); `resolveBakeData` keeps only records that still match the live scene and reports one `bake-data-stale` diagnostic per scene. There is no baker yet. | `render` · `types` |
| Custom ShadowCaster pass | **Opt-in** | Materials can supply alpha-test/cutout shadow WGSL. Render executes cooked passes without inferring transparent-texture thresholds. Proved by `pnpm --filter @forgeax/hello-shadow-opt-out smoke`; no Lab module. | `shader` · `render` |
| Skylight IBL | **Opt-in** | Generates diffuse irradiance and prefiltered specular cubemaps from a linear `rgba16float`/`rgba32float` equirect for Standard PBR indirect light; visible HDR results need a non-`none` tonemap. Other formats are refused. | `render` · `image` |
| Cubemap Skybox | **Opt-in** | Projects a linear HDR equirect environment as a visible background (tonemap required). Skybox background and Skylight lighting share resources with distinct semantics. The background appears once the asynchronous projection completes; until then the clear color shows. A failed projection fires `equirect-projection-failed` whose `detail.cause` carries the owning code, such as `invalid-source-format` for an 8-bit source. | `render` |
| Analytic Sky | **Opt-in** | `Atmosphere` plus exactly one DirectionalLight in the World form the sole analytic environment/Sun source for sky background, sun disc, and environment lighting. A missing sun is reported only through the console, not a structured error. | `render` |
| Environment generation/LKG | **Built-in** | Manages Atmosphere/IBL GPU bundles through generation and ready/failed/LKG state, preserving one state source across device rebuilds and TAA inspection. | `render` |
| Scene Fog | **Opt-in** | Zero or one World `Fog` component declares linear fog color, density, height falloff, and maximum opacity. URP/HDRP, transparency, Sprite, Text, Skybox, and VFX producers share one scene-radiance contract before temporal resolve. | `render` · `shader` · `runtime` · `vfx-render` |
| Volumetric Fog | **Opt-in** | `VolumetricFog` uses a GUID-backed 3D `TextureAsset` density through inject → temporal → integrate → composite, supporting directional, point, and spot lights. Standard Forward/Deferred support it with `TONEMAP_NONE`; the default high quality is expensive on software GPUs. Missing real capabilities yield structured refusal and preserve LKG. | `render` · `types` · `image` · `assets-runtime` |
| Fog inspection/LKG | **Built-in** | Renderer publishes accepted Fog revisions only after successful submission. Conflicts/invalid parameters retain previous usable facts and report closed RenderError codes pointing to owner recovery. | `render` |

### Antialiasing and post-processing

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| HDR scene color | **Opt-in** | Standard always renders into the linear-HDR scene target; `TONEMAP_NONE` uses the same graph and clamps at output, while other curves apply exposure in the tone stage. Teaching exposure shaders are not product authorities. | `render` |
| Tone Mapping | **Opt-in** | Camera supports Linear, Reinhard, Reinhard Extended, Cineon, ACES Filmic, AgX, and Neutral curves. | `render` · `shader` |
| Bloom | **Opt-in** | Camera enables five linear-HDR `D0..D4` soft-threshold/13-tap downsample levels, four `U3..U0` tent upsample levels, and HDR composition. Odd extents use coverage-area normalization; disabled or intensity=0 bypasses Bloom writes/composition exactly. | `render` · `shader` |
| Screen-space ambient occlusion | **Opt-in** | Standard Deferred defaults to full-resolution GTAO when enabled, with explicit SSAO and reduced-resolution options with depth/normal-aware filtering. AO modulates ambient and the SSR fallback without touching direct lights or retaining temporal history; unsupported lanes fail closed. | `render` · `shader` |
| Screen-space reflections | **Opt-in** | Standard Deferred admits an SSR spatial/temporal chain only after detached producer, format, and generation receipts agree. Missing or stale evidence is `fallback-only` with zero SSR work; accepted output composes a bounded reflection delta over the existing environment fallback. | `render` · `shader` |
| FXAA | **Opt-in** | Camera-selected fullscreen FXAA runs after tonemapping without allocating TAA history. | `render` · `shader` |
| SMAA 1x | **Opt-in** | `Camera.antialias = ANTIALIAS_SMAA` runs SMAA 1x Medium (edge detection, area weights, neighborhood blend) at output resolution with no history. | `render` |
| Lens effects | **Opt-in** | A `LensEffects` Camera companion adds vignette, radial chromatic aberration, and film grain in one output pass; all intensities at zero schedule no pass. | `render` |
| BarrelDistortion | **Opt-in** | A Camera companion performs bounded radial remapping in output-extent linear LDR, after LUT and before FXAA/encoding. `strength` is `[0,0.35]`, center is `[0,1]`, zero means zero work, and display picking consumes the same submitted-frame mapping. | `render` · `picking` · `app` |
| MSAA | **Opt-in** | Camera-selected MSAA uses 4× scene/depth attachments and a resolve target. WebGL2/downlevel capabilities can refuse or downgrade this lane. | `render` · `rhi` |
| TAA | **Opt-in** | Uses jitter, velocity/depth/reactive coverage, two histories, and one resolve to compose history in the unjittered output domain. | `render` |
| TAAU dynamic resolution | **Opt-in** | Camera companion `DynamicResolution` requires TAA. It scales internal Standard targets from renderer-owned asynchronous GPU timing (fixed scale when timing is unavailable; extents align to 8 px), while TAAU history and output stay at presentation size. No CPU-clock fallback or World mutation. | `render` |
| Camera Depth of Field | **Opt-in** | Standard's built-in thin-lens effect applies only to the active perspective camera. `maxRadiusPixels: 0` or component removal means zero work; near/far/both and quality share CoC. Candidate failure retains LKG and exposes structured inspection state. Uncovered background (reverse-Z depth 0) sits at the far plane, so a defocused far silhouette spreads over the sky. | `render` · `shader` |
| TAA history reset | **Built-in** | `Camera.historyVersion` explicitly owns reset for cuts/discontinuities; ordinary camera motion must not increment it. | `render` |
| TAAU GPU-driven coverage | **Built-in** | With TAAU active, GPU-claimed (LOD) meshes write output-extent temporal coverage through the same culled indirect rows as their color draws instead of a direct fallback. | `render` |
| TAA inspection/recovery | **Built-in** | Renderer exposes bounded temporal inspection, coverage, reset reasons, failures, and recovery. Applications must not retain graph textures in a separate history registry. | `render` |
| Motion Blur | **Opt-in** | `MotionBlur` uses the shared temporal target for one raster pass after TAA and before Bloom. Parameters are bounded, zero shutter means zero work, and it does not write TAA history. | `render` · `shader` |
| HDRP SSAO | **Test/experimental** | Legacy name for AO raw/blur passes in the HDRP parity configuration; product SSAO is the Standard Deferred row above. | `render` · `shader` |
| Auto exposure | **Opt-in** | The Camera-owned exposure union supports GPU histogram metering, bounded EV/rates, fallback/LKG, and submission receipts. Missing capabilities yield structured refusal; fallback is not physical-GPU evidence. | `render` · `shader` |
| 3D LUT color grading | **Opt-in** | Loads LUTs through the ordinary `TextureAsset` Pack/Catalog/GUID path and binds them to Camera, without URL identity or another LUT registry. | `render` · `image` · `assets-runtime` |

---

## Materials, shaders, and geometry

### Materials and shaders

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Single MaterialAsset path | **Built-in** | Materials follow `paramSchema → derive → compile/reflect → cook/load → extract/record`; no layer creates compatibility materials or a runtime compiler. | `types` · `shader` · `pack` · `assets-runtime` · `render` |
| Pass-based MaterialAsset | **Built-in** | MaterialAsset expresses passes, values, render state, parent, and cooked specialization. Shader ID is a constituent fact of a pass. | `types` |
| Material inheritance | **Built-in** | Children inherit/override effective values/passes through a GUID parent chain. Missing/stale parents require producer repair and reload of the same GUID. | `assets-runtime` |
| Material texture transform | **Built-in** | Each texture slot carries coordinate set and transform; Render consumes cooked values without app-side UV patching. | `types` · `render` |
| Material render state | **Built-in** | `MaterialPass.renderState` determines depth compare/write, stencil, blend, cull, and pass tags; MeshAsset submeshes own primitive topology. | `types` · `render` |
| Material color writes and polygon depth offset | **Built-in** | Existing `renderState` exposes per-channel `colorWriteMask` and signed polygon depth bias across Forward, Deferred/MRT, prepared, GPU-driven, and shadow paths; it changes raster state, not CPU geometry or bounds. | `types` · `render` |
| Public material MRT | **Opt-in** | Ordered `MaterialPass.outputs` map WGSL locations to typed attachments with per-output blend/write masks. Naga/cook validates the contract; RenderGraph admits matching formats and limits without a silent multipass substitute. | `types` · `shader-compiler` · `render` · `render-graph` |
| Independent Standard scalar maps | **Opt-in** | Standard accepts independent metallic, roughness, and alpha textures with channel selectors and per-slot UV/sampler policy. Cooked Forward, Deferred, skinned, and ShadowCaster paths share the Surface and reuse compatible samples without repacking. | `render` · `shader` · `types` |
| Standard normal and bump mapping | **Opt-in** | Standard normal scale is a two-axis value; an authored height map supplies tangent-free bump gradients. Normal/bump maps keep independent UV records and presence bits while sharing compatible GPU samples. | `render` · `shader` · `gltf` |
| Alpha Hash coverage | **Opt-in** | Standard and Unlit stochastic coverage keeps the opaque queue, depth writes, shadow/temporal consistency, and ordinary material contract; it is a noisy approximation, not order-independent alpha compositing. | `render` · `shader` · `types` |
| Material `paramSchema` derivation | **Built-in** | One schema derives bind-group layout, uniform offsets, texture fields, and loader projection, avoiding parallel handwritten binding contracts. | `shader` |
| Material reflection gate | **Build-time** | Compiler reflection must match the `paramSchema`-derived interface; mismatch fails before cook/load readiness. | `shader-compiler` · `pack` |
| Runtime Shader Registry | **Built-in** | Player locates compiled artifacts by content-addressed manifest and creates shader modules, without Naga/compiler dependencies. | `shader` |
| Built-in WGSL modules | **Built-in** | Provides PBR, skinned PBR, unlit, sprite, MSDF text, shadow, lighting, BRDF, IBL, and post-process modules. | `shader` |
| WGSL `#import` composition | **Build-time** | Composes the WGSL import graph by module ID and detects missing modules, conflicts, and cycles. Runtime does not parse the source graph. | `shader-compiler` |
| Shader variants | **Build-time** | `#ifdef`/define sets produce deterministic specialization artifacts; variant identity enters runtime readiness through cook receipts. | `shader-compiler` · `pack` |
| Naga validation/reflection | **Build-time** | A thin TypeScript shell invokes Naga WASM for WGSL parsing, validation, and reflection, without renderer policy. | `naga` |
| Vite Shader plugin | **Build-time** | Forwards compiler behavior through load/transform/generateBundle/HMR; publishes WGSL/GLSL/bindings/manifests and propagates cross-file changes. | `vite-plugin-shader` |
| Custom Material Shader | **Opt-in** | User WGSL and MaterialAsset share the cook/load/record path. Demo workarounds or temporary runtime shaders are not Engine materials. | `shader` · `pack` · `render` |
| Transmission/refraction material | **Opt-in** | Standard materials use renderer-owned `TransmissionBackdrop` and optional rough-mips. Refraction samples the backdrop at the projected exit point of the refracted ray; exits near the screen edge or TIR fall back to environment, then unrefracted color; apps do not copy the backdrop. The dedicated layout needs 21 sampled textures per fragment stage; at the 16-texture WebGPU minimum the renderer selects a shared-slot variant that rebinds transmission, thickness and backdrop into the `metallicTexture` / `roughnessTexture` / `alphaTexture` slots, so refraction still renders. Known limitation: a transmissive material that also authors one of those split maps renders without refraction on a 16-texture device and reports `MaterialSampledTextureBudgetExceededError` with the conflicting maps; cooked Standard roots with their own program keep their declared layout and stay fail-closed below it. `materialSampledTextureBudget` and the `asset.material.preview` `sampledTextureBudget` field report this ahead of time. Chromium buckets fallback adapters such as SwiftShader to 16 unless launched with `--disable-dawn-features=tiered_adapter_limits`, which the Feature Lab runner passes. | `types` · `assets-runtime` · `shader` · `render` |
| Runtime CanvasTexture | **Opt-in** | `new CanvasTexture(canvas, { flipY })` exposes a caller-owned 2D canvas as a texture source. The renderer uploads only after `update()`, publishes frames across Workers, and keeps the caller canvas through renderer recovery; materials sample it like any texture. | `render` · `assets-runtime` |
| Standard height vertex displacement | **Opt-in** | `displacementTexture` moves vertices along the normal by `height * displacementScale + displacementBias` in one vertex kernel shared by color, depth, temporal, and shadow; extraction widens bounds and shading derives normals from displaced triangles. Needs a dense mesh. | `render` · `shader` |
| Mesh decals | **Opt-in** | `createDecalGeometry(receiver, { transform })` clips receiver triangles against a receiver-local unit box and returns an ordinary MeshAsset with projector UVs, drawn with a depth-biased overlay material. | `geometry` · `render` |
| Projected decals | **Opt-in** | `ProjectedDecal` projects a Standard material box onto visible Deferred depth before lighting; color, normal, and roughness compose through graph-owned DBuffer targets. Deferred only; no receiver mesh scan. | `render` · `shader` |
| Standard subsurface surface diffusion | **Acceptance pending** | Ordinary Standard material `subsurfaceRadius` RGB (0..12 presentation pixels) and `subsurfaceWeight` (0..1) request diffuse-only, depth/normal/profile-aware diffusion. Initial roster: opaque single-sample Deferred rigid/instanced/skinned surfaces, at most 16 active profiles. Compute/storage, float32 filtering/blending, texture-formats-tier2 and 32KiB workgroup storage are required. Zero demand adds no effect resources; unsupported combinations fail explicitly. Follow the material skill and Render contract; the retained ROI25 validation record distinguishes implementation from measured acceptance. | `types` · `shader-compiler` · `shader` · `render` |

### Geometry, scene, skinning, and animation

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| 3D Procedural Geometry | **Built-in** | Pure functions generate box, capsule, cone, cylinder, plane, sphere, torus, Utah teapot, and extrusion/sweep/revolution MeshAssets with shared tangent/layout/AABB contracts; no ECS entities or GPU buffers. | `geometry` |
| 2D Procedural Geometry | **Built-in** | Pure functions generate circle, sector, ellipse, annulus, capsule, rhombus, rectangle, polygon, triangle, and polyline. | `geometry` |
| Edge conversion factories | **Built-in** | `createWireframeGeometry` and `createEdgesGeometry` convert valid triangle-list MeshAssets into deterministic non-indexed `line-list` output using only CPU work and retaining no source references. | `geometry` |
| Tangent generation | **Built-in** | Area weighting, Gram–Schmidt, and handedness produce tangent vec4 for normal/parallax mapping. | `geometry` |
| Canonical vertex layout | **Built-in** | One attribute map derives location, offset, format, and stride; Importer, Render, and Shader share it. | `geometry` |
| GPU normal matrix and compact mesh payloads | **Built-in** | Per-draw mesh records no longer carry a CPU normal matrix; shaders derive it from the model matrix, so non-uniform and mirrored scales still shade correctly, and mesh payloads are compacted. | `render` · `shader` · `types` |
| Binary morph targets (mesh-bin v5) | **Built-in** | `packMeshBin` writes mesh-bin v5 with target-major binary morph lanes after the vertex block; all-zero channels are elided by mask and decode restores them. | `geometry` · `import` · `assets-runtime` |
| Points/Lines rendering | **Opt-in** | `Points`/`Lines` use ordinary MeshAsset `point-list`/paired `line-list` and `Materials.unlit`; strict admission produces expanded geometry in the Standard main pass. No strips, mixed topology, or implicit CPU fallback. | `render` · `shader` · `geometry` |
| Mesh vertex color | **Built-in** | `MeshAsset.attributes.color` is the sole linear-RGBA runtime fact shared by glTF `COLOR_0` and procedural geometry. Missing data uses white/no-stream behavior without a material switch. | `types` · `geometry` · `gltf` · `render` |
| Multiple UV sets | **Built-in** | Vertex layout supports multiple TEXCOORD sets; shaders requiring more than a mesh supplies may legally alias its last UV set. | `geometry` · `rhi` |
| Scene hierarchy | **Built-in** | `ChildOf/Children` and `scenePlugin` maintain hierarchy; `GlobalTransform.world` owns resolved pose for rendering, physics, audio, and picking. | `scene` · `ecs` |
| Mobility | **Built-in** | `Mobility` (absent = movable) records the author's motion commitment for rendering and baking. A closed diagnostic union reports each violation once per entity: scene detects a moved static, render a stationary mesh change, physics a body conflict. It is never derived from `RigidBody`. | `scene` · `render` · `physics` |
| O(D) moving-object propagation | **Built-in** | Transform propagation recomposes only dirty flat rows and the highest dirty hierarchy roots and publishes `GlobalTransform` change evidence for exactly that subtree, so upstream cost follows the D moved objects rather than the population. | `scene` · `physics` |
| SceneAsset instantiation | **Built-in** | AssetRegistry transactionally instantiates SceneAsset into ECS hierarchy; failures roll back only entities/references created by that attempt. | `assets-runtime` · `scene` |
| Nested Scene mounts | **Built-in** | SceneAsset can mount other SceneAssets with overrides; Catalog/GUID retains reference identity. | `assets-runtime` · `scene` |
| Renderer-independent Skin | **Built-in** | `skinning` owns `Skin` and joint-path resolution, without Renderer, Material, or GPU palette ownership. | `skinning` |
| GPU skin palette | **Built-in** | Render derives palettes from joint `GlobalTransform.world × inverseBindMatrix` for skinned PBR shaders. | `render` · `skinning` |
| AnimationClip playback | **Built-in** | `AnimationPlayer` advances clips and writes translation/rotation/scale targets; Scene Transform propagation resolves final world pose. | `animation` · `scene` |
| Stable animation target id | **Built-in** | Target paths derive stable IDs; ordinary Transforms and skin joints share one animation target model. | `animation` |
| Spring bone secondary motion | **Opt-in** | `@forgeax/engine/animation/skeletal-motion`: FixedUpdate managed contiguous chains, implicit attraction/damping, length/cone constraints and bounded endpoint-sphere contacts; stable saved target config, explicit reset/weight and cleanup; ordinary Skin consumes committed pose. | `animation` · `scene` · `skinning` |
| Managed physical skeleton blend | **Opt-in** | Rapier3D ordinary independent body entities and atomic fixed/hinge joint leases; exact physical subset, animation-to-physics velocity handoff and local TRS blend through bone/body offsets; parent-first bounded rig and positive uniform scale. | `animation` · `physics` · `physics-rapier3d` |
| Object property animation | **Opt-in** | Numeric/vector/quaternion curves and STEP boolean/string properties bind explicitly to native objects or ECS fields and share AnimationPlayer time and blending. | `animation` |
| Inverse kinematics | **Opt-in** | Cached current-pose CCD chains and pole-guided two-bone limbs write local joint rotations before Scene propagation; bounded iterations and structured failures. | `animation` |
| Spline IK | **Opt-in** | `animation/spline-ik` compiles an explicit current-pose joint chain; ordinary `Path` and `SplineIK` resources drive offset/direction, weight, preserve/fit lengths and twist before Scene propagation. Positive uniform ancestors are supported; unsupported scale and invalid topology fail structurally. Native Skin, posed bounds, performance and skeletal-motion writer conflict qualification remain pending. See `packages/animation/README.md` and `scripts/dev-verify/roi-24-spline-ik/README.md`. | `animation` · `path` · `scene` · `skinning` · `render` |
| Skeleton retargeting | **Opt-in** | Explicit source/target joint maps transfer reference-pose rotation deltas; preserve target bone lengths and optionally scale root motion. | `animation` |
| Animation timeline and root motion | **Opt-in** | Sorted typed method/audio/sub-animation keys publish ordered crossed-interval POD effects after pose evaluation; explicit consumers resolve durable GUIDs. AnimationRootMotion extracts loop-safe rigid deltas, locks the animated root to its reference pose, and exposes a composed accumulator. | `animation` |
| AnimationGraph | **Built-in** | Supports clip lookup, blending, slots/nesting, and node-weight evaluation. TypeScript controls AnimationPlayer through ordinary Update systems; control code uses existing PluginAssets, with no required animation FSM. | `animation` |
| Code-driven animation blending | **Opt-in** | Compiled 1D linear and explicit-triangle 2D BlendSpaces write sample weights into caller-owned arrays. Reusable target masks multiply per-channel influence on direct or graph playback; ordinary TypeScript Update systems own parameters and phase. | `animation` |
| Morph/BlendShape GPU deformation | **Opt-in** | With compute+storageBuffer, `createMorphFeature` handles extract/prepare/compute/cull/re-entry for up to eight morph targets. Browser pixel acceptance is not currently claimed. | `render` |

### 2D, text, video, and UI

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Sprite | **Built-in** | 2D sprites use MaterialAsset/mesh/Layer and transparent sorting in the same Renderer, without a parallel Canvas2D stack. | `render` |
| Sprite Atlas | **Built-in** | The asset atlas CLI generates PNG/Meta; runtime SpriteAnimation/region overrides consume regions through unified Sprite rendering. | `pack` · `render` |
| Sprite Instances | **Built-in** | Multiple sprite regions/transforms can use instanced draws, gated by count, uniform/storage capability, and shader constraints; mismatches batch/fall back or fail structurally. | `render` |
| Sprite Lit | **Built-in** | The 2D sprite-lit shader consumes directional, point, and spot lights without moving 3D mesh shading policy into Sprite authoring. | `shader` · `render` |
| Continuous and dashed line paths | **Built-in** | `Lines` on a `line-strip` MeshAsset draws a pixel-width path with miter joins; `dashSize`/`gapSize`/`dashOffset` are mesh-local units and only update the draw uniform. | `render` · `shader` |
| Tilemap | **Built-in** | Tilemap/TileLayer/TileSetAsset enters Renderer through chunk extraction; asset and rendering owners separate tile authoring from GPU recording. | `render` |
| Tile flip/rotation bits | **Built-in** | Pure data codecs encode/decode tile flip/rotation flags without Renderer or World dependencies. | `graphics-extras` |
| TileLayer object semantics | **Built-in** | Tile objects support multiple cells, pivot/flip, and multiple atlases. `sortScope='per-cell'` enables Y-interleaving with ordinary Sprites; this does not imply a built-in Tiled object-layer importer. | `render` |
| World-space MSDF Text | **Built-in** | FontAsset glyph metrics generate/update MeshAssets; MSDF shaders support depth occlusion, transparency, and HDR bloom. Font baking stays outside runtime. | `font` · `graphics-extras` · `render` |
| Video Texture | **Opt-in** | VideoAsset/VideoPlayer obtains `HTMLVideoElement` through the Host `VideoSourceProvider` (`VIDEO_SOURCE_PROVIDER_KEY` resource); Render updates textures with external-image copy. The `GPUExternalTexture` fast path is not implemented. | `graphics-extras` · `render` |
| Prepared UiAsset | **Host-side** | Mounts HTML/CSS in an open ShadowRoot; UiInstance owns layer, AbortSignal, and idempotent disposal. Consumers provide dynamic behavior. | `ui` |
| UI authoring validation | **Build-time** | The headless validator classifies native, normalizable, and runtime-bound content and reports diagnostics, without built-in React/Vue adapters. | `ui` |
| UI localization | **Runtime + Build-time** | `@forgeax/engine/ui/localization` consumes validated, offline i18next JSON embedded by the UI importer; native instances isolate projects and UI AbortSignal detaches language/resource subscriptions. | `ui` |
| UI preview evidence | **Development** | Produces PNG/JSON evidence with explicit viewport, DPR, fonts, resources, scenario, and clock; not a second UI pipeline for the game Renderer. | `ui` |

---

## GPU, RHI, and VFX

### RHI and backends

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Spec-aligned RHI | **Built-in** | Math-free, opaque-handle, Result-based, capability-gated WebGPU-shaped interface. High-level code does not branch on backend names. | `rhi` |
| Opaque GPU handles | **Built-in** | Buffer/Texture/Pipeline/Pass handles hide backend objects; packages exchange only RHI contracts. | `rhi` |
| RHI capability model | **Built-in** | Backend kind, features, limits, and optional operations are queryable data. Missing capabilities return structured results rather than fake implementations. | `rhi` |
| Browser WebGPU backend | **Built-in** | A thin shim forwards real browser GPUDevice, command recording, queue submission, timestamps, and runtime errors. | `rhi-webgpu` |
| wgpu WASM backend | **Built-in** | A TypeScript shell implements the same RHI through the merged Rust wgpu+naga WASM substrate. | `rhi-wgpu` · `wgpu-wasm` |
| WebGL2 downlevel lane | **Opt-in** | Without usable WebGPU, wgpu can run a restricted `wgpu-webgl2` path; compute, storage, MSAA, and other features follow real capability limits. | `rhi-wgpu` |
| RhiNull | **Test/experimental** | A GPU/DOM-free structural backend records handle/pass/draw/dispatch lifetimes without executing shaders, GPU validation, or pixel readback. | `rhi-null` |
| Native wgpu/Ray Query spike | **Test/experimental** | A private Rust crate proves desktop native-wgpu, surface, and Ray Query behavior; it is not a complete public native renderer. | `rhi-wgpu-native` |
| Native wgpu source pin | **Build-time** | The private native wgpu owner builds against the maintained `third_party/wgpu` gitlink at an exact version; the SDK source snapshot expands the same tree for native Rust rebuilds. | `rhi-wgpu-native` · Engine root scripts |
| Compute pass | **Built-in** | RHI and RenderGraph support compute pipelines, dispatch, and resource dependencies; product features still declare capabilities and fallback. | `rhi` · `render-graph` |
| Indirect drawing | **Opt-in** | Supports indexed/non-indexed indirect draws; production use is gated by `indirectDrawing` and storage/compute capabilities. | `rhi` · `render` |
| Timestamp query | **Opt-in** | Provides GPU timestamp/query contracts when supported by the backend. CPU Profiler does not own or fabricate GPU time. | `rhi` · `rhi-webgpu` |

### GPU-driven rendering

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| GPU Scene tables | **Built-in** | Automatic when StorageBuffer capability exists: derives Primitive, Instance, Transform, DrawTemplate, and Material tables from the persistent CPU Render Scene; otherwise uses the CPU lane. | `render` |
| GPU view culling | **Built-in** | Compute kernels cull eligible rigid objects; ordinary CPU/specialized lanes handle ineligible objects. | `render` |
| GPU draw compaction | **Built-in** | Compacts visible instances into bounded streams and writes indirect args; overflow is explicit inspection/error data. | `render` |
| GPU-driven custom Surface ABI | **Opt-in** | Cooked Standard custom Surface/full-custom programs enter the indirect lane only after publishing `vs_main`/`vs_scene_index`, reflected resources, vertex inputs, GPU Scene pages, and optional ShadowCaster ABI. Ordinary custom WGSL stays on direct/specialized lanes. | `render` · `shader` · `pack` · `assets-runtime` |
| CPU capability fallback | **Built-in** | Missing compute/storage/indirect capability or ineligible objects use CPU/specialized recording without simulating nonexistent GPU features. | `render` |
| Deferred membership timing | **Development** | Internal CPU/GPU timing evidence for GPU-driven membership; there is no public API to enable or read it, so it is CI-proved only. | `render` · `app` |

### VFX

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Code-first VFX source | **Opt-in** | Schema-v3 source expresses behavior through emitter metadata and `vfx_spawn/vfx_update` WGSL hooks, without node graphs or CPU particle mirrors. Pack v2 remains the outer delivery envelope. | `vfx` |
| VFX compiler/cooker | **Build-time** | Composes managed prelude/shell, validates Naga reflection, and emits deterministic Pack artifacts. World/Renderer stays outside the compiler. | `vfx-compiler` |
| VFX ECS player | **Opt-in** | `ParticleEffectPlayer` and FixedUpdate produce ordered intents and load cooked programs by GUID, without directly owning RHI state. | `vfx` |
| Persistent GPU simulation | **Opt-in** | Runs spawn/update/scan/compact on GPU buffers without per-frame particle readback to CPU. Bounded `forceFields` declarations and the explicit WGSL helper add sphere/box acceleration and saved constant/radial/vortex 3D texture GUIDs through ordinary cook/load and shared FixedUpdate. | `vfx` · `vfx-compiler` · `vfx-render` |
| Managed scene SDF collision | **Development** | Schema-v3 WGSL imports a reflected read-only field. Renderer composes checked geometric Mesh artifacts for a fixed World range, independently of GI and display views; bounded swept response exposes coverage/work diagnostics. Real GPU quality and performance require the VFX acceptance evidence. | `geometry` · `import` · `render` · `vfx-compiler` · `vfx-render` |
| VFX indirect rendering | **Opt-in** | Simulation results drive indirect draws tied to RenderFeature lifetime. | `vfx-render` |
| VFX submission observation | **Development** | `feature.inspect()` reports dispatches, indirect draws, and subject output admitted in the latest submitted frame. It is not particle-instance readback and does not prove nonzero indirect instance counts. | `vfx-render` |
| Billboard particles | **Opt-in** | Camera-facing quad output uses separate material/topology/capacity, not a CPU sprite fallback. | `vfx-render` |
| Mesh particles | **Opt-in** | Particle instances drive mesh output; geometry/material enters Renderer through the cooked VFX contract. | `vfx-render` |
| Ribbon particles | **Opt-in** | GPU output produces continuous ribbon topology; effect assets explicitly declare capacity and bounds. | `vfx-render` |
| Trail particles | **Opt-in** | GPU trail output owns dedicated history/connectivity semantics without reusing ECS entity trail lists. | `vfx-render` |
| Beam particles | **Opt-in** | GPU beam output uses a separate generation/draw lane while sharing the same VFX program/readiness owner. | `vfx-render` |
| VFX fixed-bounds culling | **Opt-in** | Uses asset fixed bounds for culling without a CPU particle mirror to derive dynamic bounds. | `vfx-render` |
| VFX capability refusal | **Built-in** | Missing compute/indirect capability yields structured refusal without silently switching to a visually different CPU fallback. There is no public trigger on a capable device; CI proves it with a restricted backend. | `vfx-render` |
| VFX inspection/LKG | **Development** | Exposes program, buffer, draw, failure, and recovery state with LKG support. Real appearance requires Browser/Dawn evidence. | `vfx-render` |

---

## Core architecture and ECS

### Types and math

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| POD/Result SSOT | **Built-in** | Centralizes cross-package POD, `Result`, `ok/err`, and shared structured error shapes; domain error codes remain package-owned. | `types` |
| Typed Handle | **Built-in** | `Handle<Target, unique/shared>` constrains resource tags and release modes at the type level, without owning GUID or Catalog identity. | `types` |
| Format-independent asset POD | **Built-in** | Runtime Mesh/Material/Scene/Texture/Skeleton/Skin/Animation structures do not carry glTF/FBX source-format objects. | `types` |
| Out-param math | **Built-in** | Pure vec/mat/quat/euler/color functions over branded Float32Array prioritize out-parameters, avoiding hidden object graphs and allocations. | `math` |
| WebGPU/WebGL/Reverse-Z projections | **Built-in** | Explicit projection families cover different NDC/depth conventions; callers select a contract rather than relying on implicit platform state. | `math` |
| 3D geometry queries | **Built-in** | Pure frustum, ray, AABB, sphere, and triangle intersection/projection primitives. | `math` |
| 2D geometry queries | **Built-in** | Pure box2, circle2, ray2, and intersection primitives reusable by physics/picking without moving their policy into math. | `math` |
| Color conversion | **Built-in** | Pure sRGB/Linear/Hex conversions; Render retains color-domain and tone policy. | `math` |

### ECS World

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| World state authority | **Built-in** | World owns entities, components, queries, systems, resources, and time. Scene/Render/Physics do not introduce separate ECS facades. | `ecs` |
| Schema-defined component | **Built-in** | `defineComponent` creates frozen tokens with a closed field vocabulary including numeric, bool, string, entity, shared, and fixed/variable arrays. | `ecs` |
| Archetype SoA storage | **Built-in** | Organizes components by archetype/column without exposing internal Table/Column objects through the public data surface. | `ecs` |
| Sparse tag component | **Built-in** | An empty schema expresses presence-only tags without extra boolean fields or object instances. | `ecs` |
| Query row | **Built-in** | `world.query` row iteration provides entity identity and token-based read/mut for flexible gameplay access. | `ecs` |
| QuerySpan | **Built-in** | Numeric queries project packed spans for batching while World controls writes and entity correspondence. | `ecs` |
| Update schedule | **Built-in** | Each `world.update(delta)` runs one variable-step schedule; App does not add a second frame-callback DSL. | `ecs` |
| FixedUpdate schedule | **Built-in** | World runs zero or more fixed steps under TimePolicy with catch-up/drop handling; Physics and other fixed simulations join this schedule. | `ecs` |
| Deferred commands | **Built-in** | System structural mutations enter a command buffer; expected failures leave World unchanged before commit. | `ecs` |
| ECS Resource | **Built-in** | World stores non-owning resource values. Cordis/App/feature owners retain external-object disposal. | `ecs` |
| Relationship reverse index | **Built-in** | The source is the sole writable fact; ECS materializes the target as a read-only reverse index. Direct-child queries cost $O(1+k)$. | `ecs` |
| Bounded change projection | **Built-in** | `ecs/projection` `createStateProjection` discovers the current changed-entity work set (deduplicated source indices, changed components, membership flag) from block baselines, not a history journal. The consumer applies the candidate, then `validate()`/`accept()` commits it; a World mutated in between throws `state-projection-expired` and the consumer re-reads current state. | `ecs` |
| Externalization/remap | **Built-in** | Projection removes transient fields and remaps entity references; consumer profiles reject nonportable fields. Net owns network profiles/codecs. | `ecs` |
| Shared numeric kernels | **Opt-in** | Accepts only module-loadable named functions and eligible numeric QuerySpans; rejects object fields and structural changes. | `ecs` |
| World inspection | **Development** | `world.inspect()` returns detached, deeply frozen POD summaries, not a live registry or storage escape hatch. | `ecs` |
| World-local ComponentCatalog lease | **Built-in** | Each World independently leases component registration. Fiber lease release returns `component-in-use` while entities/systems still reference it. | `ecs` · `plugin` |
| UniqueRef/SharedRef write barrier | **Built-in** | Per-World stores and spawn/set/despawn/removeComponent barriers maintain resolve/retain/release. External owners retain payload disposal. | `ecs` |
| World poison | **Built-in** | System throws or shared-kernel partial writes poison World and stop updates. App can rebuild Worker execution; Host replaces main-serial World. | `ecs` · `app` |

### State machine

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Saved paths and world-distance following | **Opt-in** | SceneAsset controls and instance-local bindings drive shared immutable world-space arc/frame preparation; independent FixedUpdate distance supports reverse, pause, loop and stable model-axis orientation. Ordinary followers write Scene TRS; physics consumes DesiredPathPose. Tangent orientation requires a positive uniform-scale follower parent; position supports nonuniform scale. | `path` · `scene` |
| Graph/grid navigation and path following | **Opt-in** | Immutable directed XYZ graphs and XY/XZ grids return bounded optimal routes; copied waypoints drive local-space ECS kinematic following in FixedUpdate before Scene propagation. Point-agent connectivity only; NavMesh, carving and crowd remain unqualified. | `navigation` |
| Static NavMesh and physical character navigation | **Opt-in** | Indexed Mesh/world placement bakes finite capsule clearance into ordinary navigation-mesh assets; bounded world-space projection/corridor queries, local velocity sampling and real PhysicsWorld KCC follow from actual pose. Congestion reports blocked; dynamic carving and traversal actions remain separate. | `import/navigation-bake` · `navigation` · `physics` |
| Typed StateToken | **Built-in** | `defineState` creates a typed single-World state resource with a compile-time closed variant union. | `state` |
| Deferred state transition | **Built-in** | `setNextState` requests a transition; an Update transition system commits state flip and scope cleanup in fixed order. Callback failure does not roll back the transaction. | `state` |
| State-scoped entities | **Built-in** | `despawnOnExit/despawnOnEnter` removes marked entities during transitions; unscoped entities can persist across states. | `state` |
| OnEnter/OnExit hooks | **Built-in** | Runs state-token/variant label/callback hooks. Errors propagate as ECS system failures, but state flip or partial cleanup may already be committed. | `state` |
| `inState` condition | **Built-in** | Returns a World predicate to gate systems without a separate state scheduler. | `state` |

---

## App, input, and plugins

### App and execution tiers

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| App Host adapter | **Built-in** | Host measures delta once per frame, calls `world.update`, then `renderer.draw`. World owns time, fixed steps, and gameplay. | `app` |
| Canvas assembly | **Built-in** | The canvas entrypoint creates World, Renderer, default plugins, browser input, and the rAF loop; callers must handle its structured Result first. | `app` |
| Injected assembly | **Built-in** | Advanced assembly accepts host-owned World/Renderer/plugins without changing owner lifecycles or time policy. | `app` |
| Start/stop/pause/resume | **Built-in** | Controls frame scheduling without duplicating World; stepping while paused uses the same update/draw path. | `app` |
| Main-serial tier | **Built-in** | World and Renderer share the Host realm. This tier has no Worker prerequisite, though Renderer/GPU conditions can still prevent App creation. | `app` |
| Engine-worker tier | **Opt-in** | World, Renderer, Assets, RenderFeatures, and gameplay plugins share an Engine Worker. Host retains DOM, Web Audio, and frame credit. | `app` |
| Shared tier | **Opt-in** | Adds a persistent Kernel Worker pool for eligible QuerySpans alongside Engine Worker, without splitting live World or RenderGraph. | `app` · `ecs` |
| Auto tier selection | **Built-in** | Selects the best proven tier by capability and reports requested/actual/reason. Only `auto` may downgrade. | `app` |
| One-credit Worker frame pacing | **Opt-in** | Engine Worker allows one in-flight frame credit to avoid input/simulation latency from queues. Main-serial rAF bypasses this ledger. | `app` |
| Execution report | **Built-in** | Reports realm/tier, World health, kernel/audio/capability, performance, faults, and fallback reasons. Liveness is not visual acceptance. | `app` |
| Explicit Worker World rebuild | **Opt-in** | `execution.rebuild()` creates a fresh World identity for poisoned Worker execution. Host still rebuilds main-serial/local assembly. | `app` |
| Surface handoff | **Built-in** | Releases/restores canvas surfaces while retaining World, Renderer, Assets, and execution identity. | `app` |
| Draw source routing | **Built-in** | One frame loop updates/draws multiple Worlds with explicit camera/resource owners; setters do not create another loop. | `app` |
| Renderer feature passthrough | **Built-in** | Main/assemble forwards features/timing unchanged; each RenderFeature gets one terminal callback per frame (`onFrameSubmitted` for admitted work, `onFrameAborted` for an empty plan). Explicit tiers assemble within realm bootstrap; feature/Render owners retain lifecycle. | `app` |
| Optional CPU profiler passthrough | **Opt-in** | Records App/Render phases only during active capture. Default construction performs no profiler work. | `app` · `profiler` |
| Tool Preview Host | **Development** | Runs typed action timelines, capture, and fresh-device replay through the same App/WebGPU path; hidden presentation does not replace Renderer. | `app` · `preview` |

### Input

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Frozen InputSnapshot | **Built-in** | Scans the backend at Update start and freezes one frame's input. Gameplay using this package reads the Resource; Host may retain independent UI/demo DOM listeners. | `input` |
| Keyboard input | **Host-side** | Provides held/pressed/released edges for logical keys and physical codes, resetting on focus loss. | `input` |
| Mouse input | **Host-side** | Provides frame snapshots of position, movement delta, button edges, and wheel input. | `input` |
| Gamepad input | **Host-side** | Scans connectivity, button/value edges, and raw axes; action mapping applies deadzones as needed. | `input` |
| Gamepad feedback | **Host-side** | Bounded dual-rumble play/stop from ECS, scan-derived targets, Worker POD transport and structured results. Physical device compatibility remains unverified; no gyro/accelerometer coverage. | `input` · `app` |
| Multi-pointer input | **Host-side** | Unified touch/pen/mouse readers keyed by pointerId; Host retains UI ownership. | `input` |
| Pointer Lock | **Host-side** | Engine realm controls only `setPointerLockAllowed`; Host input backend/lockProvider owns request/release and `pointerLocked` snapshots. | `input` · `app` |
| Action mapping | **Built-in** | Maps keyboard/mouse/gamepad into device-independent actions without gameplay device branches. | `input` |
| Virtual axis/joystick | **Built-in** | Separate virtual-axis and virtual-joystick namespaces feed the same InputSnapshot. | `input` |
| Gesture recognition | **Built-in** | Recognizes pinch, rotate, swipe, long-press, and double-tap through the snapshot/action boundary. | `input` |
| Input capability probe | **Built-in** | Reports backend/device capabilities once without fabricating availability from user-gesture outcomes. | `input` |

### Plugin, Project, and DSH

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Cordis Context/Fiber | **Built-in** | Plugins bind resources, systems, listeners, and disposers through inject/provide/effect. Fiber disposal unwinds effects in reverse order. | `plugin` |
| Static plugin programs | **Build-time** | DevKit compiles literal program imports from Pack root closures; runtime does not scan installed packages. | `plugin` · `devkit` |
| Plugin realm placement | **Built-in** | Root GUIDs select Node host, browser frontend, Engine World, or isolated build execution. | `project` · `plugin` |
| `forge.json` manifest | **Built-in** | Strict schema v3 validates identity and root asset GUIDs; definitions and configuration belong to Pack. `forge-scene-unresolved` remains in the error union but has no producer under schema v3. | `project` · `plugin` |
| Realm bootstrap | **Built-in** | DevKit compiles static program tables; each realm constructs its own native plugins and exchanges POD over transport. | `devkit` · `app` |
| DSH federation bridge | **Opt-in** | Engine and DeepSeek Harness retain their native Context/Fiber trees, connected only by versioned POD messages. | `dsh` |
| DSH Engine panel | **Opt-in** | The DSH Web panel embeds an existing Engine endpoint; unconfigured instances add no frame-loop work. | `dsh` |

---

## Physics, audio, networking, and intelligence

### Physics

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Physics ECS interface | **Built-in** | Defines RigidBody, Collider, CharacterController, CollidingEntities, CollisionEvent, and PhysicsWorld Resource; the interface package does not implement a solver. | `physics` |
| 2D Rapier backend | **Opt-in** | Rapier2D WASM implements three-phase ticks, Transform sync, collision translation, raycasts, teleport, and cleanup. It lacks hello/browser visual gates equivalent to 3D. | `physics-rapier2d` |
| 3D Rapier backend | **Opt-in** | Rapier3D WASM supplies 3D bodies/colliders, collisions, raycasts, teleport, and cleanup. | `physics-rapier3d` |
| Three-phase physics tick | **Built-in** | Sync backend → fixed-step simulation → Transform writeback; ECS World owns the fixed step. | `physics` · `ecs` |
| Rigid body types | **Built-in** | A closed set and narrowing helpers express static/dynamic/kinematic types; backends map them to Rapier. | `physics` |
| Collider shapes | **Built-in** | ECS schemas express 2D/3D collider shapes and parameters; source components are runtime intent. | `physics` |
| Collision pairs/events | **Built-in** | Backends translate collisions into ECS-owned transient/query facts without exposing Rapier handles. | `physics` |
| Physics raycast | **Built-in** | PhysicsWorld supplies backend raycasts. Picking owns generic screen picking; collision and rendering AABB authorities remain separate. | `physics` |
| Teleport | **Built-in** | Explicitly synchronizes backend bodies and ECS Transforms, avoiding changes to only one state source. | `physics` |
| `moveAndSlide` KCC | **Built-in** | Kinematic characters resolve desired delta against slope, autostep, ground snap, and grounded state, then write final Transforms. | `physics` |
| Physics readiness | **Built-in** | Asynchronous WASM/body preparation exposes `hasBody` and structured errors; gameplay checks readiness before KCC calls. | `physics` |

### Audio

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Realm-neutral AudioSource | **Built-in** | ECS components express clip, play/stop, loop, volume, spatialBlend, and bus. Engine realm holds no Web Audio objects. | `audio` |
| AudioListener | **Built-in** | The first listener entity's `GlobalTransform.world` produces position/orientation intent; Host applies Web Audio pose. | `audio` · `scene` |
| Host Web Audio backend | **Host-side** | Host exclusively owns AudioContext, AudioBuffer, source nodes, Gain/Panner, and cleanup. Workers send closed AudioIntent data only. | `audio-webaudio` |
| Audio decode cache | **Host-side** | Reuses decoding by sourceKey/content identity; changed bytes replace authority. Old pending completions cannot overwrite newer content. | `audio-webaudio` |
| Clip start and seek | **Built-in** | `AudioSource.fromPosition` starts/seeks in decoded clip seconds; `AudioBackend.seek` carries repeated requests across Worker intents. Host retains pending/paused positions and reuses the native graph. | `audio` · `audio-webaudio` |
| Configurable audio buses | **Host-side** | Accepted acyclic parent/send graph, pre/post-fader taps, mute and exclusive shared effects; defaults remain `sfx/music → master`. | `audio` · `audio-webaudio` |
| Long audio windows | **Host-side** | Source Meta selects PCM16 WAV streaming; ordinary GUID admission defers full-body reads. Host verifies bounded Range windows under the shared 64 MiB budget. Compressed streaming and data-URL hosting are unsupported. | `audio` · `audio-webaudio` · `import` |
| 3D spatial audio | **Host-side** | `spatialBlend` creates PannerNode and synchronizes listener/source pose. The default is equalpower, not a complete HRTF pipeline. | `audio-webaudio` |
| Acoustic regions | **Opt-in** | Saved box/sphere Scene components select bounded highest-priority normalized source routes and independent first-listener shared wet/send overlays. Native ramps reuse existing configured buses and effect factories; no geometry-derived reverb or multi-listener mixer. | `audio` · `audio-webaudio` · `scene` |
| Audio entity epoch fencing | **Host-side** | Entity epochs and source identity reject stale decode/play completions after stop, replacement, or despawn. | `audio-webaudio` |
| Quantized layered music | **Host-side** | Ordinary buffered GUID stems, sample-rounded beat/bar mix envelopes, explicit late/cancel receipts and Host epochs. Same Context and bus graph across main/Worker/shared; streaming and independent time stretching are unsupported. | `audio` · `audio-webaudio` · `app` |
| Audio cleanup | **Host-side** | Despawn, stop, and disposal release source nodes/cache references. AudioContext never serializes across realms. | `audio` · `audio-webaudio` |

### Networking

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Host-neutral NetEndpoint | **Built-in** | Transports complete bytes, PeerId, and connection lifecycle without World, profile, replication, or codec knowledge. | `net` |
| NetSession | **Built-in** | Owns endpoint polling, a logical `SessionId`, bounded raw messages, a bounded ACK/retry ledger, protocol-v2 baseline/delta ordering, connector-driven reconnect/resync recovery (epoch bump plus fresh baseline under the same `SessionId`), and retirement; consumers never own socket reconnect or transport `PeerId` policy. | `net` |
| Replication profile | **Opt-in** | `defineReplication` fixes portable components, limits, fingerprint, and NetEntityId mappings. | `net` |
| Authority replication | **Opt-in** | The authority coordinator generates portable snapshots/messages from profile-selected ECS facts rather than copying arbitrary World internals. | `net` |
| Per-session replication visibility | **Opt-in** | `attachAuthority(authority, visibility)` narrows Profile entities per logical SessionId; receiver-local baseline/delta/despawn, hidden-reference clearing, independent ACK bounds and reconnect evaluation preserve peer isolation. `getReplicationSnapshot()` reports each stream. | `net` |
| Replica atomic validation | **Opt-in** | Validates size, profile, identity, reference closure, and decoding before World mutation; refusal leaves World unchanged. | `net` |
| Browser WebSocket client | **Opt-in** | Maps browser WebSocket to NetEndpoint bytes/lifecycle without retry, rollback, or prediction. | `net-websocket` |
| Node WebSocket client/listener | **Opt-in** | Provides Node client/listener adapters; Net/Profile owners still define product protocols. | `net-websocket` |
| Memory fault transport | **Test/experimental** | Deterministically injects delay, duplicates, malformed bytes, and disconnects for headless contract tests only. | `net` |

### Intelligence and NPCs

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Provider-neutral Activity | **Built-in** | Provides bounded submit, ordered poll, cancellation, and terminal failure without prompt, agent, tool, memory, or gameplay policy. | `intelligence` |
| Intelligence MessagePort bridge | **Opt-in** | Host providers and Engine realm exchange structured Activity POD; credentials and SDK objects remain on Host. | `intelligence` |
| Deterministic fake provider | **Test/experimental** | `advance()` deterministically progresses Activity for tests, demos, and offline validation without simulating real provider timing. | `intelligence-fake` |
| DSH Activity provider | **Host-side** | Each Activity owns a JSON-RPC runtime/process using DSH close semantics for cancellation/cleanup. DSH types stay within their realm. | `intelligence-dsh` |
| NpcBrain ECS binding | **Built-in** | Stores soul ID, affordance references, enabled state, and LOD. Host adapters own prompt/model/navigation/action policy. | `npc` |
| Host-injected NPC adapter | **Opt-in** | Plugins call host client adapters on NpcBrain signature changes and Update ticks, with Fiber-owned lifecycle. | `npc` · `plugin` |

---

## Assets and content production

### Asset identity, Pack, and Catalog

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| External Meta sidecar | **Build-time** | `*.meta.json` stores external-source importer, GUID, subAssets, and provenance. Runtime reads projections only. | `pack` |
| Pack source / transport | **Build-time** | `*.pack.json` can contain Pack authoring v3 (direct/instance) or generated Pack v2 transport. Scanners distinguish schema and processing paths; transport is not author source. | `pack` · `vite-plugin-pack` |
| AssetGuid | **Built-in** | Provides UUID parse/format/compare/generate and builtin derivation; GUID is stable runtime identity. | `pack` |
| SourceKey identity reuse | **Build-time** | Reimport reuses GUIDs by sourceKey. sourceIndex locates source data without becoming runtime identity. | `pack` · `import` |
| Pack scanner | **Build-time** | Fails fast on schema, GUID, conflicts, orphaned Meta, subAsset, and payload violations with one structured PackError per class. `pack-meta-missing` is declared but has no producer. | `pack` |
| ScriptablePack / Pack | **Build-time** | Executable `*.pack.ts` ScriptablePacks produce Assets by `sourceKey`; `*.pack.json` contains direct/instance Pack documents. Neither explicitly declares output GUIDs or `externalAssets`; sources must not write Pack/Catalog or World. | `pack` |
| ScriptablePack executor | **Build-time** | Node workers/pools execute source closures and cold builds with timeouts and structured failures. | `pack` |
| Asset output producers | **Build-time** | Injected producers create Material/Mesh/Scene outputs and record content/reference dependencies; Importer does not hardcode all asset kinds. | `import` |
| Native cooker registry | **Build-time** | `NativeCookerRegistry` maps a kind key to discover + cook; `run()` returns validated drafts or `native-cook-failed`, and runtime performs no source-format conversion or silent fallback. Discovered `sourceDependencies` are not carried into the drafts. | `pack` |
| Producer facts/receipts | **Build-time** | Producers publish fingerprints, source closures, artifacts, and receipts. Catalog does not reconstruct facts from URLs or ordering. | `pack` |
| AssetEnvelope refs | **Built-in** | `refs` is the cross-asset dependency-graph SSOT, carrying structured provenance such as source fields; runtime loaders traverse it recursively. | `types` · `assets-runtime` |
| Asset kind/runtime loader matrix | **Built-in** | `createDefaultLoaderRegistry()` wires one loader per kind: mesh, material, scene, texture, equirect, sampler, font, render-pipeline, tileset, video, skeleton, skin, animation-clip, animation-graph, audio, particle-effect, ies-profile, plugin, and ui. Video is a runtime URL descriptor requiring no import/cook. | `types` · `pack` · `assets-runtime` |
| AssetEvidence | **Development** | Combines build-time source/producer/artifact/catalog/receipt and optional runtime state as inspection evidence. `unknown` explicitly does not mean passed. | `pack` · `assets-runtime` |
| Asset authority audit | **Development** | Schema and executable gates validate each asset kind's author, producer, runtimeSource, Catalog, sourceKey policy, and ownership boundaries. | Engine root schema/scripts |
| Pack index | **Build-time** | Build emits `pack-index.json` with hash/artifact locators as a projection of producer facts, not another author source. | `vite-plugin-pack` |
| Catalog authority | **Build-time** | Explicit authoritative/degraded state, revision, diagnostics, and producer fields prevent incomplete catalogs from posing as success. | `vite-plugin-pack` |
| Catalog delta | **Development** | added/changed/removed carries facts only. Consumers choose reload/merge policy; Catalog performs no decoding or GPU work. | `vite-plugin-pack` · `assets-runtime` |
| Hot content-catalog refresh | **Development** | Dev asset-root changes rebuild and republish the serving Catalog in place, keep existing GUIDs, and leave the Vite session and preview target alive; runtime subscribes through the existing CatalogSource lifecycle. The published epoch currently stays at 1, so consumers compare catalog content. | `vite-plugin-pack` · `assets-runtime` · `devkit` |
| CatalogSource lifecycle | **Built-in** | Runtime subscribes before enumerating and merges complete rows by GUID. Replacing a source releases its old subscription. | `assets-runtime` |
| Catalog replica admission | **Built-in** | Host surfaces sharing one explicit URL may share an accepted `CatalogReplica` baseline. Sources with `expectedRevision`/`expectedScope` must re-enumerate and pass admission; rejected results cannot use unscoped URL-cache rows as accepted evidence. | `assets-runtime` |
| Runtime Pack generation | **Opt-in** | `RuntimePackProducer` admits direct content and runtime generators, validates closures, publishes ordinary Catalog rows, and restores from a durable snapshot; generated native plugins persist with the project. | `import` · `pack` · `devkit` · `app` |
| Cook source snapshot | **Build-time** | One build generation shares captured source bytes, digests, and resolution probes across cook and inspection; `verify()` refuses a stale candidate before publication. | `pack` · `import` |
| Runtime binding SSOT | **Development** | Vite Pack virtual modules provide scope/generation-bound bindings and lazy-import transport shared by generated Host and AssetRegistry. Production uses static `pack-index.json`; these Catalog sources are mutually exclusive, not sequential overrides. | `vite-plugin-pack` · `assets-runtime` · `devkit` |

### Import, cook, DDC, and runtime loading

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| ImporterRegistry | **Build-time** | Registers/selects build-time importers by Meta importer key; excluded from player bundles. | `import` |
| Meta-driven import | **Build-time** | Validates GUID sets and generates DDC Pack/bin; importer dependencies remain source → cooked. | `import` |
| Lazy import transport | **Development** | Studio/dev hosts request import by GUID. Shipped/null transports fail fast on assets not already imported. | `import` |
| Import cycle/timeout detection | **Build-time** | The ScriptablePack build bridge detects producer cycles, fingerprint conflicts, and timeouts as structured errors. | `import` |
| Vite Pack plugin | **Build-time** | Connects Meta, Importer, Cooker, DDC, Pack, and Catalog without owning authoring or Editor write policy. | `vite-plugin-pack` |
| Development Pack routes | **Development** | The dev server serves one generation-scoped runtime catalog (`catalog.json`, per-entry package URLs cooked on demand) and a POST-only lazy import route. Stale generations (410), unknown scopes (404), GET on import (405), and the disabled global routes answer with structured JSON errors. | `vite-plugin-pack` |
| DDC v2 | **Build-time** | Node-only disposable derived-data cache without Editor Save/Undo/Promote semantics. | `ddc` |
| DDC lifecycle/CAS | **Build-time** | `DdcLifecycle` keeps one CAS head per GUID with lease-guarded missing → cooking → current transitions, LKG retention across failed recooks, stale/lease-lost refusals, scoped runtime roots, and mark-and-sweep GC that never deletes current, LKG, or leased entries. `withDdcLock` serializes immutable-cache repair without creating publication heads. | `ddc` |
| AssetRegistry | **Built-in** | Per-renderer GUID→payload catalogs, loader dispatch, and scene instantiation; no Meta/Pack/DDC writes. | `assets-runtime` |
| `loadByGuid` | **Built-in** | Loads payloads and refs from configured Catalog/Pack and returns concrete asset POD; does not mint app-level generic handles. | `assets-runtime` |
| LoaderRegistry | **Built-in** | Plugins register/revoke asset-kind→loader mappings through Fiber leases, retaining one actual owner per kind. | `assets-runtime` |
| Recursive ref loading | **Built-in** | Recursively prepares dependencies from AssetEnvelope refs; traversal is independent of specific asset kinds. | `assets-runtime` |
| Builtin mesh handles | **Built-in** | Cube, Triangle, Quad, Sphere, Cylinder, and Nine-slice Quad render from process-static payloads through reserved handles below `BUILTIN_BASE`, outside GUID reference counting; each maps to a stable builtin GUID. | `assets-runtime` |
| World shared asset refs | **Built-in** | World interns/allocates shared references after payload load. AssetRegistry does not own World entity-column reference lifetimes. | `assets-runtime` · `ecs` |
| Scene instantiate transaction | **Built-in** | Joint/mount/post-spawn failures roll back only the current attempt's entities, hierarchy, and shared-reference grants. Repair assets and retry the same GUID. | `assets-runtime` |
| Runtime publication preparation | **Built-in** | Runtime-produced Packs are prepared privately by the registry loaders and adopted only through a single-use commit proof; portable mesh encoding (`prepareMeshData` / `packMeshBin`) is a separate pure geometry kernel. | `assets-runtime` · `geometry` |
| Transient package read retry | **Built-in** | Pack GETs failing with 408/429/500/502/503/504 retry twice (250 ms, 750 ms, cache `reload`); permanent statuses fail on the first request. | `assets-runtime` |
| DynamicTextureStore | **Built-in** | Manages transient runtime texture uploads and invalidation on device replacement without replacing source-image importers. | `assets-runtime` |
| Runtime PNG/JPEG decode | **Built-in** | Converts in-memory PNG/JPEG bytes to TextureAsset POD without fetch or GPU upload. KTX2/Basis/HDR/equirect retains codec/image/Pack loader paths. | `assets-runtime` |

### Asset formats and content kinds

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| Image importer | **Build-time** | Converts JPG/PNG/HDR to TextureAsset/EquirectAsset and raw bin/Basis KTX2; runtime/render owns GPU upload. | `image` |
| 2D-array/3D TextureAsset | **Built-in** | One `TextureAsset` expresses `2d`, `2d-array`, or `3d` shape. Descriptors/producers share canonical mip-major/image-major/row-major bytes without extra layer/slice GUIDs. | `types` · `image` · `assets-runtime` |
| Texture compression policy | **Build-time** | `auto/etc1s/uastc/none` selects offline encoding using format, color-space, and HDR rules. | `image` · `codec` |
| Offline mip chain | **Build-time** | Compressed texture mips are generated during import/cook; runtime does not regenerate them. | `image` |
| HDR RGBE import | **Build-time** | Image importers produce f16 EquirectAsset, runtime loaders load it, and Render projects cubemap/IBL. Frame loops do not parse source files. | `image` · `assets-runtime` · `render` |
| Zstd runtime decode | **Built-in** | Player exposes deterministic decompression only; encoding subpaths remain physically isolated at build time. | `codec` |
| KTX2/Basis transcode | **Built-in** | Parses KTX2, selects GPU target formats using real capabilities, and performs block-aware upload. | `codec` · `assets-runtime` |
| Build-time Zstd encode | **Build-time** | The `/encode` subpath emits deterministic compressed artifacts; isolation gates exclude it from players. | `codec` |
| glTF/GLB parse | **Build-time** | Pure functions parse source/GLB buffers without fetching, spawning World entities, or creating GPU resources. | `gltf` |
| glTF importer | **Build-time** | Produces mesh, material, scene, texture, skeleton, skin, animation-clip, and stable references. | `gltf` |
| glTF scene load | **Built-in** | Consumers use unified `loadByGuid<SceneAsset> + instantiate`, without a parallel `loadGltf(url)` runtime API. | `gltf` · `assets-runtime` |
| glTF skin/animation | **Opt-in** | Build-time importers produce joints/clips; runtime post-spawn resolves joint paths. Interpolation/morph claims are limited to actual source support. | `gltf` · `skinning` · `animation` |
| FBX WASM parser | **Build-time** | ufbx Emscripten WASM is shared by Browser/Node without Autodesk SDK/native-addon dependencies. | `fbx` |
| FBX importer | **Build-time** | Produces mesh, material, scene, texture, skeleton, skin, and animation clips through Vite Pack. | `fbx` |
| FBX material mapping | **Build-time** | Maps StingrayPBS, Phong, Lambert, and fallback materials, projecting shininess into roughness. | `fbx` |
| Font MSDF bake | **Build-time** | `@forgeax/engine-font` bakes MSDF atlases, glyph metrics, and sidecars from TTF through the import pipeline; there is no dedicated CLI command. Runtime has no font-tool dependency. | `font` |
| Lightmap UV validation | **Build-time** | `validateLightmapUvs` checks the lightmap UV set (`uv1` by default) on every LOD for presence, finite `[0,1]` range, and non-overlapping charts, then selects shared LOD0 or per-LOD storage with a `lod-lightmap-uv-mismatch` diagnostic. | `import` · `render` |
| Font runtime load | **Built-in** | Font defines assets/import; AssetRegistry recursively loads atlas/sampler; runtime glyph-layout systems generate text meshes. graphics-extras provides only pure layout/bake helpers. | `font` · `assets-runtime` · `runtime` |
| Audio asset load | **Built-in** | GUID loading returns realm-neutral AudioClipAsset bytes/sourceKey or a validated PCM16 stream index/locator. Host Web Audio owns actual decoding/playback. | `audio` · `assets-runtime` |
| Particle-effect asset | **Built-in** | Pack v2 stores cooked VFX programs/metadata. After AssetRegistry `loadByGuid` returns payloads, consumers create shared handles for VFX players/GPU renderers. | `pack` · `assets-runtime` · `vfx` · `vfx-render` |

---

## AI tools, inspection, and delivery

### CLI, Tool Runtime, and Preview

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| `forgeax` CLI front door | **Development** | Unified command tree, progressive `help`, strict schema validation, and terminals; SDK clients reuse these declarations without another operation registry. | `devkit` |
| Project lifecycle commands | **Development** | Provides SDK init, new, project init, doctor, test, typecheck, dev, build, package, serve, and preview, explicitly routing project/host/engine owners. | `devkit` |
| Unified live game iteration | **Development** | A `dev` session reuses one live game owner for find/focus/camera/capture. `camera release` restores the authored camera after temporary lens/exposure observation. Detached projects use actual OS-assigned loopback URLs without taking default port `5173`. | `devkit` · `app` |
| Bounded asset discovery and verification | **Development** | `asset list` returns imported assets and Pack sources/outputs with `limit`/opaque cursors, including producer `sourceKey` when present. `asset verify` returns bounded `asset-verification-v1` source/output/producer reports; malformed pack indexes fail closed, not as successful empty pages. The cursor is an integer offset. | `devkit` · `pack` · `assets-runtime` |
| Browser compositor capture | **Development** | `forgeax dev capture` uses the real browser compositor, Engine frame signals, canvas witnesses, and page screenshots in hardware/software lanes; it is not release or physical-GPU performance acceptance. | `devkit` |
| Borrowed browser Page capture | **Development** | DevKit supplies one Page/canvas carrier, compositor capture, input, and identity/page-loss cleanup. Cross-repository integration and physical-GPU acceptance remain outside Engine. | `devkit` |
| Persistent playthrough capture | **Development** | `a Node or Bun script using the SDK command client` reuses one browser session for input, assertions, and repeated compositor captures, returning JSON-safe results and a run manifest. | `devkit` |
| Single-HTML offline delivery | **Development** | `forgeax project package --format single-html` embeds the verified dist manifest's module/worker/WASM/resource closure into a single-file candidate verifiable over `file://`; arbitrary network services are not offline packages. | `devkit` |
| Asset authoring commands | **Development** | `asset import` creates/reuses image and glTF sidecars; verify/inspect/list scan and query. It does not author arbitrary asset kinds. | `devkit` |
| Asset/format producers | **Build-time** | `forgeax asset` invokes plugin scan/lookup/verify/atlas, glTF import, and font bake, feeding the existing Meta/Pack/Catalog chain. | `pack` · `gltf` · `font` |
| Shader check | **Build-time** | Runs the project build with the named `.wgsl` file as an extra entry, so a shader no module imports is still compiled; invalid WGSL fails with `shader-check-failed` naming the file. It never compiles or repairs WGSL in a live renderer. | `devkit` · `shader-compiler` |
| Plugin asset authoring | **Development** | Create/inspect PluginAssets, select project roots, and transfer/clone author closures. Code/configuration updates rebuild sessions after candidate compilation. | `devkit` · `plugin` |
| Resident Host Pack selection | **Development** | `backend start --host-pack` selects one installed Host PluginAsset without copying it into the game or changing `forge.json`; the resident backend reports the immutable selection and rejects an in-place change until stopped. | `devkit` · `plugin` |
| Realm dispatch | **Development** | Dispatches operations to project/host/engine/build owners; missing capabilities fail structurally. | `devkit` |
| ToolContribution | **Built-in** | Realm-neutral descriptor/executor/snapshot/artifact/terminal contracts without filesystem, renderer, or Editor policy. | `tool-runtime` |
| Bound Preview host | **Built-in** | `bindPreviewHost(plugin, host)` wraps a preview plugin so the `preview.host` capability is provided in the same Cordis context before the plugin applies; DevKit preview tools use it. There is no generic `bindToolPlugin` binder. | `preview` · `devkit` |
| Lexical ToolRun terminal | **Built-in** | Terminals carry artifact/snapshot/cleanup reports; live handles, canvases, and Fibers must not leak. | `tool-runtime` |
| Optional tool service contract | **Opt-in** | Admission validates descriptors, recipes, backend, correctness, thresholds, and cleanup. No services are currently admitted; private executors remain the default. | `tool-runtime` · `devkit` |
| Project preview | **Development** | Produces evidence through real project/build/renderer closure rather than static thumbnails. | `devkit` · `preview` |
| Engine workspace provider | **Development** | Providers open projects in workspace sessions. Engine owns App/World/AssetRegistry, headed targets, input, capture, source identity, and supported typed previews, without guessing project loaders or creating another runtime. | `app` · `devkit` · `host` |
| Workspace selection outline | **Development** | `engineWorkspaceTargetTools.highlight({ entityId })` projects the selected entity and its descendants into the active camera `Outline` (width 4 when unauthored); clearing removes only the members it added. | `app` · `render` |
| Current-project Editor Play | **Development** | The `play.start` workspace tool starts a distinct game session from the current project root on the resident BackendHost, leaving the editing World intact; fixed-input snapshots remain an explicit independent CLI path. | `app` · `devkit` |
| Cached asset thumbnails | **Development** | Asynchronous progressive 128px transparent previews reuse one retained App/Renderer and ordinary Preview presentations. Integrity-checked DDC entries are keyed by the subject dependency closure, preset and producer bytes; cache hits launch no browser. | `preview` · `devkit` · `ddc` |
| Material preview | **Development** | Loads MaterialAsset by GUID and produces subject-bound capture/reports; failures recover through asset readiness. | `preview` |
| Mesh preview | **Development** | Displays meshes through unified AssetRegistry/Renderer without a separate preview loader. | `preview` |
| Texture preview | **Development** | Reads textures by GUID and produces evidence without bypassing Catalog/Pack identity. | `preview` |
| VFX preview | **Development** | Loads cooked effects, runs real GPU VFX hosts, and produces evidence; missing capabilities yield structured refusal. | `preview` · `vfx-render` |
| Preview lexical session | **Development** | `withSession` owns bindings, frames, capture, disposal, and live-resource census. | `preview` |
| Preview evidence artifacts | **Development** | Reports can carry RHI tapes, PNGs, and profile-capture references bound to subject/revision. | `preview` |

### Profiler, Remote, and RHI Debug

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| GPU pass timing | **Development** | Renderer opts in with `gpuPassTiming`; `observe(..., { include: ['timings'] })` on draw receipts returns bounded pass facts with `complete`/`partial`/`unavailable`/`failed` status. This is not frame latency and does not fabricate ticks. | `render` · `render-graph` · `rhi` |
| Bounded CPU Profiler | **Development** | Records App/Render phases, allocations, overflow, and completeness within frame/event limits; does not own GPU timestamps. | `profiler` |
| GPU-driven prepare profiling | **Development** | At `passes` detail the renderer records `record/gpu-driven-prepare` under `record`, with plan/filter/shadow-views children. | `render` · `profiler` |
| Profile validation/model | **Development** | Validates versioned captures and builds deterministic phase/frame summaries without modifying artifacts. | `profiler` |
| Profile comparison | **Development** | Produces phase unions and side summaries for two validated captures without live reconnection. | `profiler` |
| Profiler CLI | **Development** | Provides offline summary, frame, phase, and compare queries. | `profiler` |
| Live Engine eval | **Development** | `eval(script)` directly accesses live World/Renderer/Assets and optional diagnostics; it is neither sandboxed nor read-only. | `remote` |
| Remote introspection | **Development** | `introspect` returns an OpenRPC L2 subset, roots, and injected component schemas without a remote-owned registry. | `remote` |
| In-process Remote | **Development** | Evaluates directly within Host with no network transport, sharing the WebSocket execution core. | `remote` |
| Node WebSocket JSON-RPC | **Development** | Node/Dawn hosts can expose eval/introspect on 5732; disabled by default in production. | `remote` |
| Browser loopback relay | **Development** | Browsers connect outbound to relay 5733 so scripts execute in the page realm. Browsers do not pretend to be WebSocket servers. | `remote` |
| Remote full-access boundary | **Development** | Eval can mutate/destroy live state. The security boundary is whether Host starts the entrypoint, not a method blacklist. | `remote` |
| RHI frame tape | **Development** | `attachRecorder` must be installed before resource creation to capture commands, initial resource data, and lifecycles in self-contained tapes. Arbitrary mid-session takeover can produce handle-graph-broken; render-bundle commands are captured too. | `rhi-debug` |
| Deterministic RHI replay | **Development** | Replays tapes on fresh devices, rejecting unreproducible input through capability/format gates. | `rhi-debug` |
| Per-draw inspect | **Development** | Expands pipeline state, bindings, draw calls, and render-target PNGs to diagnose black screens, wrong textures, and bindings. | `rhi-debug` |
| RHI debug viewer | **Development** | Ordinary mode replays/inspects tapes; paired-result mode consumes existing differential results without recapturing, pairing, or computing a second answer. | `rhi-debug` · `apps/rhi-debug-viewer` |
| Vite RHI-debug routes | **Development** | Injects tape/trigger/artifact dev routes and build defines; production can tree-shake capture machinery. | `vite-plugin-rhi-debug` |
| Immediate-mode Debug Draw | **Development** | CPU-staged line, sphere, AABB, frustum, arrow, and axes wireframe overlays without Scene assets/entities. | `debug-draw` |
| Screen-to-entity picking | **Built-in** | Camera rays select the nearest renderable AABB with perspective/orthographic support; World remains unchanged. | `picking` |
| Vertex-level picking | **Built-in** | Returns VertexHit on triangle-list meshes. Skinned world positions remain rest-pose queries; gameplay owns interaction policy. | `picking` |
| Exact triangle picking | **Built-in** | `pickTriangle` resolves nearest hits/occlusion for static triangle lists, returning barycentrics, triangle index, and optional instance index/GUID. Unobservable CPU geometry, current skinned pose, or instance data returns explicit `unavailable`; World/AssetRegistry stays unchanged. | `picking` |
| Tile-cell picking | **Built-in** | Returns the topmost tile cell from a world ray and tile layer without adding tile editing to Renderer. | `picking` |

### SDK and repository delivery

| Feature | Form | Behavior and boundary | Primary owner |
|:--|:-:|:--|:--|
| SDK archive build | **Build-time** | Assembles built packages/CLI/game closure, clean source snapshot, prebuilt WASM, manifest, digests, and provenance. | Engine root scripts |
| SDK source mode | **Build-time** | `.forgeax-public-distribution` checkouts support TypeScript edits and `build:engine` without private asset submodules; this is not a player runtime mode. | Engine root |
| SDK ZIP offline bootstrap | **Build-time** | SDK-root `init` prepares native side-effects caches in temporary projects; `new` creates external games from bare packages, templates, and an immutable pnpm store without repeating esbuild/Rapier/WASM postinstall. | `devkit` · Engine root scripts |
| SDK npm carrier bootstrap | **Build-time** | `@forgeax/engine-sdk` carries matching CLI, bare packages, templates, and skills but omits the offline store. init/new resolves exact lockfiles from public npm. | `devkit` · Engine root scripts |
| `game-3d` starter | **Development** | Explicit template selection creates a third-person daylight example with procedural meshes, skinned character, collisions, pointer-lock camera, UI, and Pack/Meta closure. It is an editable starting point, not a fixed scene for all games. | `templates/game-3d` · `devkit` |
| SDK agent onboarding | **Development** | init/new JSON/text output provides local AGENTS, the quick tour, capability catalog, and next commands. Games install ordinary skill files and rebuildable discovery links for supported coding agents. | `devkit` · `forgeax-engine-sdk` skill |
| SDK update discovery | **Development** | After successful `new`, bounded best-effort registry queries compare `@forgeax/engine-sdk` latest. Only strictly newer versions prompt; offline/failure never blocks. Existing games remain pinned and require explicit migration/tests. | `devkit` |
| Verified Candidate / Promotion | **Build-time** | Candidate builds/seals SDK ZIP, npm tarballs, and gate reports once. Promotion consumes those exact bytes and idempotently publishes npm/Release by integrity; quick/unverified releases are forbidden. | Engine root workflows/scripts |
| Concurrent focused npm publish | **Build-time** | Promotion publishes the focused `@forgeax/engine-*` packages concurrently, then waits for metadata, dist-tag, and tarball visibility before finalizing the Release. | Engine root workflows/scripts |
| Maintenance CLI | **Development** | `bun fx setup/update/clean/help` distinguishes contributor/public source modes and maintains Harness/submodule/build boundaries. | Engine root scripts |

---

## Not currently counted as delivered

> [!WARNING]
> This table is not a roadmap commitment. It explains why common capability names are absent from the delivered inventory above.

| Candidate capability | Current boundary |
|:--|:--|
| FogExp2 compatibility mode | The public owner is one `Fog` component with `heightFalloff`, without a separate FogExp2 component/mode. `heightFalloff = 0` provides uniform density. |
| Full atmospheric aerial perspective | Scene Fog attenuates scene radiance along real world-space rays with height awareness, but no separate atmospheric-scattering product owner couples it to analytic-atmosphere medium parameters. |
| Volumetric Clouds | No public component, asset, pipeline, and real-pixel chain currently exists. |
| Day/Night automation | Analytic Sky accepts explicit Atmosphere/Sun facts; Engine does not own time progression or celestial automation. |
| Astronomy | No celestial-position, calendar, or stellar system exists. Sun linkage does not imply astronomy. |
| Client prediction / rollback / lockstep | Net covers bytes/session/profile replication, not prediction, interpolation, rollback, lockstep, or ownership transfer. Reconnect/resync recovery is delivered by `NetSession`. |
| General-purpose Console sandbox | No tracked public `packages/console` source package exists. Remote provides full-access eval, not a security sandbox. |
| Public native Ray Query renderer | A private Rust `rhi-wgpu-native` spike and Tauri proof exist, but no public TypeScript native RHI/BLAS/TLAS product surface. |
| `GPUExternalTexture` video path | Video textures currently use external-image copy; a high-performance external-texture entrypoint is not yet a product capability. |
| Paired RHI differential | `rhi-debug` has no public baseline/comparison pair API; comparison is producer-owned inside replay tests. |
| Lightmap baker | Lightmap UV validation and bake fingerprints exist, but no baker produces lightmaps. |
| Runtime RenderPipeline swap | A custom pipeline is fixed at Renderer construction. |

---

## Maintenance rules

> [!TIP]
> Update the relevant row in the same change when adding, removing, or materially repurposing a public feature. Describe both behavior and ownership boundaries from current source, READMEs, and real gates; do not infer capabilities from old loop names or demo titles.

- [ ] Does each new feature have one owner/SSOT without compatibility layers or parallel stacks?
- [ ] Do runtime features have real package/export or end-to-end consumer evidence?
- [ ] Do rendering features distinguish structural smoke, real GPU execution, and pixel acceptance?
- [ ] Are build-time capabilities clearly separated from player runtime APIs?
- [ ] Are capability-gated, Host-owned, development, and test/experimental features labeled?
- [ ] Do asset descriptions preserve authoring → import/cook → DDC → Catalog → runtime load → inspection ownership?
- [ ] Does the generation baseline commit identify the Engine commit actually scanned?

### Selective surface direct lighting

`MeshRenderer.lightingChannels` and all four surface light schemas expose u32
intersection masks (default all, zero none). Standard Forward/Deferred, skin and
custom Surface programs consume the integer path. Casting remains independently
controlled by `ShadowParticipation`; GI, IBL and volume scattering retain their
policies. Contract: [Render lighting channels](../../../packages/render/README.md#surface-direct-light-channels).
