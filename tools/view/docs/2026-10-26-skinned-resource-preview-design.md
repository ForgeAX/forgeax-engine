# Skinned resource previews

Implementation: [Engine PR #4731](https://github.com/ForgeaX-Games/forgeax-engine/pull/4731),
with the native contract introduced in Engine commit
`94b4eef8f7a1826245d3846063d96b15796705ac`.
The paired View delivery is PR #239.

Mesh and Material previews must render assets using their declared skinned
material programs. The ordinary Scene already supplies authored Skin bindings;
resource previews and thumbnail batches require their own native input owner.

The Engine App preview Fiber creates an identity inverse-bind skeleton and
preview-local joints for Mesh assets. Joints follow the preview entity so the
original vertex positions remain in their rest pose. Material primitives use
one full-weight joint, including after geometry replacement and object rotation.
Wireframe temporarily removes the Skin binding and material mode restores it.
Native Fiber cleanup restores borrowed bindings and releases owned resources;
failed cleanup remains retryable.

DevKit mounts the same assembly for interactive previews and thumbnail batches.
No ToolApi arguments, asset formats, World authority or View runtime imports
change. Scene, Play and authored animation retain their existing owners. View
continues to consume exact target/generation and captured assetBinding facts.

Stock masked Forward fragments must retain the background behind discarded
texels. A seeded RHI replay established that the full lighting path could return
zero color after nested coverage rejection. Engine verifies positive-cutoff
stock coverage at the fragment entry. Custom surfaces and unmasked output are
outside that guard; positive fractional alpha-to-coverage remains intact.

The View evidence script checks Player and Steve meshes, six materials, four
primitive shapes, wireframe restoration, UV availability, close rejection and
eight native thumbnails. Opaque preview captures must retain the entire opaque
background, which detects holes that a nonempty-model check misses. See
`docs/evidence/2026-10-26-skinned-resource-preview/` for captured results and
the Engine App report for replay controls and validation limits.
