# Third-party source

| Source | Maintenance repository | Consumer |
|:--|:--|:--|
| `wgpu/` | Expanded `wgpu` source, based on `gfx-rs/wgpu` | `packages/rhi-wgpu-native` and `packages/wgpu-wasm` |
| `blitz/` | `ForgeaXGame/blitz`, based on DioxusLabs/Blitz | `packages/ui-blitz` |
| [Rapier/Parry source patches](../packages/physics-rapier3d/patches/) | Fixed official source revisions; no maintenance repository | `packages/physics-rapier3d` |

For wgpu, the Engine gitlink is the version authority. The current source retains the
upstream `v30.0.1` dependency graph and adds a macOS 26 Metal timestamp resolve
ordering repair, empty compute sampling and one-row texel-copy stride repair.
Windows DX12 also retains the byte-offset AABB correction, acceleration-structure
binding-array corrections, capability-gated SM 6.10 hit-vertex return and optional
Agility factory configuration. Texture tracking preserves the first child usage
when a parent first admits a subresource, independently of its final usage.
It does not include the draft Metal Ray Query fixes.
Browser and WeChat `wgpu-wasm` use the same pinned wgpu 30 source as native hosts.
Its WebGL repair preserves copies across index/non-index buffer roles with a bounded
CPU byte transfer where WebGL forbids direct `copyBufferSubData`. Same-role and
native copies retain the driver copy path. This is a buffer-copy fallback, not a
CPU mirror of rendering resources.
The same GLES source reads cubemap faces and mip levels through framebuffer
attachments. RHI snapshots must retain their actual bytes; unsupported copy
targets must not silently return a zero-filled staging buffer.
The GLSL writer supports load-only depth shaders and non-comparison depth globals
with ordinary samplers; independent comparison globals retain shadow samplers.
GLES supplies nearest depth/stencil texture defaults. Loading an image that also
requires comparison remains explicitly unsupported. RHI Debug uses this to read exact depth values without changing the
recorded scene's depth tests. GLES render bundles preserve the pass stencil reference
across pipeline binds and reset it on the next pass.
On WebGL contexts with `EXT_clip_control`, the same source preserves zero-to-one
clip depth and restores that native state at command-buffer boundaries. It keeps
the required Y flip; contexts without the extension retain the original depth
conversion. This avoids collapsing adjacent depth values during conversion.

## Maintained branches and pin durability

The standard `branch` fields in [`.gitmodules`](../.gitmodules) declare the remote
maintenance lines used by the pin-reachability gate. An absent field means
`main`. The gitlink remains the exact build version; a branch never floats a build.

| Source | Durable remote branch |
|:--|:--|
| Shared native/browser/WeChat wgpu | `main` |
| Portable Blitz UI | `forgeax-ui` |

These are long-lived maintenance lines: retain them without deletion or history
rewrites. Merge feature changes into the appropriate line before publishing an
Engine pin. View and assets retain their default `main` and paired-merge
requirement. Changing a maintenance declaration is a repository-contract change,
not a per-PR escape for an unmerged feature branch.

## Contributor checkout

Windows DX12 Ray Query qualification, scene images, raw readbacks and the
original failures live in the
Harness report.
Its manifest preserves the measured source HEAD/diff and SHA-256; historical
receipts do not qualify a later commit. The current `77828ea7` pin validates the
DX12 backend's actual legacy ResourceBarrier path under GBV. A deliberately
missing barrier still fails; enhanced-barrier support would require revisiting
this validation policy. It also initializes each overwritten MSAA resolve destination
in render-target state, preserving neighboring mip levels and array layers.
Final Native, Browser, Dawn, Smoke and PR CI qualification
remain separate from portable artifact loading and targeted resize controls.

Contributors need read access to the maintenance repository. Initialize the
Engine-selected revision with:

```sh
git submodule update --init -- third_party/wgpu
git submodule update --init -- third_party/blitz
```

Maintainers synchronize upstream and review changes in the maintenance repository,
then update the Engine gitlink and affected native/WASM Cargo lockfiles together.
Run native contracts, WASM/shader contracts and real GPU cases before accepting a
changed implementation. For a same-version source-only repair, lockfiles can remain
byte-identical when `--locked` checks of the consuming manifests validate the
unchanged graph.
Do not use a floating branch or `submodule update --remote` in builds.

Blitz's maintenance changes and regressions are documented in
[`blitz/FORGEAX.md`](blitz/FORGEAX.md). Its Engine-side Cargo lock, WASM binding,
native initializer and provenance are one publication owned by `ui-blitz`.

## SDK source

The SDK builder archives each gitlink's exact commit into
`source/engine/third_party/`, retaining upstream licenses. Each is an ordinary
source directory without Git metadata. SDK users need neither repository access
nor submodule initialization; rebuilding Rust still requires its toolchain and
ordinary registry dependencies. The manifest records the source commit in
`source.gitDependencies`, and its existing artifact inventory covers every file.

An uninitialized dependency is a build error. Only the explicit SDK source
allowlist is expanded; private binary assets remain excluded. Source archival
uses the committed revision, never a dirty submodule working tree.

Rapier/Parry rebuild and payload ownership are documented in the
[Rapier 3D backend](../packages/physics-rapier3d/README.md). Its source clones
are generated build scratch; Engine stores patches and the locked build recipe.
