# All Scene Entity Details

This delivery supersedes the mesh-only entrance in
[Mesh Entity Inspector](2026-10-12-view-mesh-inspector-design.md). Engine is
read-only. Product code and design changes belong to View; no Engine package,
separate Harness data repository, or independent asset-page changes are required.

The Inspector-local relationship tree and its child-entity navigation were
superseded on 2026-10-13 by [UE-style Entity/Component Details](2026-10-13-view-inspector-component-tree-design.md).
The group model, entity classification and data-boundary decisions below remain
in force where the newer design does not replace them.

## Presentation and ownership

Every selected scene entity uses object title, projected functional components,
search, functional groups and collapsible details. The virtual Scene folder is not an
entity. The fixed group pool is Common, Object, Rendering, Physics, Animation,
Media, Effects, Behavior and All. Empty groups are hidden. The first populated
Common/Object group is selected by default; a custom-only object can use All.

The current entity's local Transform is shown when attached. Ordinary mesh
Common contains only Transform, Static Mesh and Materials; a scene instance
contains Transform and Scene Instance. Child components never classify a parent.
Functional groups preserve combined capabilities, regardless of the primary
type chosen for the title. All retains all supplied fields, including fields
returned without schema, derived GlobalTransform and unknown game components.

The original implementation placed `entity-classification` in Scene. The
[2026-10-13 component design](2026-10-13-view-inspector-component-tree-design.md)
supersedes that ownership: workspace-core now exports the pure component-name
helper with 28 overlapping configurations. Inspector and Scene Tree use that
existing foundation dependency, so the architecture gate again rejects all
sibling feature imports and keeps the helper free of imports and re-exports.

| Configuration | Engine component evidence | Functional detail |
|:--|:--|:--|
| Generic/custom | No primary match | Object and All |
| Scene instance | SceneInstance | Source handle, mapping, returned state |
| Mesh | MeshFilter/MeshRenderer | Mesh reference, material overrides |
| Skinned mesh | Skin | Mesh/material plus Animation skin/joints |
| Instanced mesh | Instances plus mesh component | Mesh/material plus instance collection |
| Camera | Camera/StereoCamera/CubeCamera | Projection; rendering exposure, antialiasing, bloom, output |
| Directional light | DirectionalLight | Color, intensity, direction, shadows |
| Point light | PointLight/PointLightShadow | Color, range, IES, shadow fields |
| Spot light | SpotLight | Cone angles, range, shadows |
| Area light | RectAreaLight | Width, height, intensity, references |
| Skylight | Skylight | Environment handle, color, intensity, rotation |
| Sky/environment | SkyboxBackground/Atmosphere/CloudLayer | Returned environment fields |
| Fog | Fog/VolumetricFog | Color/density and returned volume fields |
| Reflection/probes | ReflectionProbe/LightProbe/PlanarReflection | Bounds, plane, update intent, references |
| Post process | PostProcessParams/AO/DOF/SSR/MotionBlur and other known effects | Component/function folds |
| Physics | RigidBody/Collider/CharacterController/CollidingEntities | Existing physics fields |
| Animation | AnimationPlayer/MorphWeights/AnimationRootMotion/SplineIK/AnimationTargetId | References, arrays, playback facts |
| Audio | AudioSource/AudioListener/AcousticRegion | References, spatial/playback facts |
| Effects | ParticleEffectPlayer | Effect handle, playing, seed, time scale |
| Sprite | SpriteInstances/SpriteAnimation/SpriteRegionOverride | Sprite collections and animation |
| Tilemap | Tilemap/TileLayer | Returned map/layer fields |
| Text | GlyphText | Returned text/layout fields |
| Lines/points | Lines/Points | Geometry collections and style |
| Decal | ProjectedDecal | Material handle and projection fields |
| Terrain | Terrain | Terrain handle and LOD fields |
| Navigation/path | NavigationAgent/NavigationCharacter/Path/PathFollower/DesiredPathPose | Returned path/motion facts |
| NPC | NpcBrain | Soul, affordance, enabled, cognitive LOD |
| Video | VideoPlayer | Clip handle and playback facts |

Primary priority is camera, lights, mesh/visual objects, physics,
animation/media/effects/behavior, environment, scene instance, generic entity.
No component registry or Engine type hierarchy is introduced.

## Data and interaction

Only existing `entity.inspect`, focus and asset-open operations are used by the
Inspector. Scene Tree alone consumes `scene-tree.get` for parent/child
navigation. Public Engine inspection types are
imported by workspace-core through erased type imports. The Inspector never
reads World or writes components. Position and scale retain Engine coordinates
and units. Local `Transform.quat` is displayed as intrinsic XYZ degrees per
PR #161; tooltips and
copying preserve the original XYZW. Other numeric display uses compact
precision/scientific notation.

