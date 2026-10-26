# Three.js to ForgeaX rendering equivalents

Native equivalents for the Three.js core features games use. Look the effect up here
before simplifying it or building it from boxes. Imports: `@forgeax/engine/render` unless
noted, geometry from `@forgeax/engine/geometry`. Signatures are in
[api-index.md](api-index.md); recipes: [effects-cookbook.md](effects-cookbook.md).

## Renderer, camera and post-processing

- `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure` -> `Camera { tonemap: TONEMAP_ACES_FILMIC, exposure }`.
- `antialias: true` -> `Camera.antialias = ANTIALIAS_MSAA` (or `ANTIALIAS_FXAA`, `ANTIALIAS_TAA`, `ANTIALIAS_SMAA`).
- `scene.background = color` -> `GradientSky { zenith: c, horizon: c, ground: c, sunSize: 0 }` with linear `c` (`color.linearRgb(0xRRGGBB | '#hex' | 'css')` from `@forgeax/engine/math`, Three's `Color.setHex`; component colour arrays are linear, never pass raw hex bytes); it shows as set, while an opaque `Camera.clearColor` is tone-mapped.
- Gradient sky dome (`BackSide` sphere + `ShaderMaterial` mixing `bottomColor` / `topColor` by `pow(h, exponent)`) -> `GradientSky { zenith: top, horizon: bottom, ground, exponent }`; no mesh. A three-colour dome (orange -> mauve -> navy by `smoothstep`) -> add `mid` and `midHeight` (elevation sine of the middle colour). Presets: `GradientSkyPresets.daylight / dusk / night / overcast`.
- `Sky` addon (`sunPosition`, turbidity, rayleigh) -> `GradientSky` with a `DirectionalLight` for a stylised sun disc and glow, or physical `Atmosphere` + one `DirectionalLight`.
- `scene.background = cubeTexture | equirect` -> `SkyboxBackground { equirect }` (float equirect, tone mapping on).
- `PerspectiveCamera(fovDeg)` / `OrthographicCamera` -> `perspective({ fov })` with `fov` in radians / `orthographic({ left, right, bottom, top, near, far })`.
- `EffectComposer` + `UnrealBloomPass(strength, radius, threshold)` + `OutputPass` -> `Camera { bloom: BLOOM_ENABLED, bloomIntensity, bloomRadius, bloomThreshold }` (defaults 0.5 / 0 / 1); no pass chain.
- `SSAOPass` / `GTAOPass` -> `AmbientOcclusion` on the camera entity.
- `BokehPass` -> `DepthOfField { focusDistance, fStop }` on the camera entity.
- `OutlinePass(selectedObjects)` -> `Outline { entities, visibleColor, hiddenColor, width }` on the camera entity.
- Vignette / film grain / chromatic aberration `ShaderPass` -> `LensEffects` on the camera entity.

## Lights and shadows

- `HemisphereLight(sky, ground, I)` / `AmbientLight(c, I)` -> `Skylight { color: sky, groundColor: ground, intensity: I / Math.PI }`; the sky colour also fills shadows, `groundColor` lights downward faces only.
- `DirectionalLight` (position -> target) -> `DirectionalLight { direction: target - position, intensity }` in lux; one per World.
- `PointLight` / `SpotLight` -> `PointLight { color, intensity, range }` / `SpotLight { direction, innerConeDeg, outerConeDeg, range }`; intensity in candela, cone angles are half-angles in degrees.
- `renderer.shadowMap.enabled`, `light.castShadow` -> `castShadow: true` on the light; per mesh `ShadowParticipation { cast, receive }`.
- `PCFSoftShadowMap` -> `DirectionalLight.shadowFilter = DirectionalShadowFilterValue.pcfSoft` (contact-hardening soft shadows: `.pcssMedium`).

## Materials

- `MeshBasicMaterial` -> `Materials.unlit(rgba)`.
- `MeshStandardMaterial` -> `Materials.standard({ baseColor, metallic, roughness, emissive, emissiveIntensity })`.
- `MeshLambertMaterial` -> `Materials.lambert({ baseColor })`.
- `MeshPhysicalMaterial` clearcoat / transmission / ior -> the same fields on `Materials.standard` (material skill).
- `flatShading: true` -> `Materials.standard({ flatShading: true })` or `Materials.lambert({ flatShading: true })`.
- `transparent: true`, `opacity` -> `baseColor` alpha + `renderState: { blend, depthWriteEnabled: false }` + `queue: RenderQueue.Transparent`.
- `blending: AdditiveBlending` -> `renderState.blend` with `srcFactor: 'one', dstFactor: 'one'` (api-index gotcha).
- `side: DoubleSide` / `BackSide` -> `renderState.cullMode: 'none'` / `'front'`.
- `depthTest: false` -> `renderState.depthCompare: 'always'`; comparisons use Three's forward sense, Reverse-Z is internal.
- `geometry.setAttribute('color', ...)` + `vertexColors` -> `withVertexColors(mesh, rgbOrRgbaFloat32, { space: 'linear' | 'srgb' })` from `@forgeax/engine/geometry`; it repacks `vertices` (setting `attributes.color` alone fails to pack). Three's colour attribute is linear, so the default is linear; pass `space: 'srgb'` for hex-derived values.
- `ShaderMaterial` (fragment, `uTime`) -> `Materials.standard({ surfaceModule })` WGSL `evaluate_surface`, `input.frameTime` (effects/water-shader.md).
- `ShaderMaterial` reading a directional light uniform (`sunDirection`, `sunColor`) for a reflection -> a Surface gets no sun or sky; the lighting is the material model's. For water use the stock `model: 'single-layer-medium'`.
- `scene.environment` from a PMREM of `Sky` / `scene.background` (sky-tinted reflections on stock PBR) -> already available through `Atmosphere`, which feeds reflections and sea colour. For a sky-coloured sea at dusk use a low sun, exposure about 1/2000 to 1/5000, ACES, a 100000-lux white sun and an untinted `Skylight {}`. A `GradientSky` does not drive stock Standard reflections (proposal only); the stock water medium does reflect it.
- `examples/jsm/objects/Water` / `Water2` (sky-mirroring ocean with `sunDirection`, `sunColor`, `distortionScale`) -> the stock `model: 'single-layer-medium'` material: main-light sun glint, `GradientSky` reflection, own fog, absorption and refraction (render README "Sea sun and sky"). It draws without a `dynamicInput` page (declare it only if the Surface reads per-frame events, then publish with `setSurfaceDynamicInput` every frame or startup fails with `material-resource-missing`). No vertex displacement (Three's `Water` has none either). Keep the wave normal strength modest (about 1, relative to a unit normal perturbation): a gain of 5 aliases into a checker/moire pattern toward the horizon; if you must go stronger, damp it with distance.
- Light pillar (`CylinderGeometry(rTop, rBottom, h, 32, 1, true)` + additive `ShaderMaterial` fading with `vUv.y`) -> the same open cylinder from `createCylinderGeometry` + a `surfaceModule` fading with `positionOS.y` (not `uv0.y`: `createCylinderGeometry` has V=0 at the top, WebGPU convention, the reverse of Three's `vUv.y`), additive with alpha `zero / one` (effects/beam-pillar.md). Return `normalWS = input.viewDirectionWS` and occlusion `0.0` so Standard lighting adds nothing (otherwise the sun's Fresnel glare and the sky reflection make it solid white), and scale the display-referred Three colour to about `value^1.5` linear. A Three fade `1 - vUv.y` is `uv0.y` here (V=0 at the top).
- `CanvasTexture(canvas)` -> `new CanvasTexture(canvas)`, then `Materials.unlit([1, 1, 1, 1], { baseColorTexture: { source: texture.source } })`; call `texture.update()` after drawing (render README "CanvasTexture").

## Geometry

- `BoxGeometry`, `SphereGeometry`, `CylinderGeometry`, `ConeGeometry`, `TorusGeometry`, `PlaneGeometry`, `CapsuleGeometry` -> `createBoxGeometry`, `createSphereGeometry`, ... same parameter order.
- `IcosahedronGeometry`, `DodecahedronGeometry`, `OctahedronGeometry`, `TetrahedronGeometry(radius, detail)` -> `createIcosahedronGeometry(radius, detail)` and siblings; flat at detail 0 like Three.
- `CircleGeometry(r)` / `RingGeometry(inner, outer)` -> `create2dGeometry({ kind: 'circle', radius })` / `create2dGeometry({ kind: 'annulus', innerRadius, outerRadius })`.
- `Shape` + `ExtrudeGeometry` -> `createExtrusionGeometry(contour, depth, { holes, bevelSize })`.
- `TubeGeometry(curve)` -> `createSweepGeometry(path, radius)` or `createProfileSweepGeometry(shape, path)`.
- `LatheGeometry(points)` -> `createRevolutionGeometry(profile)`.
- `EdgesGeometry` / `WireframeGeometry` -> `createEdgesGeometry(mesh, degrees)` / `createWireframeGeometry(mesh)`, drawn with `Lines`.
- `BufferGeometry` + `setAttribute` + `computeVertexNormals` -> `createMeshBuilder` (normals and tangents derived when omitted) + `assets.create`; per-frame edits with `assets.writeRange`.

## Objects, lines and points

- `Line` / `LineSegments` / `LineDashedMaterial` -> `MeshAsset` with `line-strip` / `line-list` topology + `Lines { width, widthUnits: LineWidthUnitsValue.world, dashSize, gapSize }` + `Materials.unlit`; widths can be world units (render README "Lines").
- `Points` + `PointsMaterial({ size })` -> `point-list` `MeshAsset` + `Points { size }` + `Materials.unlit`; size is in screen pixels.
- `sizeAttenuation: true` -> `sizeUnits: PointSizeUnitsValue.world`; `size` is then the world diameter (Three.js `size * tan(fov / 2)`).
- `vertexColors` -> the mesh `color` stream (linear RGBA; alpha fades a point); per-point size -> `uv1.x` scale.
- `map` (radial-gradient canvas glow) -> `shape: PointShapeValue.soft`, or the material's `baseColorTexture`, mapped across each sprite.
- `blending: AdditiveBlending, depthWrite: false` -> material `renderState: { depthWriteEnabled: false, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, ... } }`.
- Particle loop (`position.needsUpdate`) -> `assets.writeRange(mesh, [{ attribute: 'position', first: 0, values }, ...])` each frame; effects/particles-*.md cover rain, snow, sparks, bubbles, dust, fire, smoke, magic.
- `InstancedMesh` + `setMatrixAt` -> `Instances { transforms }` (packed mat4s) beside `MeshFilter` / `MeshRenderer`; move one with `world.setArrayRange(entity, Instances, 'transforms', index * 16, matrix)`.
- `Reflector` (planar mirror) -> `PlanarReflection { target, normal, distance }` on the display camera, with a `target` from `renderer.createRenderTarget` (render README "Planar reflection capture"); `ScreenSpaceReflection` on the camera for Deferred.
- `LOD` -> `MeshAsset.lods`.

## Fog

- `scene.fog = new Fog(color, near, far)` -> `Fog { color, mode: FogModeValue.linear, near, far }`; `scene.background = color` -> `GradientSky` (above) or a `Camera.clearColor`, and for a fogged look give both the same colour.
- `FogExp2(color, density)` -> `Fog { color, mode: FogModeValue.exp2, density }`; both use view depth, so values transfer.
- `color` is scene-linear and may exceed 1. With a `GradientSky` the fog also covers the sky at and below the horizon (`fogBlend`), like Three's `scene.background = fogColor` without the seam.

## Colour input and fog / tone mapping

- Colour fields (`array<f32, 3>`: GradientSky, Fog, Skylight, lights, `Atmosphere`) are linear, like Three's working space. Three hex -> `color.linearRgb(0xRRGGBB | '#hex' | 'css')`. Material `baseColor` / `emissive`: string or number is sRGB, tuple is linear (also Three's `Color` rule). A raw `ShaderMaterial` value stays as written, as does a WGSL uniform.
- Fog is analytic: opaque surfaces get it in one depth pass, translucent, unlit, Points and Lines fog themselves, so every built-in and Surface-composed material is fogged. Three applies fog after tone mapping, so the same hex looks lighter and greyer here: author a darker fog colour. Three `material.fog = false` -> `renderState: { fog: false }` (the Three layer maps it): forward draws, opaque and translucent, skip fog; deferred opaque still fogs.
- Tone mapping is one camera post pass, so all scene materials are tone mapped (Three `toneMapped: true`); only `GradientSky` (default `toneMapped: false`) is display-referred. There is no per-material `toneMapped: false`: keep additive glow peaks below about 0.2 (effects/beam-pillar.md).

## Not yet supported

Do not search for these; use the workaround.

- A second `DirectionalLight`: extra ones are dropped. Use a `PointLight` / `SpotLight` rim or `Skylight.groundColor`.
- Camera-facing `Sprite`: rotate an unlit quad toward the camera each frame.
- Per-vertex colour on `Lines`; per-instance colour (`InstancedMesh.setColorAt`): one material per colour group.
- `MeshPhongMaterial`, `MeshToonMaterial`: `Materials.standard` with high or low roughness.
- Per-material `toneMapped: false`: tone mapping is per camera.
- Vertex displacement in a `Surface` shader (`onBeforeCompile` wind or waves): animate vertices with `assets.writeRange`.
- `RoundedBoxGeometry`, `BufferGeometryUtils.mergeGeometries`: `createExtrusionGeometry` with `bevelSize`; `createMeshBuilder` submeshes.
