# hello-tonemap

> **Reinhard-extended tonemap opt-in exemplar** — the minimal end-to-end host that demonstrates the new `Camera.tonemap` / `Camera.exposure` / `Camera.whitePoint` trio. A single mid-grey PBR sphere lit by a 2x-overbright directional light: with the default `tonemap = 'none'` path the highlight burns to `(255, 255, 255)` integer white; with `tonemap = 'reinhard-extended'` the engine routes the geometry pass through an `rgba16float` HDR target and a fullscreen tonemap pass so the highlight stays in the displayable range without integer clipping.

## Run locally

```bash
pnpm --filter @forgeax/hello-tonemap dev      # vite dev server -> http://localhost:5173
pnpm --filter @forgeax/hello-tonemap build    # vite production build
pnpm --filter @forgeax/hello-tonemap smoke    # dawn-node 60-frame headless smoke
```

## Source roadmap

| Path | Purpose |
|:--|:--|
| `index.html` | `<canvas id="app">` host page |
| `src/main.ts` | Bootstrap + sphere + standard PBR material + Camera with the **tonemap trio fields** (`tonemap: TONEMAP_REINHARD_EXTENDED` / `exposure: 1.0` / `whitePoint: 8.0`) + intensity-2 DirectionalLight |
| `scripts/smoke-dawn.mjs` | dawn-node headless smoke. AC-07 (no `(255, 255, 255)` integer-white burn anywhere on frame) + AC-08 (highlight site readback in `(0.3, 1.0)` per channel) + AC-09 (reference PNG ε ≤ 0.05 on subsequent runs) |
| `vite.config.ts` | Mirror of `apps/hello/room/vite.config.ts`; `forgeaxShader()` injected so the production build carries the 3-entry shader manifest (pbr + unlit + tonemap) |

## What this demo proves

- **Opt-in via spawn-time field.** Adding `tonemap: TONEMAP_REINHARD_EXTENDED` to a `Camera` component turns the path on; nothing else changes at the AI-user surface.
- **Zero overhead when off.** The default `tonemap: 0` (`TONEMAP_NONE`) path leaves the geometry pass writing directly to the swap-chain — no HDR alloc, no extra fullscreen pass.
- **Highlights survive.** With intensity-2 light + a mid-grey sphere the unclipped luminance easily exceeds 1.0; the extended Reinhard knee at `whitePoint = 8.0` maps it back into `[0, 1]` without integer-white burn.

## Template boundary

This app remains the focused HDR/tonemap oracle. `templates/game-3d` already
owns the same public `Camera.tonemap` path in its authored target-range loop,
where bloom, FXAA, depth of field, transient post effects, lighting, gameplay,
reset, and render-evidence share one lifecycle. Copying this static sphere would
add a second camera/lighting scene without a new feature-loop concept.

The better first-game lesson is the existing template camera and its authored
emissive projectile: a future guided change should expose a meaningful
exposure/white-point setting through that same settings, evidence, and `R`
reset owners, then prove a gameplay-visible outcome. This oracle's intensity,
white-point, HDR readback, and reference PNG remain the regression boundary for
the renderer path.
