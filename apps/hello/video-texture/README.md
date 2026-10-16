# hello-video-texture

This demo puts a host-provided `HTMLVideoElement` through the engine's normal
texture slot and onto a world-space quad. The recipe is intentionally close to
a static image recipe:

```text
VideoAsset { url } -> loadByGuid -> VideoPlayer + MeshFilter + MeshRenderer
                         -> MaterialAsset.values.baseColorTexture
                         -> transient GPU video texture -> quad
```

The engine owns asset registration, extraction, and GPU upload. The host owns
the DOM video lifecycle through `VideoSourceProvider`; the engine never creates
an element or sets its `src`. The pinned `cutscene.webm` is served by the
`forgeax-engine-assets` submodule through `vite.config.ts`.

## Run

```bash
pnpm --filter @forgeax/video-texture dev
pnpm --filter @forgeax/video-texture typecheck
pnpm --filter @forgeax/video-texture build
pnpm --filter @forgeax/video-texture smoke
pnpm --filter @forgeax/video-texture smoke:browser
```

The browser smoke samples only the center of the canvas, where the quad is
drawn. It requires a non-black, non-uniform video frame and a measurable change
between time-separated captures. It then runs the same probes with
`?falsify=1`, which omits the provider; that control must fail at least one probe.
It also opens `?recovery=1` once and, on that same page, removes and restores
`VIDEO_SOURCE_PROVIDER_KEY` twice. The journey requires the last uploaded
video view and static sibling to remain stable during loss, exactly one
`video-upload-unsupported` diagnostic per loss episode, advancing uploads after
restore, stable World/Renderer/device/entity/material identities, and
idempotent renderer cleanup.

## What to inspect

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Host provider, GUID catalog, VideoPlayer entity, and render loop |
| `vite.config.ts` | Serves the pinned WebM from the asset submodule as `/cutscene.webm` |
| `scripts/smoke-dawn.mjs` | 60-frame structural AssetRegistry/extract/record gate without a DOM video |
| `scripts/smoke-browser.mjs` | WebGPU compositor pixel gate, missing-provider falsifier, and same-page recovery journey |
| `index.html` | Canvas and HUD host entry |

## Boundary and limitations

This is a focused media/upload oracle, not a cutscene system. It does not own
gameplay pause/resume, typed state transitions, input actions, audio routing,
authored scene delivery, or reset/re-entry. Those concerns belong to the
corresponding feature-loop owners in `templates/game-3d` and the
host-boundary `hello-video-cutscene` demo. Video pixels intentionally reuse the
`texture2d` material field; there is no second material abstraction.
