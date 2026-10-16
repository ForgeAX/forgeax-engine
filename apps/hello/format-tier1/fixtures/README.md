# Morph source fixtures

These fixtures are source inputs, not synthetic runtime payloads.

| file | provenance | source hash | checked-in hash |
| --- | --- | --- | --- |
| `animated-morph-cube.gltf` | Khronos glTF Sample Assets `AnimatedMorphCube` (`CC0`); the checked-in file embeds the upstream `.bin`, keeps two morph targets, and reduces the animation to two auditable `weights` keyframes | `gltf`: `0b910ed4b52fd9fbb565911fc7f9f285edb0f30fa4913a93143466d439d1092e`; `bin`: `4aba93918adba56c1cc688a38c527bc647e26f2c386802e119b4d01b7250dd23` | `ecba02b3d2bf3b74fa1c1889e4d1bc7c7c50892157706a70044c23403550e8dd` |
| `multi-target-morph.fbx` | Hand-authored minimal ASCII FBX source using the public FBX Shape/BlendShape deformer structure; parsed by the pinned ufbx v0.23.0 WASM bridge; this fixture intentionally contains no animation stack | source text is the audit record | `23a43a5330b3fce133d295ef4e74f7df6e9fe0f2ff5986f71e4c0ea6ea9af448` |

The glTF upstream files are from:
`https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/AnimatedMorphCube/glTF`.

The FBX fixture must be passed through `parseFbxToObject()` / `fbxImporter`; tests must not replace it with a hand-built `FbxRawDocument`.

The checked-in FBX source has no animation clip. AC-08 therefore remains blocked for FBX; the glTF fixture is the real imported animation proof, and no FBX animation capability is claimed from this fixture.
