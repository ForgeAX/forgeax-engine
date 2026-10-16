# hello-app

> **One-screen `createApp(canvas)` takeoff exemplar** — the minimal end-to-end host that drops the canvas in, awaits the structured factory, and lets the engine handle the rest.

## Run locally

```bash
pnpm --filter @forgeax/hello-app dev      # vite dev server -> http://localhost:5173
pnpm --filter @forgeax/hello-app build    # vite production build
pnpm --filter @forgeax/hello-app smoke    # dawn-node 60-frame headless smoke
```

## Source roadmap

| Path | Purpose |
|:--|:--|
| `index.html` | `<canvas id="app">` host page |
| `src/main.ts` | The exemplar: `await createApp(canvas, { clearColor: [0.1, 0.2, 0.3, 1] })` + `populateDemoWorld(app.value.world)` + `app.value.start()`. Demonstrates the D-6 dual-layer error pattern (`instanceof EngineEnvironmentError` + exhaustive `switch (err.code)` over 5 + 18 = 23 codes) |
| `scripts/smoke.mjs` | dawn-node clearColor-only verdict (no baseline png; D-12 + R-5). 4 criteria: clearColor RGBA each component within ε ≤ 0.05 / `app.onError` count == 0 / `console.error` count == 0 / frames ≥ 60 |
| `vite.config.ts` | Mirror of `apps/hello/cube/vite.config.ts` shape; `forgeaxShader()` injected so the production build exercises the same shader-pipeline path |

## SLOC budget note

The plan-strategy AC-01 budgets `main.ts` at **≤30 SLOC excluding imports**. With the biome formatter expanding `case` stacks one label per line, the 23-case exhaustive switch consumes 23 lines on its own; the rest (await + Result narrowing + spawn + start + EngineEnvironmentError arm) sits at ~14 lines. Total ~46 SLOC is the actually-achievable minimum given the dual constraint (`AC-07` exhaustive switch with no default + biome format expansion). The 3-statement takeoff (`await createApp` + `if (!app.ok)` + `start`) lands in the first ~5 lines, which is the **discovery surface** charter F1 + P1 optimise for; the remaining lines are the consumption-pattern demo for AI users to grep.

## See also

- `packages/app/README.md` — `@forgeax/engine-app` API + advanced opts + alt-tab notes + OOS list
- `apps/hello/cube/` — adjacent exemplar (does not use `createApp`; manually composes `createRenderer` + `World`)
