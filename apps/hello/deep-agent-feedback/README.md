<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# Deep Agent Feedback Focused Baseline

This project is M1's sole focused evidence carrier. It provides a discoverable Vite page, a nonuniform canvas, DOM UI, and browser, Dawn, capture and Pack-transform entries.

## Run

```bash
pnpm --filter @forgeax/hello-deep-agent-feedback typecheck
pnpm build:app hello/deep-agent-feedback
pnpm --filter @forgeax/hello-deep-agent-feedback smoke
pnpm --filter @forgeax/hello-deep-agent-feedback smoke:instances
pnpm --filter @forgeax/hello-deep-agent-feedback smoke:capture
```

The `fixture` query parameter lets later milestones reuse the same page without creating a second scene or frame-loop owner. Historical repeat/transform symptoms without a failing reproduction on the current baseline must be recorded as `unreproduced`.

`smoke:capture` is a thin wrapper around DevKit's single browser-compositor owner.
It runs `forgeax project capture --backend software --require-ui --deterministic`
in the current project and verifies the adjacent `*.json` report: nonuniform Canvas,
mounted DOM UI, frame number and zero page errors. Use `--project <dir>`, `--output <png>`
or `FORGEAX_CLI=<path>` for a fresh SDK-generated project. The script starts no second Vite, browser or frame loop.

`smoke:instances` reuses the real Dawn test from `hello-gltf-instancing`, placing
the entity origin outside the frustum and one local instance inside to verify
CPU-derived union visibility and per-instance GPU culling separately. It reports structural/rendering success only, not hardware FPS.

## Point-shadow recipe

`?fixture=point-shadow-recipe` installs `pointShadowPlugin()` through the same
page entry and adds `PointLight + PointLightShadow` to the existing caster/receiver
scene. It creates no second frame loop or scene owner. After each frame's
extraction/recording, `inspect().pointShadow` exposes atlas-admission facts.

```bash
pnpm --filter @forgeax/hello-deep-agent-feedback smoke:point-shadow
```

This smoke also runs the existing Chromium cube-array gate. The same production
`constructRuntimeRendererHost` completes at least 300 Dawn frames and verifies
six-face point-shadow passes, inspection and nonblack readback. Output fields
`browser`/`dawn`, `frames`, `passCount` and `inspection` carry evidence. Without
available WebGPU locally or in CI, retain `failed`/`not-run`; do not imply hardware
FPS. Structured falsification also covers exceeding `SHADOW_ATLAS_DEFAULT_LAYERS`,
missing `storageBuffer` and absence of shadow requests.
