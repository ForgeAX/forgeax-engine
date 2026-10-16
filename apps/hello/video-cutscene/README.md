# hello-video-cutscene

This demo is the smallest complete example of a host-owned video cutscene. It
keeps the engine loop and the media overlay as two explicit surfaces:

```text
running App/World -> C -> app.pause() + video.display=block
video.onended -> video.display=none + app.resume()
S -> stop the App and remove the overlay
```

The cube is an ordinary ECS entity (`Transform`, `MeshFilter`, and
`MeshRenderer`). The cutscene is a browser `<video>` element owned by the host
page, not an engine component. This boundary makes pause/resume timing,
overlay visibility, and cleanup easy to inspect without hiding DOM policy in
the renderer.

## Run

```bash
pnpm --filter @forgeax/hello-video-cutscene dev
pnpm --filter @forgeax/hello-video-cutscene typecheck
pnpm --filter @forgeax/hello-video-cutscene build
pnpm --filter @forgeax/hello-video-cutscene smoke
pnpm --filter @forgeax/hello-video-cutscene smoke:browser
```

Press `C` to play `cutscene.webm`. The app pauses while the video is visible,
then resumes when playback ends. Press `S` to stop the app; a stopped app cannot
be resumed, which is the host lifecycle contract exercised by the Dawn smoke.

## What to inspect

| Path | Purpose |
| --- | --- |
| `src/main.ts` | App bootstrap, ECS scene, host video lifecycle, and keyboard controls |
| `index.html` | Canvas plus the DOM overlay and its CSS stacking contract |
| `scripts/smoke-dawn.mjs` | Deterministic start/pause/resume/stop lifecycle gate |
| `scripts/smoke-browser.mjs` | Headless WebGPU + compositor screenshot gate |
| `screenshots/` | Before, during, and after cutscene visual evidence |
| `../../../../forgeax-engine-assets/demo-assets/hello-video-cutscene/cutscene.webm` | Pinned demo media source served by the pack asset submodule |

The browser smoke proves both that the overlay is visible and that its pixels
 differ from the canvas-only frame. It also proves the visible-to-hidden
transition after `video.onended`; a no-overlay edit must fail the visual gate.

## Boundary and limitations

This example intentionally uses a host DOM video instead of introducing a
video asset or renderer feature. It does not demonstrate audio bus routing,
authored scene import, or gameplay state transitions; those contracts belong to
the corresponding focused demos and to `templates/game-3d`.
