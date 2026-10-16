# `@forgeax/engine-preview`

This focused package owns the Engine preview substrate. It provides one lexical
`previewHost.withSession()` boundary and typed binding, frame, capture, and dispose
actions. It does not own Project writes, ToolRun execution, a catalog, or an
Editor session.

## Minimal host contract

```ts
const host = createPreviewHost(adapter);
const terminal = await host.withSession(
  {
    subject: { kind: 'mesh', guid: 'mesh:fixture' },
    snapshot: { revision: 3, digest: 'sha256:project' },
  },
  async (session) => {
    const binding = await session.loadAsset('mesh:fixture');
    await session.frame({ frame: 0, deltaSeconds: 0 });
    return { binding, capture: await session.capture() };
  },
);
```

The callback receives only POD binding and presentation actions. World, Renderer,
Canvas, GPU, and ToolRun handles remain inside the adapter. `withSession` always
disposes the lexical lease and returns a cleanup census. A non-zero `worlds`,
`renderers`, `canvases`, or `leases` count throws `PreviewCleanupError` with the
stable `preview-cleanup-live-resources` code.

## AI disclosure order

1. `list` exposes a domain descriptor and its physical realm.
2. `describe` expands the selector, `SnapshotRef`, result schema, required evidence,
   and structured errors.
3. `run` accepts JSON subject and snapshot values only.
4. The terminal carries the subject report, `ArtifactRef` values, and the cleanup
   census. A live resource or carrier handle is never portable evidence.

## Canonical domain contributions

M2 adds four peer contributions. Each request carries a `ToolSubjectRef`, a
revisioned `SnapshotRef`, and a domain binding; each terminal returns a
subject-bound report plus `rhi-tape`, `png`, and `profile-capture` artifacts.

| Descriptor | Subject | Presentation oracle | Domain falsifier |
| --- | --- | --- | --- |
| `asset.material.preview` | `MaterialAsset` | Fixed studio sphere and lighting | Fallback sphere, disconnected program, or background-only capture |
| `asset.mesh.preview` | `MeshAsset` | All submeshes with source AABB framing | Partial buffers or inverted framing |
| `asset.vfx.preview` | `ParticleEffectAsset` | Fixed seed, delta, and bounded compute/draw timeline | Stale seed/delta or missing compute/draw output |
| `asset.texture.preview` | `TextureAsset` | Aspect-correct quad and alpha checker | Replacement texture, format/color-space drift, or wrong aspect |

> [!IMPORTANT]
> `asset.preview`, `preview.run`, and `preview.analyze` are not part of
> the default discoverable catalog. The old generic proof helpers remain
> private implementation utilities until their consumers are retired.

```mermaid
flowchart LR
  A["list"] --> B["describe domain descriptor"]
  B --> C["run subject + snapshot JSON"]
  C --> D["domain report + PNG/RHI/Profile artifacts"]
  D --> E["cleanup census is zero"]
```

The domain files are deliberately separate so each subject can reject its own
fallback and binding substitutions. They share only the lexical host helpers;
they do not create a second registry, executor, World, Renderer, or authoring
session.

The canonical environment's `sky.hdr` and `cook-receipt.json` are generated
together by the Preview producer. Engine builds publish the complete staged kit,
including its Meta, after both fresh builds and package cache hits. Public SDK
source builds use the packaged source or the producer's neutral HDR fallback;
each carries a receipt for its actual bytes. DevKit rejects source or Meta bytes
that disagree with that receipt before project build or development startup.

Resource domain execution consumes the mechanisms from one PreviewHost session. Material and Mesh read readiness from that session's Renderer, as Texture and VFX do; callers do not supply a second readiness projection. All four subject kinds share GUID loading and owner-failure projection before their own inspection and render oracle.
