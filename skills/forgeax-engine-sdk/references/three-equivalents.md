# Three.js to ForgeaX rendering equivalents

Native equivalents for the Three.js core features games use. Look the effect up here
before simplifying it or building it from boxes. Imports: `@forgeax/engine/render` unless
noted, geometry from `@forgeax/engine/geometry`. Signatures are in
[api-index.md](api-index.md); recipes in [gameplay-cookbook.md](gameplay-cookbook.md).

## Renderer, camera and post-processing

- `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure` -> `Camera { tonemap: TONEMAP_ACES_FILMIC, exposure }`.
- `antialias: true` -> `Camera.antialias = ANTIALIAS_MSAA` (or `ANTIALIAS_FXAA`, `ANTIALIAS_TAA`, `ANTIALIAS_SMAA`).
- `scene.background = color` -> `GradientSky { zenith: c, horizon: c, ground: c, sunSize: 0 }` with linear `c` (`color.fromHex(color.create(), hex).subarray(0, 3)` from `@forgeax/engine/math`); it shows as set, while an opaque `Camera.clearColor` is tone-mapped.
- Gradient sky dome (`BackSide` sphere + `ShaderMaterial` mixing `bottomColor` / `topColor` by `pow(h, exponent)`) -> `GradientSky { zenith: top, horizon: bottom, ground, exponent }`; no mesh, presets in cookbook 0.
- `Sky` addon (`sunPosition`, turbidity, rayleigh) -> `GradientSky` with a `DirectionalLight` for a stylised sun disc and glow, or physical `Atmosphere` + one `DirectionalLight`.
- `scene.background = cubeTexture | equirect` -> `SkyboxBackground { equirect }` (float equirect, tone mapping on).
- `PerspectiveCamera(fovDeg)` / `OrthographicCamera` -> `perspective({ fov })` with `fov` in radians / `orthographic({ left, right, bottom, top, near, far })`.
- `EffectComposer` + `UnrealBloomPass(strength, radius, threshold)` + `OutputPass` -> `Camera { bloom: BLOOM_ENABLED, bloomIntensity, bloomRadius, bloomThreshold }` (defaults 0.5 / 0 / 1); no pass chain.
- `SSAOPass` / `GTAOPass` -> `AmbientOcclusion` on the camera entity.
- `BokehPass` -> `DepthOfField { focusDistance, fStop }` on the camera entity.
- `OutlinePass(selectedObjects)` -> `Outline { entities, visibleColor, hiddenColor, width }` on the camera entity.
- Vignette / film grain / chromatic aberration `ShaderPass` -> `LensEffects` on the camera entity.

## Lights and shadows

- `HemisphereLight(sky, ground, I)` / `AmbientLight(c, I)` -> `Skylight { color: sky, groundColor: ground, intensity: I / Math.PI }`.
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
- `vertexColors` -> a `color` attribute on the `MeshAsset` (applied when present).
- `ShaderMaterial` (fragment, `uTime`) -> `Materials.standard({ surfaceModule })` WGSL `evaluate_surface`, `input.frameTime` (cookbook 9).
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
- Particle loop (`position.needsUpdate`) -> `assets.writeRange(mesh, [{ attribute: 'position', first: 0, values }, ...])` each frame; cookbook 12 has rain, snow, sparks, bubbles, dust, fire, smoke and magic.
- `InstancedMesh` + `setMatrixAt` -> `Instances { transforms }` (packed mat4s) beside `MeshFilter` / `MeshRenderer`; move one with `world.setArrayRange(entity, Instances, 'transforms', index * 16, matrix)`.
- `Reflector` (planar mirror) -> `PlanarReflection { target, normal, distance }` on the display camera, with a `target` from `renderer.createRenderTarget` (render README "Planar reflection capture"); `ScreenSpaceReflection` on the camera for Deferred.
- `LOD` -> `MeshAsset.lods`.

## Fog

- `Fog(color, near, far)` -> `Fog { color, mode: FogModeValue.linear, near, far }`.
- `FogExp2(color, density)` -> `Fog { color, mode: FogModeValue.exp2, density }`; both use view depth, so values transfer.
- `color` is scene-linear and may exceed 1. With a `GradientSky` the fog also covers the sky at and below the horizon (`fogBlend`), like Three's `scene.background = fogColor` without the seam.

## Not yet supported

Do not search for these; use the workaround.

- A second `DirectionalLight`: extra ones are dropped. Use a `PointLight` / `SpotLight` rim or `Skylight.groundColor`.
- Camera-facing `Sprite`: rotate an unlit quad toward the camera each frame.
- Per-vertex colour on `Lines`; per-instance colour (`InstancedMesh.setColorAt`): one material per colour group.
- `MeshPhongMaterial`, `MeshToonMaterial`: `Materials.standard` with high or low roughness.
- Per-material `fog: false` and `toneMapped: false`: fog and tone mapping are per camera.
- Vertex displacement in a `Surface` shader (`onBeforeCompile` wind or waves): animate vertices with `assets.writeRange`.
- `RoundedBoxGeometry`, `BufferGeometryUtils.mergeGeometries`: `createExtrusionGeometry` with `bevelSize`; `createMeshBuilder` submeshes.
