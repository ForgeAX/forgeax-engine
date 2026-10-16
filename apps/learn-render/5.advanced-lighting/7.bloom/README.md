# Learn Render · 5.7 Bloom

This carrier demonstrates the same Camera-owned five-level HDR Bloom used by
the public `hello-bloom` example, with the LearnOpenGL light-box scene and
asset-backed browser/RHI-debug wiring.

> [!IMPORTANT]
> This example is contributor-checkout only because its source textures live
> in `forgeax-engine-assets/learn-opengl/textures`. Public SDK source mode must
> use [`apps/hello/bloom`](../../../hello/bloom/README.md), whose scene and
> shader inputs are self-contained.

## Consumer route

Game-facing code imports the public facade, not the physical package owner:

```ts
import {
  BLOOM_ENABLED,
  Camera,
  Materials,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';
```

The physical `@forgeax/engine-render` package remains the engine repository's
publication and ownership unit.

If either texture load fails, inspect the emitted record's `asset`, `code`,
`expected`, `hint`, and optional `detail`. Repair the producer-owned
`forgeax-engine-assets` GUID/publication/catalog path and retry the same load;
do not parse `Error.message`. In a public SDK source checkout, use the
self-contained [`hello-bloom`](../../../hello/bloom/README.md) carrier instead
of inventing a LearnOpenGL asset fallback.

## Run

From the engine repository:

```sh
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-7-bloom build
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-7-bloom smoke
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-7-bloom smoke:browser
```

The Dawn smoke runs 60 frames and checks the real ten-pass Bloom graph,
non-black HDR output, and structured error count. The browser smoke is an
additional visual/WebGPU path; it is not a replacement for the Dawn run.
Both commands require the asset submodule to be present and the normal
workspace dependencies to be installed. RHI-debug capture is enabled through
the shared Vite preset with `FORGEAX_ENGINE_RHI_DEBUG=1`.

## Evidence ownership

This asset-backed carrier owns the LearnOpenGL scene smoke and its RHI-debug
replay. It intentionally does not duplicate the public, self-contained
numeric and lifecycle probes. Run the complete visual/motion/performance
packet from the public fallback carrier:

```sh
pnpm --filter @forgeax/hello-bloom smoke:odd-dawn
pnpm --filter @forgeax/hello-bloom smoke:quality-dawn
pnpm --filter @forgeax/hello-bloom smoke:performance
pnpm --filter @forgeax/hello-bloom smoke:falsify
pnpm --filter @forgeax/hello-bloom smoke:browser-device-loss
pnpm --filter @forgeax/hello-bloom smoke:all
```

Those commands write the current-HEAD evidence under
`apps/hello/bloom/evidence/`: extraction/continuity, radial/DC/intensity/
alpha/odd-extent/motion, receipt-bound timing and native resource accounting,
expected-red falsification, browser visual readback, and GPU-process recovery.
The physical `@forgeax/engine-*` names that remain in this app's package
manifest are workspace ownership/dependency metadata; game-facing source uses
the public `@forgeax/engine/<facade>` imports shown above.
