# 6.4 Transmission and refraction

This is the single learn-render carrier for Standard transmission/refraction.
It keeps the producer surface small: one `createApp` host, one renderer, one
scene, and one `Materials.standard` authoring path.

The five transmission cases are visible as `smooth`, `rough`, `color`, `thick`,
and `MASK`. A small regular Standard `BLEND` sphere overlaps the row so the
renderer contract is observable: transmission is resolved before the normal
transparent queue. No custom shader, second renderer, or backend-specific
branch belongs in this carrier.

## Hooks

- `window.__transmissionInspection` exposes the authored cases, queue contract,
  renderer count, backend, and observed frame pass names.
- `window.__captureTransmission()` advances the same World and draws through
  the same Renderer before returning RGBA pixels for the RHI-debug capture.

## Gates

```sh
pnpm --filter @forgeax/app-learn-render-6-pbr-4-transmission-refraction typecheck
pnpm --filter @forgeax/app-learn-render-6-pbr-4-transmission-refraction build
pnpm --filter @forgeax/app-learn-render-6-pbr-4-transmission-refraction smoke
pnpm --filter @forgeax/app-learn-render-6-pbr-4-transmission-refraction smoke:browser
```

The Dawn smoke delegates to the existing real engine contract at
`packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts`.
The browser smoke is local-only and reports `NOT-RUN` when no headed display is
available; that state is not treated as a successful GPU assertion.
