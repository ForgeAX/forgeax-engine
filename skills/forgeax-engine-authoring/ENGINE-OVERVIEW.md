# Engine overview: capabilities and boundaries

Read this first, before planning a game (about five minutes). It says what the engine already
does, where to read the contract, and what it does not do. The full name list is the capability
catalog; signatures are in the API index; this page only routes and states limits.

Available is not enabled: a capability is used only when the game's `forge.json`, plugin
composition, components, assets or camera settings select it.

## What to use for what

| Game need | Engine capability | Read first |
|:--|:--|:--|
| Frame loop, input (keyboard, mouse, gamepad, pointer lock, action mapping), plugins, pause/resume | App host, `InputSnapshot`, Cordis plugins, `forge.json` roots | `forgeax-engine-app` |
| Entities, components, queries, Update / FixedUpdate, game states | ECS world, schedules, deferred commands, `StateToken` | `forgeax-engine-ecs`, `forgeax-engine-state` |
| Camera, sun and lights, shadows, sky, fog, HDR, tone mapping, bloom, AO, SSR, AA (MSAA/FXAA/SMAA/TAA), depth of field, motion blur, decals, reflections | Standard render pipeline, camera and light components, `Atmosphere` / `SkyboxBackground`, `Fog`, post effects on the camera entity | `forgeax-engine-render-pipeline` |
| Programmable volumetric clouds, wind-driven cloud shadows, sky and horizon blending | `VolumetricCloudLayer`, cooked `cloud-material` and `cloud-material-instance` | [Render Pipeline → Volumetric clouds](../forgeax-engine-render-pipeline/SKILL.md#volumetric-clouds) |
| Lakes with waves, surface queries, floating bodies | Water bodies and zones (`test-experimental`, explicit opt-in) | [Water](../forgeax-engine-render-pipeline/SKILL.md#water) |
| Materials, textures, custom surface shaders | `Materials.standard / unlit / lambert`, `surfaceModule` WGSL, shader variants | `forgeax-engine-material`, `forgeax-engine-shader` |
| Primitive and procedural meshes, extrude / sweep / revolve, editable hard-surface parts | `createBoxGeometry` and siblings, `createMeshBuilder`, `createExtrusionGeometry`, modeling kernel | `forgeax-engine-modeling` |
| glTF / FBX / textures / audio / fonts, GUID loading, packs | Importers, `*.pack.ts`, `AssetRegistry`, scene instantiation | `forgeax-engine-assets` |
| Skinning, animation clips, graphs, IK, morph targets | Animation and skin systems | `forgeax-engine-assets`, `forgeax-engine-app` |
| Rigid bodies, colliders, raycasts, character controller (`moveAndSlide`) | Rapier 2D / 3D physics | `forgeax-engine-physics` |
| Paths and navigation | Graph/grid navigation, static NavMesh, path following | `forgeax-engine-navigation` |
| Particles, sparks, fire, smoke, trails, ribbons, beams | CPU `Points`/`Lines` fields; GPU VFX (burst, billboard, mesh, ribbon, trail, beam) | `forgeax-engine-vfx` |
| BGM, SFX, 3D spatial audio, buses | `AudioSource`, `AudioListener`, host Web Audio backend | `forgeax-engine-audio` |
| Sprites, tilemaps, world-space text, video texture, UI | Sprite / Tilemap / MSDF Text / UiAsset | `forgeax-engine-app`, `forgeax-engine-assets` |
| Debug lines and shapes, picking | Immediate-mode Debug Draw, screen-to-entity and triangle picking | `forgeax-engine-debug-draw` |
| Black frame, wrong pixels, GPU problems | RHI frame tape, replay, per-draw inspect | `forgeax-engine-debug`, `forgeax-engine-rhi-debug` |
| Build, look-dev, play-test, release | `forgeax project build / check / play`, `dev look`, scripted playthrough | `forgeax-engine-cli` |

## Boundaries (do not build around these; use the workaround)

These come from the last audit. Before declaring something a gap, search the catalog and the API index once more.

- Only one `DirectionalLight` per World is honored; extra ones are dropped. Use a `PointLight` /
  `SpotLight` rim or `Skylight` ground colour.
- No camera-facing `Sprite` billboards in 3D by default: rotate an unlit quad toward the camera.
- No per-vertex colour on `Lines` and no per-instance colour on `Instances`: one material per colour.
- No Phong or Toon material: use `Materials.standard` with roughness and metallic.
- Tone mapping is per camera, not per material; there is no `toneMapped: false`.
- A surface shader cannot displace vertices: animate vertices with `assets.writeRange`.
- A surface shader receives no sun or sky of its own; lighting comes from the material model.
  For a standalone water-looking surface, use the stock `model: 'single-layer-medium'` material.
- Fog is applied analytically; Three's fog-after-tone-mapping makes the same hex look lighter,
  so author a darker fog colour.
- Pointer lock is taken on canvas click; a cursor-aimed game calls
  `gameHost.setPointerLockAllowed(false)` once.
- Import only `@forgeax/engine` or `@forgeax/engine/<package-directory>`; never reach into
  `node_modules` internals for APIs that the API index lists.

Entries marked experimental, development or build-time in the catalog are not part of the
default delivery path. When the task explicitly requests a Water experiment, use the opt-in
route above and verify it in the target browser.

## Do not rebuild these

Before hand-writing any of the following, look it up (API index, then the skill above):
camera rigs and follow cameras, input edge detection and key mapping, collision tests and
character movement, particle systems for rain / snow / sparks / fire / smoke, sky and sun,
fog and volumetric light shafts, water, bloom or other post effects, shadows, instancing,
procedural meshes (box, sphere, cylinder, extrude, sweep, revolve), animation blending, picking,
debug overlays, audio buses, state machines for menus and phases.
A confirmed gap is the only reason to hand-write one: record what the lookup found in
`docs/engine-plan.md` and `docs/feedback.md`.

## Deeper than this page

Open only what the plan needs: the owning skill's Quick contract, then its relevant heading.
Skills are references, so search them for a heading instead of reading them whole.