Enums use schema labels including zero. Other schema-fixed float vectors use XYZ/XYZW;
variable arrays, entity IDs, animation weights and shared-handle arrays use
collections. Engine's `items`/`fields`, `truncated`, `length` and `unavailable`
projections remain explicit. Large collections initially show 16 returned entries
and can reveal all returned entries; this never fetches or invents omitted data.
Readonly color swatches accompany original channel values.

The Inspector top card projects the selected entity and returned functional
components only. It does not consume parentId or represent component attachment
edges; the Scene Tree remains the single parent/child navigation surface.
Component clicks filter actual returned fields without selecting an entity.
Selection/target/project publication synchronously revokes pending inspection
reads. The
workspace's existing scene.select operation can retain an optional entityIds
presentation set. It validates the primary as before and highlights/inspects
only that primary; it adds no Engine operation or multi-object write behavior.

Resource references require an explicit returned GUID to open an existing
independent asset page. Handles stay handles. Zero material overrides indicate
inheritance; a standalone zero material handle is unbound. Declared material
slots, defaults, binding versions and unresolved resource identities remain
unavailable. No latest-Catalog or authored-source guessing is permitted.

## Verification

The results in this section apply to the 2026-10-12 Inspector with its local
relationship tree. The 2026-10-13 design supersedes that tree and its
parent/child-in-Inspector assertions; see the newer record for current
component-tree verification.

`test/entity-inspector.test.mjs` covers all 28 configurations, shared tree labels,
combined capabilities, scene roots, unknown/unschematized fields, missing
transform/name, enum zero, vectors versus arrays, explicit identity and truncation.
Selection tests cover multiple presentation IDs with only one Engine primary.
Architecture tests reject sibling implementations and a dependency-bearing
classification helper.

`scripts/verify-mesh-inspector-ui.mjs` uses explicitly labelled deterministic UI
responses. All 28 configurations pass at 320/480/640px in light/dark themes,
including searches, copying, folding, parent/child selection, capability
failure/recovery, target replacement and cancelled late responses. Screenshots
are under `/tmp/mesh-inspector-ui`. This is UI evidence, not Engine/GPU evidence.

The focused real Engine probe passes eight configurations: ordinary mesh,
scene instance, generic entity, camera, directional light, point light, skylight
and skybox. It cooks a disposable View-owned scene, queries actual schemas,
checks unnamed child/parent selection and keeps the exact Scene binding.
The captured scene has pixel contrast 87, with no page or capture errors.
Engine warned that the fixture skybox pass needs a tonemap; this proves its
inspection fields, not HDR skybox rendering. The other twenty configurations
have explicit UI fixture evidence, not real Engine feature-rendering acceptance.
Attempts to install additional native fixture schemas were rejected by the
installed Scene program inventory with `plugin-publication-mismatch`; no
Engine change or alternative World authority was introduced.

At the end of the 2026-10-12 native Brotato validation, the service opened
`scene/arena`. Its scene-instance root
uses two Common sections; Farm Floor uses three. Directional light, point light,
skylight, skybox and camera enter the same container with matching Scene Tree
types. Meta-clicking Floor then Sun retains two selections and identifies Sun
as the inspected primary. The Inspector's old hierarchy scroll area measured 180px.
The saved screenshot is `artifacts/entity-inspector-preview/brotato-scene-instance.png`;
the open browser remains on that root. The service entry is recorded locally in
`artifacts/entity-inspector-preview/entry.json` without publishing its headed
connection credentials. This screenshot and service record describe the previous
relationship-tree implementation, not the current component projection.

| Check | Actual local result |
|:--|:--|
| Full View tests | 450/452 pass; existing failures in cli.test.mjs:143 and workspace.test.mjs:918 also reproduced before this change |
| Changed Inspector package types | Pass |
| Product build | Pass via node scripts/build-tool.mjs |
| Architecture source gate | 15 packages, 312 source files, zero violations; counterexamples included in the View suite |
| UI probe | All 28 configurations, 320/480/640px, light/dark; long numeric text measured and visible |
| Real Engine probe | Eight configurations, read-only fields, local relationships, preserved generation and nonblank pixels |
| Native Brotato | Seven real entity configurations plus primary multi-selection verified in the final browser |
| Whitespace | git diff --check passes |
| Existing knowledge base lint | Zero errors/warnings, four informational orphan-tag notices; separate data repository unchanged |

The root strict type gate
still reports the installed Engine Pack declaration's missing listPackSources
export in the existing backend/product modules. Engine is not rebuilt to repair
that artifact. The four paired Engine browser shards were not run because their
preparation rebuilds Engine, outside the authorized repository scope. The
complete paired bootstrap/browser gate must not be claimed
from focused UI or Engine probes; the separate Harness repository is unchanged.

## References

UE's extensible Actor/Component model motivates organization rather than a
fixed number of UE classes: [Actors Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-actors-reference).
The 28 entries above are View presentation configurations, not mutually exclusive
Engine entity classes or a promise to expose data absent from Engine inspection.
