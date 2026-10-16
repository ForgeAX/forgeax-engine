# Demo Gallery

`@forgeax/demo-gallery` is a development host that discovers ForgeaX demos and
serves them through one Vite port. It does not maintain a demo allowlist.

## Discovery contract

A directory below `apps/` is a hosted demo when it contains all three of:

- `index.html`
- `package.json`
- a string `package.json#scripts.dev`

Discovery stops at the demo root, so nested asset and source directories are
not mistaken for separate demos. New demos that satisfy this contract appear
in `/demo-manifest.json` without a gallery change.

The top-level infrastructure directories `demo-gallery`, `shared`, `preview`,
and `rhi-debug-viewer` are excluded because they are hosts or tools rather than
embeddable demos. Generated, dependency, hidden, and DDC directories are also
excluded.

The gallery loads each discovered demo's Vite profile to adapt its Pack and
shader capabilities. A new plugin shape can therefore require one gallery
adapter, but adding another demo that uses an existing shape does not require a
catalog edit.

## Validation

```sh
pnpm --filter @forgeax/demo-gallery test
pnpm --filter @forgeax/demo-gallery scan
pnpm --filter @forgeax/demo-gallery dev
```

The gallery intentionally has no `build` script. A production build aggregates
the shader closure of every discovered demo and is a diagnostic, not part of
the normal app-build shard roster.
