# Order-independent transparency

This focused demo shows weighted blended OIT selected by one Camera field,
`transparency: TRANSPARENCY_WEIGHTED_BLENDED`. Three translucent planes
interpenetrate at the origin, so no object order composites both halves
correctly. Press `T` to toggle between weighted blended OIT and the default
`sorted` path, and `O` to reverse the layer spawn order;
`renderer.inspect().transparency` reports the resolved mode and draw counts.

Run the deterministic checks from the repository root:

```sh
pnpm --filter @forgeax/hello-oit typecheck
pnpm build:app hello/oit
pnpm --filter @forgeax/hello-oit smoke
```

The Dawn smoke reads the linear-HDR observation at the cyclic probes after
60 frames. It requires the OIT result to match the documented weight
`clamp(10 / (1e-5 + (d/5)^2 + (d/200)^6), 0.01, 500)` composited over the
background within 0.05, to be identical across submission orders, and, as the
falsifier, requires the `sorted` path to differ by more than 0.1 between orders.
The shared scene and reference live in `scripts/oit-scene.mjs`.
